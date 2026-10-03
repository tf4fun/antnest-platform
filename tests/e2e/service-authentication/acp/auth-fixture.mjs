import {
  createHash,
  randomBytes,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function createFixture(directory) {
  mkdirSync(resolve(directory, "outgoing"), { recursive: true, mode: 0o700 });
  const callers = [
    "edge-gateway",
    "agent-ui",
    "agent-controller",
    "admin-console",
    "skill-registry",
    "runtime-controller",
  ];
  const tokens = Object.fromEntries(
    callers.map((name) => [name, randomBytes(32).toString("base64url")]),
  );
  const outgoing = randomBytes(32).toString("base64url");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwks = {
    keys: [
      {
        ...publicKey.export({ format: "jwk" }),
        kid: "acp-auth-test",
        use: "sig",
        alg: "EdDSA",
      },
    ],
  };
  writeFileSync(
    resolve(directory, "callers.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(tokens).map(([name, token]) => [
          name,
          [`sha256:${createHash("sha256").update(token).digest("hex")}`],
        ]),
      ),
    ),
    { mode: 0o600 },
  );
  writeFileSync(resolve(directory, "outgoing", "identity-service"), outgoing, {
    mode: 0o600,
  });
  return { tokens, outgoing, jwks, privateKey, directory };
}
export function headers(fixture, caller, claims) {
  const result = {
    "Antnest-Service-Authorization": `Bearer ${fixture.tokens[caller]}`,
  };
  if (claims === undefined) return result;
  const now = Math.floor(Date.now() / 1000);
  const payload = `${Buffer.from(JSON.stringify({ typ: "antnest-cct+jwt", alg: "EdDSA", kid: "acp-auth-test" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: "antnest://service/identity-service", sub: "principal-1", org: "organization-1", mbr: "membership-1", sys_role: "user", org_role: "member", sid: "auth-session-1", aud: ["agent-acp-service"], iat: now, exp: now + 60, jti: randomUUID(), ...claims })).toString("base64url")}`;
  result["Antnest-Caller-Context"] =
    `${payload}.${sign(null, Buffer.from(payload), fixture.privateKey).toString("base64url")}`;
  return result;
}
