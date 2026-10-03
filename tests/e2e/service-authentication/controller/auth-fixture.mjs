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
  const ports = {
    "identity-service": 8101,
    "agent-acp-service": 8102,
    "runtime-controller": 8103,
    "runtime-egress": 8104,
    "skill-registry": 8105,
  };
  const incoming = Object.fromEntries(
    [
      "admin-console",
      "agent-ui",
      "edge-gateway",
      "agent-acp-service",
      "runtime-controller",
    ].map((name) => [name, randomBytes(32).toString("base64url")]),
  );
  const tokens = Object.fromEntries(
    Object.keys(ports).map((name) => [
      name,
      randomBytes(32).toString("base64url"),
    ]),
  );
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwks = {
    keys: [
      {
        ...publicKey.export({ format: "jwk" }),
        kid: "controller-test",
        use: "sig",
        alg: "EdDSA",
      },
    ],
  };
  const skill = {
    skill_id: "skill_" + randomBytes(16).toString("hex"),
    version: 1,
    name: "auth-fixture",
    description: "Authentication fixture",
    artifact_digest: "sha256:" + "a".repeat(64),
    content_digest: "sha256:" + "b".repeat(64),
    artifact_size: 128,
    unpacked_size: 256,
    package_rules_version: 1,
  };
  writeFileSync(
    resolve(directory, "callers.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(incoming).map(([name, token]) => [
          name,
          ["sha256:" + hash(token)],
        ]),
      ),
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(directory, "fixture.json"),
    JSON.stringify({
      ports,
      jwks,
      skill,
      hashes: Object.fromEntries(
        Object.entries(tokens).map(([name, token]) => [name, [hash(token)]]),
      ),
    }),
    { mode: 0o600 },
  );
  for (const [name, token] of Object.entries(tokens))
    writeFileSync(resolve(directory, "outgoing", name), token, { mode: 0o600 });
  return { incoming, tokens, ports, jwks, skill, privateKey };
}
export function callerContext(
  fixture,
  changes = {},
  transform = (value) => value,
) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({
      typ: "antnest-cct+jwt",
      alg: "EdDSA",
      kid: "controller-test",
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    transform(
      JSON.stringify({
        iss: "antnest://service/identity-service",
        sub: "user-admin",
        org: "org-1",
        mbr: "member-1",
        sys_role: "user",
        org_role: "admin",
        sid: "session-1",
        aud: ["admin-console", "agent-controller", "skill-registry"],
        iat: now,
        exp: now + 60,
        jti: randomUUID(),
        ...changes,
      }),
    ),
  ).toString("base64url");
  const input = header + "." + payload;
  return (
    input +
    "." +
    sign(null, Buffer.from(input), fixture.privateKey).toString("base64url")
  );
}
