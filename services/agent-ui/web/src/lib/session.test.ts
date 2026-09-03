import assert from "node:assert/strict";
import test from "node:test";
import { csrfFromCookie } from "./session.ts";

test("reads only the Antnest CSRF cookie", () => {
  assert.equal(csrfFromCookie("other=private; antnest_csrf=csrf%3Dvalue; ignored=secret"), "csrf=value");
  assert.equal(csrfFromCookie("other=private"), "");
});
