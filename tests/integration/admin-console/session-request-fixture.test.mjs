import assert from "node:assert/strict";
import test from "node:test";
import { assertConsoleSessionPost } from "./session-request-fixture.mjs";

const old = "synthetic-console-session",
  next = "synthetic-console-other-tab",
  rotated = "synthetic-console-rotated";
const headers = (csrf) => ({
  cookie: `antnest_csrf=${csrf}`,
  "x-antnest-csrf-token": csrf,
});
const inspect = (wire, currentHint = next, path = "/api/session/activity") =>
  assertConsoleSessionPost(wire, {
    currentHint,
    path,
    issuedHints: new Set([old, next, rotated]),
  });

for (const current of [old, next, rotated])
  for (const path of [
    "/api/session/activity",
    "/api/session/password",
    "/api/session/sessions/revoke",
  ]) {
    test(`Console fixture admits matching current request ${current} ${path}`, () => {
      assert.equal(inspect(headers(current), current, path), true);
    });
  }
for (const current of [next, rotated])
  test(`an already dispatched activity keeps its own Cookie/header across ${current}`, () => {
    const original = headers(old);
    assert.equal(inspect(original, old), true);
    assert.equal(
      inspect(original, current),
      false,
      "old activity cannot renew the replacement session",
    );
    assert.deepEqual(original, headers(old));
  });
for (const [name, wire, current] of [
  ["missing Cookie", { "x-antnest-csrf-token": next }, next],
  ["missing header", { cookie: `antnest_csrf=${next}` }, next],
  ["empty CSRF", { cookie: "antnest_csrf=", "x-antnest-csrf-token": "" }, ""],
  [
    "duplicate CSRF Cookie",
    {
      cookie: `antnest_csrf=${next}; antnest_csrf=${next}`,
      "x-antnest-csrf-token": next,
    },
    next,
  ],
  [
    "old Cookie with new header",
    { cookie: `antnest_csrf=${old}`, "x-antnest-csrf-token": next },
    next,
  ],
  [
    "new Cookie with old header",
    { cookie: `antnest_csrf=${next}`, "x-antnest-csrf-token": old },
    next,
  ],
  ["unissued delivery", headers("unissued"), "unissued"],
])
  test(`Console fixture rejects ${name}`, () =>
    assert.throws(() => inspect(wire, current)));
for (const path of [
  "/api/session/password",
  "/api/session/sessions/revoke",
  "/api/admin/directory/users/target-user/sessions/revoke",
]) {
  test(`old delivery still cannot perform ${path}`, () =>
    assert.throws(() => inspect(headers(old), next, path)));
}
