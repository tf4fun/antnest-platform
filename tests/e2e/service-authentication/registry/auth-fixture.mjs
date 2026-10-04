import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function createFixture(directory) {
  mkdirSync(resolve(directory, "outgoing"), { recursive: true, mode: 0o700 });
  const incoming = Object.fromEntries(
    [
      "admin-console",
      "agent-controller",
      "runtime-controller",
      "agent-acp-service",
      "edge-gateway",
    ].map((name) => [name, randomBytes(32).toString("base64url")]),
  );
  const outgoing = Object.fromEntries(
    ["identity-service", "agent-acp-service"].map((name) => [
      name,
      randomBytes(32).toString("base64url"),
    ]),
  );
  const hash = (value) =>
    "sha256:" + createHash("sha256").update(value, "ascii").digest("hex");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwks = {
    keys: [
      {
        ...publicKey.export({ format: "jwk" }),
        kid: "registry-fixture",
        use: "sig",
        alg: "EdDSA",
      },
    ],
  };
  writeFileSync(
    resolve(directory, "callers.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(incoming).map(([name, token]) => [name, [hash(token)]]),
      ),
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(directory, "peers.json"),
    JSON.stringify({
      jwks,
      hashes: Object.fromEntries(
        Object.entries(outgoing).map(([name, token]) => [name, hash(token)]),
      ),
    }),
    { mode: 0o600 },
  );
  for (const [name, token] of Object.entries(outgoing))
    writeFileSync(resolve(directory, "outgoing", name), token, { mode: 0o600 });
  return { incoming, outgoing, jwks, privateKey };
}

export function callerContext(fixture, changes = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({
      typ: "antnest-cct+jwt",
      alg: "EdDSA",
      kid: "registry-fixture",
    }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "antnest://service/identity-service",
      sub: `user_${"c".repeat(32)}`,
      org: `org_${"a".repeat(32)}`,
      mbr: "member-fixture",
      sys_role: "user",
      org_role: "admin",
      sid: "session-fixture",
      aud: ["skill-registry"],
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      ...changes,
    }),
  ).toString("base64url");
  const input = header + "." + body;
  return (
    input +
    "." +
    sign(null, Buffer.from(input), fixture.privateKey).toString("base64url")
  );
}
