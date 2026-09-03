import assert from "node:assert/strict";
import test from "node:test";
import { sessionDestination } from "./session-destination.ts";
import type { Session } from "./types.ts";

function session(systemRole: string, organizationRole: string): Session {
  return {
    principal: {
      user_id: "user-1",
      organization_id: "org-1",
      membership_id: "membership-1",
      system_role: systemRole,
      organization_role: organizationRole,
      active: true,
    },
  };
}

test("keeps administrators in Console unless workspace was requested", () => {
  assert.equal(sessionDestination(session("admin", "member"), null), undefined);
  assert.equal(sessionDestination(session("member", "admin"), null), undefined);
  assert.equal(sessionDestination(session("admin", "admin"), "/workspace/"), "/workspace/");
});

test("routes ordinary members to Agent workspace and rejects arbitrary return paths", () => {
  assert.equal(sessionDestination(session("member", "member"), null), "/workspace/");
  assert.equal(sessionDestination(session("member", "member"), "https://example.com"), "/workspace/");
});
