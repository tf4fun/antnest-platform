import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const ports = {
  "identity-service": 8101,
  "agent-controller": 8102,
  "agent-acp-service": 8103,
  "skill-registry": 8104,
};

export function createFixture(directory) {
  mkdirSync(resolve(directory, "outgoing"), { recursive: true, mode: 0o700 });
  const incoming = randomBytes(32).toString("base64url");
  const forbidden = randomBytes(32).toString("base64url");
  const tokens = Object.fromEntries(
    Object.keys(ports).map((name) => [
      name,
      randomBytes(32).toString("base64url"),
    ]),
  );
  const next = randomBytes(32).toString("base64url");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const hashes = Object.fromEntries(
    Object.entries(tokens).map(([name, token]) => [name, [hash(token)]]),
  );
  hashes["agent-controller"].push(hash(next));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwks = {
    keys: [
      {
        ...publicKey.export({ format: "jwk" }),
        kid: "console-test",
        use: "sig",
        alg: "EdDSA",
      },
    ],
  };
  const preparations = Object.fromEntries(
    ["create", "rebuild", "enable"].map((kind) => {
      const key =
        kind === "create"
          ? "console-skill-preparation-original-0001"
          : `console-skill-${kind}-original-0001`;
      const request_id =
        "lifecycle-" +
        createHash("sha256").update(`org-1\0${key}`).digest("hex");
      return [kind, { key, request_id, kind }];
    }),
  );
  const fixture = { ports, hashes, jwks, preparations };
  writeFileSync(
    resolve(directory, "callers.json"),
    JSON.stringify({
      "edge-gateway": ["sha256:" + hash(incoming)],
      "agent-ui": ["sha256:" + hash(forbidden)],
    }),
    { mode: 0o600 },
  );
  writeFileSync(resolve(directory, "fixture.json"), JSON.stringify(fixture), {
    mode: 0o600,
  });
  for (const [name, token] of Object.entries(tokens))
    writeFileSync(resolve(directory, "outgoing", name), token, { mode: 0o600 });
  return { incoming, forbidden, tokens, next, privateKey, ...fixture };
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
      kid: "console-test",
    }),
  ).toString("base64url");
  const claims = {
    iss: "antnest://service/identity-service",
    sub: "user-admin",
    org: "org-1",
    mbr: "member-1",
    sys_role: "user",
    org_role: "admin",
    sid: "session-1",
    aud: [
      "admin-console",
      "identity-service",
      "agent-controller",
      "agent-acp-service",
      "skill-registry",
    ],
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    ...changes,
  };
  const payload = Buffer.from(transform(JSON.stringify(claims))).toString(
    "base64url",
  );
  const input = `${header}.${payload}`;
  return (
    input +
    "." +
    sign(null, Buffer.from(input), fixture.privateKey).toString("base64url")
  );
}
