import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createPrivateDirectory,
  createPrivateParents,
  validatePrivateOutput,
  writePrivateFile,
} from "./lib/private-output.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const contract = JSON.parse(
  readFileSync(
    new URL(
      "../contracts/platform/development-authentication-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const profile = contract.development_pki;
const services = Object.keys(contract.static_services).sort();
const cancelled = (signal) => {
  if (signal?.aborted) throw new Error("pki_cancelled");
};

function terminate(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function openssl(command, args, signal) {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    // No shell, interactive input or command output containing private paths.
    // Inherit the coordinator's process group so interrupted verification can
    // also remove the child; OpenSSL itself does not start subprocesses.
    const child = spawn(command[0], [...command.slice(1), ...args], {
      stdio: "ignore",
    });
    let outcome, escalation;
    const stop = (reason) => {
      outcome ??= reason;
      terminate(child, "SIGTERM");
      escalation ??= setTimeout(() => terminate(child, "SIGKILL"), 1000);
    };
    const onAbort = () => stop("pki_cancelled");
    const deadline = setTimeout(() => stop("pki_failed"), 10000);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => {
      outcome ??= "pki_failed";
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
      if (outcome || code !== 0 || signal?.aborted)
        reject(
          new Error(
            signal?.aborted ? "pki_cancelled" : (outcome ?? "pki_failed"),
          ),
        );
      else resolve();
    });
    if (signal?.aborted) onAbort();
  });
}

function privateKey() {
  return generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  }).privateKey.export({ format: "pem", type: "pkcs8" });
}

function serial() {
  const bytes = randomBytes(20);
  bytes[0] = (bytes[0] & 0x7f) | 1;
  return `0x${bytes.toString("hex")}`;
}

export async function provisionPki({
  output = resolve(root, profile.output_directory),
  signal,
  command = ["openssl"],
} = {}) {
  let path,
    created = false;
  try {
    cancelled(signal);
    if (
      typeof process.getuid !== "function" ||
      typeof process.getgid !== "function" ||
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((value) => typeof value !== "string" || value.length === 0)
    )
      throw new Error("pki_failed");
    path = validatePrivateOutput(output, "pki");
    createPrivateParents(dirname(path));
    validatePrivateOutput(path, "pki");
    mkdirSync(path, { mode: 0o700 });
    created = true;
    chmodSync(path, 0o700);
    const work = join(path, ".work");
    createPrivateDirectory(work);
    const caKey = join(path, profile.ca.private_file),
      ca = join(path, profile.ca.certificate_file),
      caConfig = join(work, "ca.cnf");
    writePrivateFile(caKey, privateKey());
    writePrivateFile(ca, "");
    writePrivateFile(
      caConfig,
      `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca_ext\n[dn]\nCN=Antnest disposable development CA\n[ca_ext]\nbasicConstraints=critical,CA:TRUE,pathlen:${profile.ca.path_length}\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n`,
    );
    await openssl(
      command,
      [
        "req",
        "-new",
        "-x509",
        "-key",
        caKey,
        "-config",
        caConfig,
        "-sha256",
        "-days",
        String(profile.ca.valid_days),
        "-set_serial",
        serial(),
        "-out",
        ca,
      ],
      signal,
    );
    for (const service of services) {
      cancelled(signal);
      const directory = join(path, service);
      createPrivateDirectory(directory);
      const key = join(directory, "key.pem"),
        cert = join(directory, "cert.pem"),
        config = join(work, `${service}.cnf`),
        csr = join(work, `${service}.csr`);
      const dns = [service, ...(profile.leaf.dns_aliases[service] ?? [])];
      const names = [
        `URI.1=${profile.leaf.uri_template.replace("<service>", service)}`,
        ...dns.map((name, index) => `DNS.${index + 1}=${name}`),
      ].join("\n");
      writePrivateFile(key, privateKey());
      writePrivateFile(cert, "");
      writePrivateFile(csr, "");
      writePrivateFile(
        config,
        `[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=${service}\n[leaf_ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${profile.leaf.extended_key_usages.join(",")}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\nsubjectAltName=@alt_names\n[alt_names]\n${names}\n`,
      );
      await openssl(
        command,
        ["req", "-new", "-key", key, "-config", config, "-sha256", "-out", csr],
        signal,
      );
      await openssl(
        command,
        [
          "x509",
          "-req",
          "-in",
          csr,
          "-CA",
          ca,
          "-CAkey",
          caKey,
          "-set_serial",
          serial(),
          "-sha256",
          "-days",
          String(profile.leaf.valid_days),
          "-extfile",
          config,
          "-extensions",
          "leaf_ext",
          "-out",
          cert,
        ],
        signal,
      );
    }
    cancelled(signal);
    rmSync(work, { recursive: true });
    const manifest = { version: contract.version, services };
    writePrivateFile(
      join(path, profile.manifest_file),
      `${JSON.stringify(manifest)}\n`,
    );
    const environment = {
      ANTNEST_DEV_PKI_DIRECTORY: path,
      ANTNEST_SERVICE_AUTH_UID: String(process.getuid()),
      ANTNEST_SERVICE_AUTH_GID: String(process.getgid()),
    };
    writePrivateFile(
      join(path, profile.environment_file),
      Object.entries(environment)
        .map(([key, value]) => `${key}='${value}'\n`)
        .join(""),
    );
    return manifest;
  } catch (error) {
    if (created) {
      try {
        rmSync(path, { recursive: true });
      } catch {
        throw new Error("pki_cleanup_failed");
      }
    }
    if (
      error instanceof Error &&
      ["output_invalid", "output_exists", "pki_cancelled"].includes(
        error.message,
      )
    )
      throw error;
    // eslint-disable-next-line preserve-caught-error -- Causes can include private filesystem paths; expose classifications only.
    throw new Error("pki_failed");
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    const { values } = parseArgs({
      options: {
        output: {
          type: "string",
          default: resolve(root, profile.output_directory),
        },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help)
      console.log(
        "Usage: sh scripts/dev-pki.sh [--output PATH]\nCreates a fresh, private disposable-development CA and static workload certificates. Existing output is never replaced.",
      );
    else {
      const manifest = await provisionPki({
        output: values.output,
        signal: controller.signal,
      });
      console.log(
        JSON.stringify({ complete: true, services: manifest.services.length }),
      );
    }
  } catch {
    console.error("Development PKI provisioning failed.");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}
