import assert from "node:assert/strict";
import test from "node:test";
import { invalidatesBrowserSession } from "./session-errors.ts";

test("only explicit password credential rejection preserves the browser session", () => {
  assert.equal(invalidatesBrowserSession("/api/admin/agents", 401), true);
  assert.equal(invalidatesBrowserSession("/api/admin/account/password", 401), true);
  assert.equal(invalidatesBrowserSession("/api/admin/account/password", 401, "unauthenticated"), true);
  assert.equal(invalidatesBrowserSession("/api/admin/account/password", 401, "unknown"), true);
  assert.equal(invalidatesBrowserSession("/api/admin/account/password", 401, "invalid_current_password"), false);
  assert.equal(invalidatesBrowserSession("/api/admin/agents", 401, "invalid_current_password"), true);
  assert.equal(invalidatesBrowserSession("/api/admin/agents", 403), false);
  assert.equal(invalidatesBrowserSession("/api/admin/account/password", 503), false);
  assert.equal(invalidatesBrowserSession("/api/session/login", 401), false);
});
