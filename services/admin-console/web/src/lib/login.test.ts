import assert from "node:assert/strict";
import test from "node:test";
import { authorizationDestination, callbackError } from "./login.ts";

test("OIDC callback errors are stable and do not echo provider details", () => {
  assert.match(callbackError("?auth_error=oidc_login_failed&state=secret-state"), /could not be completed/);
  assert.equal(callbackError("?auth_error=unknown"), "");
  assert.doesNotMatch(callbackError("?auth_error=oidc_login_failed&state=secret-state"), /secret-state/);
});

test("OIDC authorization only permits browser network schemes", () => {
  assert.equal(
    authorizationDestination("https://id.example.test/authorize?state=opaque"),
    "https://id.example.test/authorize?state=opaque",
  );
  assert.throws(() => authorizationDestination("javascript:alert(1)"), /invalid authorization address/);
});
