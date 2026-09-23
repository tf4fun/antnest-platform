import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export function assertClearedSessionCookies(headers) {
  const cookies = headers.getSetCookie();
  const names = new Set();
  assert(cookies.length === 2, "both session cookies must be cleared");
  for (const cookie of cookies) {
    const [pair] = cookie.split(";");
    const name = pair.slice(0, pair.indexOf("="));
    assert(
      ["antnest_session", "antnest_csrf"].includes(name) &&
        !names.has(name) &&
        pair === `${name}=` &&
        /(?:^|;\s*)Max-Age=0(?:;|$)/.test(cookie),
      "session cookie was not cleared",
    );
    names.add(name);
  }
}

export async function waitForExpiry(
  expiresAt,
  { now = Date.now, wait = delay } = {},
) {
  const remaining = Date.parse(expiresAt) - now();
  assert(
    Number.isFinite(remaining) && remaining > 0 && remaining <= 10000,
    "expected a newly issued short-lived session",
  );
  await wait(remaining + 100);
  assert(now() > Date.parse(expiresAt), "issued deadline has not passed");
}
