import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertDisplayReadHeaders,
  observeDisplayRejection,
} from "./organization-freshness-client.mjs";

test("actual SSR private/no-store policy is admitted while JSON retains its exact no-store policy", () => {
  for (const surface of ["session", "bootstrap", "ssr"]) {
    const value = surface === "ssr" ? "private, no-store" : "no-store";
    const headers = new Headers({ "cache-control": value });
    assert.doesNotThrow(() => assertDisplayReadHeaders(headers, surface));
    headers.set("cache-control", value + ", public");
    assert.throws(() => assertDisplayReadHeaders(headers, surface));
    headers.set("cache-control", value);
    headers.append("set-cookie", "synthetic=changed; Secure; HttpOnly");
    assert.throws(() => assertDisplayReadHeaders(headers, surface));
  }
  assert.throws(() =>
    assertDisplayReadHeaders(
      new Headers({ "cache-control": "no-store" }),
      "ssr",
    ),
  );
  assert.throws(() =>
    assertDisplayReadHeaders(
      new Headers({ "cache-control": "private, no-store" }),
      "session",
    ),
  );
});

test("membership rejection observes bounded 200-to-401 convergence with real request identities", async () => {
  let clock = 100;
  const saved = [];
  const result = await observeDisplayRejection({
    committedMS: 100,
    ttlMS: 1000,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    record: (item) => saved.push(structuredClone(item)),
    request: async () => ({
      status: clock < 300 ? 200 : 401,
      traceID: clock.toString(16).padStart(32, "0"),
    }),
  });
  assert.deepEqual(
    result.map((r) => r.status),
    [200, 200, 401],
  );
  assert.equal(saved.length, 3);
});

test("membership rejection fails on continued admission after TTL or an unrelated HTTP failure", async () => {
  for (const status of [200, 503]) {
    let clock = 0;
    await assert.rejects(
      observeDisplayRejection({
        committedMS: 0,
        ttlMS: 200,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
        request: async () => ({
          status,
          traceID: clock.toString(16).padStart(32, "0"),
        }),
      }),
    );
  }
});

test("a pre-deadline read may complete late before the next read rejects", async () => {
  let clock = 150,
    calls = 0;
  const result = await observeDisplayRejection({
    committedMS: 0,
    ttlMS: 200,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    request: async () => {
      clock = 250;
      return {
        status: ++calls === 1 ? 200 : 401,
        traceID: calls.toString(16).padStart(32, "0"),
      };
    },
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].startedMS, 150);
  assert.equal(result[1].status, 401);
});
