import assert from "node:assert/strict";
import test from "node:test";
import { agentWorkspacePath, sessionDestination } from "./session-destination.ts";
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

test("preserves a selected Agent and Session through login without leaking authority", () => {
  const destination = agentWorkspacePath("agent / 1");
  assert.equal(destination, "/workspace/agent%20%2F%201/");
  const full = destination + "sessions/session%261";
  assert.equal(sessionDestination(session("admin", "member"), destination), destination);
  assert.equal(sessionDestination(session("admin", "member"), full), full);
});

test("rejects external, ambiguous and non-Workspace login destinations", () => {
  for (const value of ["//evil.example/workspace/", "/workspace/../admin", "/workspace/?agent=a&agent=b", "/workspace/?session=s1",
    "/workspace/?agent=%00", "/workspace/?agent=a&return_to=https://evil.example", "/workspace/?agent=a#credentials",
    "https://example.com/workspace/", "/workspace/?agent=" + "a".repeat(201),
    "/workspace/a/sessions/", "/workspace/a/sessions/s/extra", "/workspace/a/?session=s",
    "/workspace/a/sessions/s#fragment", "/workspace/%2e%2e/", "/workspace/a/sessions/%2E",
    "/workspace/assets/", "/workspace/%00/", "/workspace/%E0%A4/", "/workspace/%20a/",
    "/workspace/" + "a".repeat(201) + "/"]) {
    assert.equal(sessionDestination(session("admin", "member"), value), undefined, value);
  }
});
