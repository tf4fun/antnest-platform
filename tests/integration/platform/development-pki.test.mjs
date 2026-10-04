import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:https";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = resolve(root, "scripts/dev-pki.mjs"),
  wrapper = resolve(root, "scripts/dev-pki.sh");
const contract = JSON.parse(
  readFileSync(
    resolve(
      root,
      "contracts/platform/development-authentication-contract.json",
    ),
    "utf8",
  ),
);
const services = Object.keys(contract.static_services).sort();
async function helper() {
  assert(existsSync(script), "missing development PKI helper");
  return import(new URL("../../../scripts/dev-pki.mjs", import.meta.url));
}
function fixture(t) {
  const parent = resolve(root, "artifacts/verification/development-pki");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, "case-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const bytes = (output, file) => readFileSync(resolve(output, file));

test("PKI creates a separate constrained CA and exact independent static workload leaves", async (t) => {
  const { provisionPki } = await helper();
  const output = join(fixture(t), "pki");
  const manifest = await provisionPki({ output });
  assert.equal(manifest.version, contract.version);
  assert.deepEqual(manifest.services, services);
  const ca = new X509Certificate(bytes(output, "ca.pem"));
  const caKey = createPrivateKey(bytes(output, "ca-key.pem"));
  assert(ca.ca && ca.verify(ca.publicKey) && ca.checkPrivateKey(caKey));
  assert.equal(caKey.asymmetricKeyType, "ec");
  assert.equal(caKey.asymmetricKeyDetails.namedCurve, "prime256v1");
  assert.equal(
    Date.parse(ca.validTo) - Date.parse(ca.validFrom),
    365 * 86400000,
  );
  const serials = new Set([ca.serialNumber]),
    publicKeys = new Set([
      ca.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    ]);
  for (const service of services) {
    const pem = bytes(output, `${service}/cert.pem`),
      keyPem = bytes(output, `${service}/key.pem`);
    const cert = new X509Certificate(pem),
      key = createPrivateKey(keyPem);
    assert(!cert.ca && cert.verify(ca.publicKey) && cert.checkPrivateKey(key));
    assert.equal(key.asymmetricKeyType, "ec");
    assert.equal(key.asymmetricKeyDetails.namedCurve, "prime256v1");
    assert.match(keyPem.toString("ascii"), /^-----BEGIN PRIVATE KEY-----/u);
    const sans = cert.subjectAltName.split(", ");
    assert.deepEqual(
      sans.filter((value) => value.startsWith("URI:")),
      [`URI:antnest://service/${service}`],
    );
    const aliases = [
      service,
      ...(contract.development_pki.leaf.dns_aliases[service] ?? []),
    ];
    assert.deepEqual(
      sans
        .filter((value) => value.startsWith("DNS:"))
        .map((value) => value.slice(4))
        .sort(),
      aliases.sort(),
    );
    for (const dns of aliases) assert.equal(cert.checkHost(dns), dns);
    assert.equal(cert.checkHost("unrelated.example.invalid"), undefined);
    assert.equal(cert.checkIP("127.0.0.1"), undefined);
    assert.deepEqual(cert.keyUsage.sort(), [
      "1.3.6.1.5.5.7.3.1",
      "1.3.6.1.5.5.7.3.2",
    ]);
    assert.equal(
      Date.parse(cert.validTo) - Date.parse(cert.validFrom),
      30 * 86400000,
    );
    assert(
      Date.parse(cert.validFrom) <= Date.now() &&
        Date.now() < Date.parse(cert.validTo),
    );
    assert(!serials.has(cert.serialNumber));
    serials.add(cert.serialNumber);
    const publicKey = cert.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    assert(!publicKeys.has(publicKey));
    publicKeys.add(publicKey);
    for (const purpose of ["sslclient", "sslserver"]) {
      const result = spawnSync(
        "openssl",
        [
          "verify",
          "-x509_strict",
          "-purpose",
          purpose,
          "-CAfile",
          join(output, "ca.pem"),
          join(output, service, "cert.pem"),
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(result.status, 0, "strict certificate purpose validation");
    }
  }
  assert(!existsSync(join(output, "antnest-runtime")));
  assert(!existsSync(join(output, ".work")));
  function inspect(path) {
    const row = statSync(path);
    assert.equal(row.mode & 0o777, row.isDirectory() ? 0o700 : 0o600);
    if (row.isDirectory())
      for (const name of readdirSync(path)) inspect(join(path, name));
    else assert(row.isFile() && row.nlink === 1);
  }
  inspect(output);
  const env = parseEnv(bytes(output, "pki.env").toString("utf8"));
  assert.equal(env.ANTNEST_DEV_PKI_DIRECTORY, output);
  assert.equal(env.ANTNEST_SERVICE_AUTH_UID, String(process.getuid()));
  assert.equal(env.ANTNEST_SERVICE_AUTH_GID, String(process.getgid()));
  assert(!bytes(output, "manifest.json").includes(Buffer.from("PRIVATE KEY")));
  assert(!bytes(output, "pki.env").includes(Buffer.from("PRIVATE KEY")));
});

test("generated leaves establish mutual TLS and reject absent, unrelated or wrong-name peers", async (t) => {
  const { provisionPki } = await helper();
  const output = join(fixture(t), "tls");
  await provisionPki({ output });
  const ca = bytes(output, "ca.pem");
  let requests = 0;
  const server = createServer(
    {
      key: bytes(output, "identity-service/key.pem"),
      cert: bytes(output, "identity-service/cert.pem"),
      ca,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    (req, res) => {
      requests++;
      const peer = new X509Certificate(req.socket.getPeerCertificate().raw);
      res
        .writeHead(
          peer.subjectAltName.includes("URI:antnest://service/edge-gateway")
            ? 200
            : 403,
        )
        .end();
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const call = (service, servername = "identity-service", trust = ca) =>
    new Promise((resolve, reject) => {
      const client = request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          servername,
          ca: trust,
          agent: false,
          minVersion: "TLSv1.3",
          ...(service
            ? {
                key: bytes(output, `${service}/key.pem`),
                cert: bytes(output, `${service}/cert.pem`),
              }
            : {}),
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode));
        },
      );
      client.setTimeout(3000, () =>
        client.destroy(new Error("test request deadline")),
      );
      client.once("error", reject);
      client.end();
    });
  assert.equal(await call("edge-gateway"), 200);
  assert.equal(await call("admin-console"), 403);
  await assert.rejects(call(undefined));
  await assert.rejects(call("edge-gateway", "wrong.example.invalid"));
  const unrelated = join(fixture(t), "other");
  await provisionPki({ output: unrelated });
  await assert.rejects(
    call("edge-gateway", "identity-service", bytes(unrelated, "ca.pem")),
  );
  assert.equal(
    requests,
    2,
    "TLS rejection must precede the application handler",
  );
});

test("existing issuers and output aliases are refused without touching retained keys", async (t) => {
  const { provisionPki } = await helper();
  const parent = fixture(t),
    output = join(parent, "retained");
  await provisionPki({ output });
  const original = bytes(output, "ca-key.pem");
  await assert.rejects(provisionPki({ output }), /output_exists/u);
  assert(bytes(output, "ca-key.pem").equals(original));
  const link = join(parent, "link");
  symlinkSync(output, link);
  await assert.rejects(
    provisionPki({ output: join(link, "new") }),
    /output_invalid/u,
  );
  for (const invalid of [
    join(root, "artifacts/service-authentication/pki-must-not-write"),
    join(parent, ".cache/new"),
    join(parent, "invalid\npath"),
  ]) {
    await assert.rejects(provisionPki({ output: invalid }), /output_invalid/u);
    assert(!existsSync(invalid));
  }
});

test("OpenSSL failure and pre-cancellation remove no parent or retained data", async (t) => {
  const { provisionPki } = await helper();
  const parent = fixture(t),
    output = join(parent, "failed");
  writeFileSync(join(parent, "sentinel"), "retained");
  await assert.rejects(
    provisionPki({ output, command: [join(parent, "missing-openssl")] }),
    /pki_failed/u,
  );
  assert(!existsSync(output));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provisionPki({ output, signal: controller.signal }),
    /pki_cancelled/u,
  );
  assert.deepEqual(readdirSync(parent), ["sentinel"]);
});

test("restrictive umask keeps newly created parents, signing inputs and certificates usable", async (t) => {
  const { provisionPki } = await helper();
  const parent = fixture(t),
    output = join(parent, "new-parent", "pki");
  const previous = process.umask(0o777);
  try {
    await provisionPki({ output });
    assert.equal(statSync(join(parent, "new-parent")).mode & 0o777, 0o700);
    assert.equal(statSync(join(output, "ca-key.pem")).mode & 0o777, 0o600);
    assert.equal(
      statSync(join(output, "identity-service/cert.pem")).mode & 0o777,
      0o600,
    );
    assert(
      new X509Certificate(bytes(output, "identity-service/cert.pem")).verify(
        new X509Certificate(bytes(output, "ca.pem")).publicKey,
      ),
    );
  } finally {
    process.umask(previous);
  }
});

test("cancellation reaps the OpenSSL process before cleaning private output", async (t) => {
  const { provisionPki } = await helper();
  const parent = fixture(t),
    output = join(parent, "cancelled"),
    ready = join(parent, "ready.json");
  const controller = new AbortController();
  const operation = provisionPki({
    output,
    signal: controller.signal,
    command: [
      process.execPath,
      resolve(root, "tests/support/fixtures/pki-openssl-process.mjs"),
      ready,
    ],
  });
  // Register a rejection handler immediately while waiting for the actual child.
  const result = operation.then(
    () => null,
    (error) => error,
  );
  const deadline = Date.now() + 5000;
  while (!existsSync(ready)) {
    assert(Date.now() < deadline);
    await delay(10);
  }
  const { pid } = JSON.parse(readFileSync(ready, "utf8"));
  controller.abort();
  assert.match((await result).message, /pki_cancelled/u);
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === "ESRCH",
  );
  assert(!existsSync(output));
});

