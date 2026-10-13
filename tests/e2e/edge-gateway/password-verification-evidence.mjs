import assert from "node:assert/strict";
import { assertNoStore } from "../identity-closeout/support.mjs";

export function assertPasswordRejection(response, code) {
  assert(["credential_busy", "credential_rate_limited"].includes(code));
  const busy = code === "credential_busy";
  assert.equal(response.status, busy ? 503 : 429);
  assert.deepEqual(response.body, {
    code,
    message: busy
      ? "Password verification is busy"
      : "Too many password attempts",
    retryable: true,
  });
  const retry = response.headers.get("retry-after");
  if (busy) assert.equal(retry, "1");
  else assert.match(retry ?? "", /^(?:[1-9]|[1-9][0-9]|[1-8][0-9]{2}|900)$/u);
  assertNoStore(response.headers);
  assert.equal(response.headers.getSetCookie().length, 0);
  return {
    status: response.status,
    code,
    retry_after: retry,
    cookie_writes: 0,
  };
}

export function assertWaitChain(chain, order) {
  const { blocker, first, second } = chain;
  assert(Number.isInteger(blocker) && blocker > 0);
  assert.equal(new Set([blocker, first.pid, second.pid]).size, 3);
  for (const [row, application, marker, predecessor] of [
    [first, order.firstApp, order.firstMarker, blocker],
    [second, order.secondApp, order.secondMarker, first.pid],
  ]) {
    assert(Number.isInteger(row.pid) && row.pid > 0);
    assert.equal(row.application_name, application);
    assert.equal(row.wait_event_type, "Lock");
    assert.equal(row.state, "active");
    assert(row.query.includes(marker), "unexpected blocked statement");
    assert(
      row.blockers.includes(predecessor),
      "missing PostgreSQL blocking edge",
    );
  }
}

export function assertIdentityPeers(a, b) {
  for (const row of [a, b]) {
    assert.match(row.id, /^[a-f0-9]{64}$/u);
    assert.match(row.image, /^sha256:[a-f0-9]{64}$/u);
    assert.match(row.database, /^[a-f0-9]{64}$/u);
    assert(Number.isInteger(row.pid) && row.pid > 0);
    assert(Number.isFinite(Date.parse(row.started_at)));
    assert.equal(row.running, true);
    assert.equal(row.restarts, 0);
  }
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.pid, b.pid);
  assert.equal(a.image, b.image);
  assert.equal(a.database, b.database);
}

export function assertFifthCommit(before, after, targets) {
  const key = (row) => row.scope + ":" + row.key;
  const admitted = new Set(targets.map(key));
  assert.equal(admitted.size, 2);
  assert.equal(
    after.length,
    before.length,
    "rejected sixth attempt created or removed a bucket",
  );
  const actual = new Map(after.map((row) => [key(row), row]));
  assert.equal(actual.size, after.length);
  for (const prior of before) {
    const next = actual.get(key(prior));
    assert(next, "pre-existing bucket disappeared");
    if (!admitted.has(key(prior))) {
      assert.deepEqual(next, prior);
      continue;
    }
    assert.equal(prior.failures, 4);
    assert.equal(next.failures, 5);
    assert.deepEqual(next.window_start, prior.window_start);
    if (prior.scope === "organization") assert.equal(next.locked_until, null);
    else
      assert(
        Number.isFinite(new Date(next.locked_until ?? "invalid").getTime()),
        "fifth failure did not start backoff",
      );
    assert.deepEqual(
      { ...next, failures: prior.failures, locked_until: prior.locked_until },
      prior,
    );
  }
}
