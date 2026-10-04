import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createPrivateDirectory as directory,
  createPrivateParents as parents,
  validatePrivateOutput as validateOutput,
  writePrivateFile as write,
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
const services = Object.keys(contract.static_services).sort();
const failure = (code) => new Error(code);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function deriveStaticPairs(catalogs) {
  try {
    if (!object(catalogs) || Object.keys(catalogs).length !== services.length)
      throw failure("catalog_invalid");
    const pairs = new Map();
    for (const receiver of services) {
      const catalog = catalogs[receiver];
      if (
        !object(catalog) ||
        catalog.service !== receiver ||
        catalog.status !== "enforced" ||
        !object(catalog.routes)
      )
        throw failure("catalog_invalid");
      for (const route of Object.values(catalog.routes)) {
        if (
          !object(route) ||
          !["workload", "public", "health", "deny", "delegate"].includes(
            route.authentication,
          )
        )
          throw failure("catalog_invalid");
        if (route.authentication !== "workload") continue;
        if (
          !Array.isArray(route.callers) ||
          route.callers.length === 0 ||
          new Set(route.callers).size !== route.callers.length
        )
          throw failure("catalog_invalid");
        for (const caller of route.callers) {
          if (!services.includes(caller)) throw failure("catalog_invalid");
          pairs.set(`${caller}->${receiver}`, { caller, receiver });
        }
      }
    }
    return [...pairs.values()].sort(
      (a, b) => compare(a.caller, b.caller) || compare(a.receiver, b.receiver),
    );
  } catch {
    throw failure("catalog_invalid");
  }
}

function readPairs() {
  try {
    return deriveStaticPairs(
      Object.fromEntries(
        Object.entries(contract.static_services).map(([service, file]) => [
          service,
          JSON.parse(readFileSync(resolve(root, file), "utf8")),
        ]),
      ),
    );
  } catch {
    throw failure("catalog_invalid");
  }
}

function json(value) {
  return `${JSON.stringify(value)}\n`;
}

function envFile(values) {
  return Object.entries(values)
    .map(([name, value]) => `${name}='${value}'\n`)
    .join("");
}

export function provisionTokens({
  output = resolve(root, contract.token_provisioning.output_directory),
  withSkillLearning = false,
} = {}) {
  if (typeof withSkillLearning !== "boolean")
    throw failure("provisioning_failed");
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function"
  )
    throw failure("provisioning_failed");
  const pairs = readPairs();
  let created = false;
  let path;
  try {
    path = validateOutput(output);
    parents(dirname(path));
    // Recheck ancestry after creating missing parents, before creating the owned root.
    validateOutput(path);
    mkdirSync(path, { mode: 0o700 });
    created = true;
    chmodSync(path, 0o700);
    const receivers = Object.fromEntries(
      services.map((service) => [service, {}]),
    );
    for (const service of services) {
      directory(join(path, service));
      directory(join(path, service, "tokens"));
    }
    for (const { caller, receiver } of pairs) {
      const token = randomBytes(
        contract.token_provisioning.random_bytes_per_pair,
      ).toString("base64url");
      write(join(path, caller, "tokens", receiver), token);
      receivers[receiver][caller] = [
        `sha256:${createHash("sha256").update(token, "ascii").digest("hex")}`,
      ];
    }
    for (const service of services) {
      const contents = json(receivers[service]);
      if (
        Buffer.byteLength(contents) >
        contract.token_provisioning.receiver_max_bytes
      )
        throw failure("provisioning_failed");
      write(join(path, service, "callers.json"), contents);
    }

    const cct = generateKeyPairSync("ed25519"),
      cctKid = `dev-cct-${randomUUID()}`;
    const cctKey = cct.privateKey.export({ format: "pem", type: "pkcs8" });
    const cctPublic = cct.publicKey.export({ format: "jwk" });
    write(
      join(path, contract.bootstrap_keys.identity_cct.private_file),
      cctKey,
    );
    write(
      join(path, contract.bootstrap_keys.identity_cct.public_file),
      json({ keys: [{ ...cctPublic, kid: cctKid }] }),
    );
    write(
      join(path, contract.bootstrap_keys.runtime_instance_master.file),
      randomBytes(contract.bootstrap_keys.runtime_instance_master.random_bytes),
    );
    const environment = {
      ANTNEST_SERVICE_AUTH_DIRECTORY: path,
      ANTNEST_SERVICE_AUTH_UID: String(process.getuid()),
      ANTNEST_SERVICE_AUTH_GID: String(process.getgid()),
      ANTNEST_IDENTITY_CCT_SIGNING_KID: cctKid,
      ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "",
      ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: "",
      ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS: "",
    };
    if (withSkillLearning) {
      const learning = generateKeyPairSync("ed25519"),
        kid = `dev-maintenance-${randomUUID()}`;
      environment.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID = kid;
      environment.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY =
        learning.privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64");
      environment.ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS = JSON.stringify({
        keys: [
          {
            kid,
            algorithm: "Ed25519",
            public_key_base64url: learning.publicKey.export({ format: "jwk" })
              .x,
          },
        ],
      });
    }
    const manifest = {
      version: contract.version,
      services,
      pairs,
      cct_kid: cctKid,
      skill_learning: withSkillLearning,
    };
    write(
      join(path, contract.token_provisioning.environment_file),
      envFile(environment),
    );
    write(
      join(path, contract.token_provisioning.manifest_file),
      json(manifest),
    );
    return manifest;
  } catch (error) {
    if (created) {
      try {
        rmSync(path, { recursive: true });
      } catch {
        throw failure("provisioning_cleanup_failed");
      }
    }
    if (
      error instanceof Error &&
      ["output_invalid", "output_exists"].includes(error.message)
    )
      throw error;
    throw failure("provisioning_failed");
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        output: {
          type: "string",
          default: resolve(root, contract.token_provisioning.output_directory),
        },
        "with-skill-learning": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help) {
      console.log(
        "Usage: node scripts/dev-service-tokens.mjs [--output PATH] [--with-skill-learning]\nCreates a fresh, private disposable-development credential directory. Existing output is never replaced.",
      );
    } else {
      const manifest = provisionTokens({
        output: values.output,
        withSkillLearning: values["with-skill-learning"],
      });
      console.log(
        JSON.stringify({
          complete: true,
          services: manifest.services.length,
          pairs: manifest.pairs.length,
          skill_learning: manifest.skill_learning,
        }),
      );
    }
  } catch {
    console.error("Development credential provisioning failed.");
    process.exitCode = 1;
  }
}
