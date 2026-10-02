import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOrganizationSession } from "./organization-session.mjs";

const principal = {
  user_id: "u",
  organization_id: "o",
  membership_id: "m",
  organization_slug: "stage3",
  organization_name: "Stage 3",
  system_role: "user",
  organization_role: "member",
  active: true,
};

test("real-response admission requires matching nonempty Organization labels and forbids credentials", () => {
  for (const kind of ["login", "session"]) {
    const payload = {
      principal,
      ...(kind === "login" ? { expires_at: "2026-10-03T13:00:00Z" } : {}),
    };
    assert.equal(assertOrganizationSession(payload, kind), principal);
    for (const field of ["organization_slug", "organization_name"]) {
      for (const invalid of [
        undefined,
        "",
        " \t",
        false,
        "other-organization",
      ]) {
        assert.throws(() =>
          assertOrganizationSession(
            { ...payload, principal: { ...principal, [field]: invalid } },
            kind,
          ),
        );
      }
    }
    for (const field of ["access_token", "token_id", "provider_credential"]) {
      assert.throws(() =>
        assertOrganizationSession(
          { ...payload, [field]: "synthetic-secret" },
          kind,
        ),
      );
      assert.throws(() =>
        assertOrganizationSession(
          {
            ...payload,
            principal: { ...principal, [field]: "synthetic-secret" },
          },
          kind,
        ),
      );
    }
  }
});