test("CLI uses the selected Node and prints completion metadata without private material", (t) => {
  const output = join(fixture(t), "cli space");
  const result = spawnSync("sh", [wrapper, "--output", output], {
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { complete: true, services: 9 });
  assert(!result.stdout.includes("PRIVATE KEY"));
  const denied = spawnSync(
    process.execPath,
    [script, "--unknown-option", "private-value"],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(denied.status, 1);
  assert.equal(denied.stdout, "");
  assert.equal(denied.stderr, "Development PKI provisioning failed.\n");
});

test("CLI normal interruption reaps its child and deletes the candidate issuer", async (t) => {
  const parent = fixture(t),
    output = join(parent, "cli-cancelled");
  const ready = join(parent, "cli-ready.json"),
    shim = join(parent, "openssl");
  const q = (value) => `'${value.replace(/'/gu, `'"'"'`)}'`;
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${q(process.execPath)} ${q(resolve(root, "tests/support/fixtures/pki-openssl-process.mjs"))} ${q(ready)} "$@"\n`,
    { mode: 0o700 },
  );
  const child = spawn(process.execPath, [script, "--output", output], {
    env: { ...process.env, PATH: parent },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const closed = new Promise((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await closed;
    }
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(ready)) {
    assert(Date.now() < deadline);
    await delay(10);
  }
  const { pid } = JSON.parse(readFileSync(ready, "utf8"));
  child.kill("SIGTERM");
  assert.equal(await closed, 1);
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === "ESRCH",
  );
  assert(!existsSync(output));
  assert.equal(stdout, "");
  assert.equal(stderr, "Development PKI provisioning failed.\n");
});
