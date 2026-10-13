import assert from "node:assert/strict";
import { assertNoStore } from "../identity-closeout/support.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { inspectLoginRefusalTransaction } from "./resolve-cache-recovery-http.mjs";

export function assertHolderFailureCommit(before, after, holderKeys, bounds) {
  const key = (row) => row.scope + ":" + row.key;
  const milliseconds = (value) => {
    const time = new Date(value ?? "invalid").getTime();
    assert(Number.isFinite(time), "invalid database timestamp");
    return time;
  };
  const started = milliseconds(bounds.started_at);
  const completed = milliseconds(bounds.completed_at);
  assert(started <= completed, "database completion precedes admission");
  assert.equal(holderKeys.size, 2);
  assert.equal(new Set(before.map(key)).size, before.length);
  const actual = new Map(after.map((row) => [key(row), row]));
  assert.equal(actual.size, after.length);
  assert.equal(
    after.length,
    before.length,
    "busy or dummy probe changed the bucket set",
  );
  const holders = before.filter((row) => holderKeys.has(key(row)));
  assert.deepEqual(holders.map((row) => row.scope).sort(), [
    "login_account",
    "organization",
  ]);
  let window;
  for (const prior of before) {
    const next = actual.get(key(prior));
    assert(next, "pre-existing attempt bucket disappeared");
    if (!holderKeys.has(key(prior))) {
      assert.deepEqual(next, prior, "busy changed a protected attempt bucket");
      continue;
    }
    assert.equal(prior.failures, 0);
    assert.equal(prior.locked_until, null);
    assert(milliseconds(prior.window_start) <= started);
    assert.equal(
      next.failures,
      1,
      "holder must commit exactly one ordinary failure",
    );
    assert.equal(next.locked_until, null);
    const committed = milliseconds(next.window_start);
    assert(
      started <= committed && committed <= completed,
      "first failure window is outside database time bounds",
    );
    window ??= committed;
    assert.equal(
      committed,
      window,
      "holder buckets must share the failure timestamp",
    );
    assert.deepEqual(
      { ...next, failures: 0, window_start: prior.window_start },
      prior,
    );
  }
  return {
    holder_buckets: holders.length,
    protected_buckets: before.length - holders.length,
    window_start: new Date(window).toISOString(),
    started_at: new Date(started).toISOString(),
    completed_at: new Date(completed).toISOString(),
  };
}

export function passwordIdentityServer(trace, method, status) {
  const tree = traceTopology(trace);
  const servers = trace.spans.filter(
    (s) =>
      tree.service(s) === "identity-service" &&
      tag(s, "span.kind") === "server" &&
      tag(s, "http.route") === `/rpc/identity/${method}`,
  );
  assert.equal(
    servers.length,
    1,
    "one actual Identity password owner required",
  );
  const server = servers[0];
  assert.equal(tag(server, "http.response.status_code"), status);
  return server;
}

export function assertPasswordHolderWindow({ holder, probe, targets }) {
  assert.deepEqual(targets.map((r) => r.method).sort(), [
    "change-local-password",
    "create-local-user",
    "local-login",
  ]);
  const server = passwordIdentityServer(holder, "local-login", 401);
  assert.equal(traceTopology(holder).parent(server), undefined);
  const { sql, credential } = inspectLoginRefusalTransaction(holder, server);
  const firstAfterVerify = sql[sql.indexOf(credential) + 1];
  const instance = (trace, span) =>
    tag(trace.processes[span.processID], "service.instance.id");
  const id = instance(holder, server);
  assert.equal(typeof id, "string");
  assert(id.length > 0, "Identity instance identity missing");
  const inspect = (trace, method) => {
    const owner = passwordIdentityServer(trace, method, 503);
    assert.equal(
      instance(trace, owner),
      id,
      "pressure crossed Identity instances",
    );
    assert.equal(tag(owner, "antnest.error.code"), "credential_busy");
    assert(
      Number.isFinite(owner.startTime) &&
        Number.isFinite(owner.duration) &&
        owner.duration >= 0,
    );
    assert(
      credential.startTime + credential.duration <= owner.startTime &&
        owner.startTime + owner.duration <= firstAfterVerify.startTime,
      "holder Verify did not cover the complete target response",
    );
    return { trace_id: trace.traceID, owner_span_id: owner.spanID };
  };
  assert.equal(
    probe.spans.length,
    1,
    "invalid-namespace KDF probe performed additional work",
  );
  const witness = inspect(probe, "local-login");
  return {
    same_process: true,
    holder_trace_id: holder.traceID,
    credential_span_id: credential.spanID,
    first_after_verify_span_id: firstAfterVerify.spanID,
    probe: witness,
    targets: targets.map(({ trace, method }) => inspect(trace, method)),
  };
}

// This receipt is safe to upload even if status/body validation fails. Never
// copy arbitrary response text, Cookie values, or an exception into it.
export function passwordResponseObservation(route, response) {
  assert(
    Number.isInteger(response.status) &&
      response.status >= 100 &&
      response.status <= 599,
  );
  assert(
    [
      "/api/session/login",
      "/api/session/password",
      "/api/admin/directory/users",
    ].includes(route),
  );
  const trace = response.headers.get("x-antnest-trace-id");
  const retry = response.headers.get("retry-after");
  return {
    route,
    status: response.status,
    trace_id: /^[a-f0-9]{32}$/u.test(trace ?? "") ? trace : null,
    code: [
      "credential_busy",
      "credential_rate_limited",
      "unauthenticated",
      "invalid_argument",
    ].includes(response.body?.code)
      ? response.body.code
      : "unrecognized",
    retry_after: /^[1-9][0-9]{0,2}$/u.test(retry ?? "") ? retry : null,
    cookie_writes: response.headers.getSetCookie().length,
    rejection_valid: false,
    cookies_preserved: false,
    database_preserved: false,
    old_session_live: false,
  };
}

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
