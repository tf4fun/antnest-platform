import assert from "node:assert/strict";
import { randomUUID, createPublicKey, verify } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { provisionTokens } from "../../scripts/dev-service-tokens.mjs";
import { FixtureCallerContext } from "./fixture-caller-context.mjs";

test("a fixture signs a fresh scoped CCT from registered principal evidence, ignoring forwarded role claims", (t) => {
  const path = resolve("artifacts/verification/fixture-cct-" + randomUUID());
  t.after(() => rmSync(path, { recursive: true, force: true }));
  provisionTokens({ output: path });
  const env = parseEnv(readFileSync(path + "/deployment.env", "utf8"));
  const fixture = new FixtureCallerContext(
    path,
    env.ANTNEST_IDENTITY_CCT_SIGNING_KID,
  );
  fixture.register({
    user_id: "owner",
    organization_id: "org",
    membership_id: "membership",
    system_role: "user",
    organization_role: "member",
  });
  const headers = fixture.headers({
    caller: "admin-console",
    receiver: "agent-controller",
    principalID: "owner",
    agentID: "agent",
  });
  assert.equal(
    headers["Antnest-Service-Authorization"],
    "Bearer " +
      readFileSync(path + "/admin-console/tokens/agent-controller", "utf8"),
  );
  const [head, body, signature] = headers["Antnest-Caller-Context"].split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(claims.sub, "owner");
  assert.equal(claims.org_role, "member");
  assert.equal(claims.agt, "agent");
  assert.deepEqual(claims.aud, ["agent-controller"]);
  assert.equal(claims.exp - claims.iat, 60);
  const jwks = JSON.parse(
    readFileSync(path + "/identity-service/cct-jwks.json", "utf8"),
  );
  assert(
    verify(
      null,
      Buffer.from(head + "." + body),
      createPublicKey({ key: jwks.keys[0], format: "jwk" }),
      Buffer.from(signature, "base64url"),
    ),
  );
  assert.throws(() =>
    fixture.headers({
      caller: "admin-console",
      receiver: "agent-controller",
      principalID: "unregistered",
    }),
  );
  assert.throws(() =>
    fixture.headers({
      caller: "admin-console",
      receiver: "../operator",
      principalID: "owner",
    }),
  );
  assert.throws(() =>
    fixture.headers({
      caller: "admin-console",
      receiver: "identity-service",
      principalID: "owner",
    }),
  );
  const principal = {
    user_id: "owner",
    organization_id: "org",
    membership_id: "membership",
    system_role: "user",
    organization_role: "member",
  };
  fixture.register(principal, "real-login-session");
  fixture.register(principal);
  const identityContext = fixture.headers({
    caller: "admin-console",
    receiver: "identity-service",
    principalID: "owner",
  });
  assert.equal(
    JSON.parse(
      Buffer.from(
        identityContext["Antnest-Caller-Context"].split(".")[1],
        "base64url",
      ),
    ).sid,
    "real-login-session",
  );
  fixture.register(
    {
      ...principal,
      organization_id: "foreign-org",
      membership_id: "foreign-membership",
    },
    "foreign-session",
  );
  const foreignContext = fixture.headers({
    caller: "admin-console",
    receiver: "identity-service",
    principalID: "owner",
    organizationID: "foreign-org",
  });
  assert.equal(
    JSON.parse(
      Buffer.from(
        foreignContext["Antnest-Caller-Context"].split(".")[1],
        "base64url",
      ),
    ).sid,
    "foreign-session",
  );
  const originalContext = fixture.headers({
    caller: "admin-console",
    receiver: "identity-service",
    principalID: "owner",
  });
  assert.equal(
    JSON.parse(
      Buffer.from(
        originalContext["Antnest-Caller-Context"].split(".")[1],
        "base64url",
      ),
    ).sid,
    "real-login-session",
  );
});
