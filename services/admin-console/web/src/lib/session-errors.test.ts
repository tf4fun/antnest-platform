import assert from "node:assert/strict";
import test from "node:test";
import { invalidatesBrowserSession } from "./session-errors.ts";

test("protected session 401s invalidate while password 400 and dependency errors remain local", () => {
  assert.equal(invalidatesBrowserSession("/api/admin/agents", 401), true);
  assert.equal(invalidatesBrowserSession("/api/admin/account/password", 401), true);
  assert.equal(invalidatesBrowserSession("/api/admin/account/password", 401, "unauthenticated"), true);
  assert.equal(invalidatesBrowserSession("/api/admin/account/password", 401, "unknown"), true);
  assert.equal(invalidatesBrowserSession("/api/session/password", 401, "invalid_current_password"), true);
  assert.equal(invalidatesBrowserSession("/api/session/password", 400, "invalid_current_password"), false);
  for (const path of ["/api/session", "/api/session/account", "/api/session/activity", "/api/session/sessions?limit=50", "/api/session/sessions/revoke"]) {
    assert.equal(invalidatesBrowserSession(path, 401), true);
    assert.equal(invalidatesBrowserSession(path, 503), false);
  }
  assert.equal(invalidatesBrowserSession("/api/admin/agents", 401, "invalid_current_password"), true);
  assert.equal(invalidatesBrowserSession("/api/admin/agents", 403), false);
  assert.equal(invalidatesBrowserSession("/api/admin/account/password", 503), false);
  assert.equal(invalidatesBrowserSession("/api/session/login", 401), false);
});
