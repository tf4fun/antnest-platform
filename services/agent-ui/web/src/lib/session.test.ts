import assert from "node:assert/strict";
import test from "node:test";
import { csrfFromCookie } from "./session.ts";

test("reads only the Antnest CSRF cookie", () => {
  assert.equal(csrfFromCookie("other=private; antnest_csrf=csrf%3Dvalue; ignored=secret"), "csrf=value");
  assert.equal(csrfFromCookie("other=private"), "");
});

test("prefers Secure CSRF delivery over a planted legacy cookie", () => {
  for (const cookie of [
    "__Host-antnest_csrf=bound-token",
    "antnest_csrf=planted; __Host-antnest_csrf=bound-token",
    "__Host-antnest_csrf=bound-token; antnest_csrf=planted",
  ]) assert.equal(csrfFromCookie(cookie), "bound-token");
});

test("ambiguous or malformed delivery never falls back to a legacy value", () => {
  for (const cookie of [
    "__Host-antnest_csrf=; antnest_csrf=legacy",
    "__Host-antnest_csrf=%zz; antnest_csrf=legacy",
    "__Host-antnest_csrf=first; __Host-antnest_csrf=second; antnest_csrf=legacy",
    "__Host-antnest_csrf =first; __Host-antnest_csrf=second",
    "antnest_csrf=first; antnest_csrf=second",
    "antnest_csrf=%zz",
  ]) assert.equal(csrfFromCookie(cookie), "");
});
