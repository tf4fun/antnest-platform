import assert from "node:assert/strict";
import test from "node:test";
import { invalidatesBrowserSession } from "./session-errors.ts";

test("only Edge-level administrator rejection invalidates the browser session", () => {
  assert.equal(invalidatesBrowserSession("/api/admin/agents", 401), true);
  assert.equal(invalidatesBrowserSession("/api/admin/account/password", 401), false);
  assert.equal(invalidatesBrowserSession("/api/admin/agents", 403), false);
  assert.equal(invalidatesBrowserSession("/api/session/login", 401), false);
});
