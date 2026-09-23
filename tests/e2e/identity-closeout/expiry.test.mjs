import assert from "node:assert/strict";
import test from "node:test";
import { waitForExpiry, assertClearedSessionCookies } from "./expiry.mjs";

test("cookie expiry evidence requires both cookies with empty values", () => {
  const complete = [
    "antnest_session=; Path=/; Max-Age=0",
    "antnest_csrf=; Path=/; Max-Age=0",
  ];
  const headers = (cookies) => ({ getSetCookie: () => cookies });
  assertClearedSessionCookies(headers(complete));
  for (const cookies of [
    [],
    complete.slice(0, 1),
    complete.slice(1),
    [complete[0], complete[0]],
    [complete[0], "antnest_csrf=still-present; Max-Age=0"],
    [complete[0], "antnest_csrf=; Max-Age=100"],
  ])
    assert.throws(() => assertClearedSessionCookies(headers(cookies)));
});

test("expiry wait uses the issued deadline, not an arbitrary test sleep", async () => {
  let now = Date.parse("2026-09-08T00:00:00Z");
  const expires = new Date(now + 5000).toISOString();
  const waits = [];
  await waitForExpiry(expires, {
    now: () => now,
    wait: async (duration) => {
      waits.push(duration);
      now += duration;
    },
  });
  assert.deepEqual(waits, [5100]);
  assert(now > Date.parse(expires));
});

test("expired, invalid and unexpectedly long issuance cannot manufacture expiry evidence", async () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  for (const value of [
    "invalid",
    new Date(now).toISOString(),
    new Date(now + 3600000).toISOString(),
  ]) {
    await assert.rejects(
      waitForExpiry(value, {
        now: () => now,
        wait: async () => assert.fail("must not wait"),
      }),
    );
  }
});
