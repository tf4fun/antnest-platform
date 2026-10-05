import assert from "node:assert/strict";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { durablePath } from "./storage.mjs";

// Synthetic issuer for a test-owned, freshly provisioned deployment only.
// Principals are registered from real login/directory responses, never headers.
export class FixtureCallerContext {
  #directory;
  #kid;
  #key;
  #principals = new Map();
  #defaultOrganizations = new Map();
  constructor(directory, kid) {
    this.#directory = durablePath(directory);
    assert(this.#directory.startsWith(resolve("artifacts/verification") + "/"));
    assert(typeof kid === "string" && /^[A-Za-z0-9_-]+$/u.test(kid));
    this.#kid = kid;
    this.#key = createPrivateKey(
      readFileSync(
        resolve(this.#directory, "identity-service/cct-signing.pem"),
      ),
    );
  }
  register(principal, sessionID) {
    for (const field of [
      "user_id",
      "organization_id",
      "membership_id",
      "system_role",
      "organization_role",
    ])
      assert(typeof principal[field] === "string" && principal[field]);
    if (sessionID !== undefined)
      assert(typeof sessionID === "string" && sessionID);
    const scope = JSON.stringify([
      principal.user_id,
      principal.organization_id,
    ]);
    if (!this.#defaultOrganizations.has(principal.user_id))
      this.#defaultOrganizations.set(
        principal.user_id,
        principal.organization_id,
      );
    this.#principals.set(scope, {
      ...principal,
      sessionID: sessionID ?? this.#principals.get(scope)?.sessionID,
    });
  }
  headers({ caller, receiver, principalID, organizationID, agentID }) {
    for (const service of [caller, receiver])
      assert(/^[a-z][a-z-]+$/u.test(service));
    const token = readFileSync(
      resolve(this.#directory, caller, "tokens", receiver),
      "utf8",
    );
    const headers = { "Antnest-Service-Authorization": "Bearer " + token };
    if (principalID === undefined) return headers;
    const principal = this.#principals.get(
      JSON.stringify([
        principalID,
        organizationID ?? this.#defaultOrganizations.get(principalID),
      ]),
    );
    assert(principal, "unregistered fixture principal");
    if (receiver === "identity-service")
      assert(
        principal.sessionID,
        "Identity fixture requires a real login session",
      );
    const now = Math.floor(Date.now() / 1000);
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload =
      encode({ typ: "antnest-cct+jwt", alg: "EdDSA", kid: this.#kid }) +
      "." +
      encode({
        iss: "antnest://service/identity-service",
        sub: principal.user_id,
        org: principal.organization_id,
        mbr: principal.membership_id,
        sys_role: principal.system_role,
        org_role: principal.organization_role,
        sid: principal.sessionID ?? "fixture-" + principal.user_id,
        aud: [receiver],
        iat: now,
        exp: now + 60,
        jti: randomUUID(),
        ...(agentID === undefined ? {} : { agt: agentID }),
      });
    headers["Antnest-Caller-Context"] =
      payload +
      "." +
      sign(null, Buffer.from(payload), this.#key).toString("base64url");
    return headers;
  }
}
