import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./bridge-session-close.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const call = (name, ...args) => {
  assert.equal(typeof implementation[name], "function");
  return implementation[name](...args);
};
function fixture(reason = "revoked") {
  const client = { requests: [{ requestId: "1", method: "session/new" }] };
  const browser = { requests: 0 };
  const stream = {
    evidence: {
      path: "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
      status: 200,
      trace_id: "a".repeat(32),
      set_cookie_count: 0,
      credential_scope: "original-cookie-observation",
      started_at: 100,
      headers_at: 110,
    },
    records: [
      {
        at: 120,
        view: {
          agentId: "agent-1",
          selectedSessionId: "session-1",
          selectedView: {
            agentId: "agent-1",
            sessionId: "session-1",
            turns: [],
          },
        },
      },
    ],
    assertOpen() {
      assert(!this.closure);
    },
    async waitClosed() {
      return this.closure;
    },
    closure: undefined,
  };
  const context = {
    agentId: "agent-1",
    sessionId: "session-1",
    reason,
    expiresAt: reason === "expired" ? 20500 : 60000,
    idleExpiresAt: reason === "expired" ? 20500 : 60000,
    now: () => ({ at: 1000, observed_at_ms: 20000 }),
  };
  return { client, browser, stream, context };
}
function checkpoint(f) {
  return call(
    "bridgeSessionCheckpoint",
    f.browser,
    f.client,
    f.stream,
    f.context,
  );
}
async function finish(f, point) {
  f.stream.closure ??= {
    kind: "remote-end",
    at: 1200,
    observed_at_ms: 20200,
    trace_id: "a".repeat(32),
  };
  return call(
    "expectBridgeSessionClose",
    f.browser,
    f.client,
    f.stream,
    point,
    { now: () => 1100 },
  );
}

for (const reason of ["revoked", "unavailable", "expired"])
  test(`Bridge ${reason} evidence retains the real SSE boundary and untouched private SDK inventory`, async () => {
    const f = fixture(reason),
      point = checkpoint(f);
    const result = await finish(f, point);
    assert.equal(result.transport, "http-sse");
    assert.equal(result.reason, reason);
    assert.equal(result.agentId, "agent-1");
    assert.equal(result.sessionId, "session-1");
    assert.equal(result.traceID, f.stream.evidence.trace_id);
    assert.equal(result.credentialScope, "original-cookie-observation");
    assert.equal(result.localClose, false);
    assert.equal(result.silent, true);
    assert.equal(result.closedAt, 20200);
    assert.deepEqual(result.sdkRequests, point.sdkRequests);
    assert.equal(
      result.closeCode,
      undefined,
      "SSE must not fabricate a WebSocket close code",
    );
    assert.equal(
      result.authorizationCauseVerified,
      false,
      "wire EOF alone does not prove the authority cause",
    );
  });

test("a real transport reset may end SSE without inventing a protocol reason", async () => {
  const f = fixture(),
    point = checkpoint(f);
  f.stream.closure = {
    kind: "transport-end",
    at: 1200,
    observed_at_ms: 20200,
    trace_id: "a".repeat(32),
  };
  assert.equal((await finish(f, point)).closure.kind, "transport-end");
});

for (const kind of ["local-close", "aborted", "invalid-event"])
  test(`${kind} cannot substitute for remote browser revocation`, async () => {
    const f = fixture(),
      point = checkpoint(f);
    f.stream.closure = {
      kind,
      at: 1200,
      observed_at_ms: 20200,
      trace_id: "a".repeat(32),
    };
    await assert.rejects(() => finish(f, point));
  });

test("a silent closure cannot be triggered by an extra SDK method or browser probe", async () => {
  for (const mutate of [
    (f) => f.client.requests.push({ requestId: "2", method: "session/prompt" }),
    (f) => (f.client.requests[0].method = "session/list"),
    (f) => f.browser.requests++,
  ]) {
    const f = fixture(),
      point = checkpoint(f);
    mutate(f);
    await assert.rejects(() => finish(f, point));
  }
});

test("wrong stream, Session, renewed authority and pre-trigger closure are rejected", async () => {
  for (const mutate of [
    (f) => (f.stream.evidence.path = "/api/app/agents/agent-1/v2/acp"),
    (f) => (f.stream.records[0].view.selectedSessionId = "foreign"),
    (f) => (f.stream.records[0].view.selectedView.sessionId = "foreign"),
    (f) => (f.stream.evidence.set_cookie_count = 1),
    (f) => (f.stream.evidence.credential_scope = ""),
    (f) => (f.stream.closure = { kind: "remote-end" }),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => checkpoint(f));
  }
});

test("closure must match the original stream identity and both observation clocks", async () => {
  for (const change of [
    { at: 999 },
    { at: 31001 },
    { observed_at_ms: 19999 },
    { observed_at_ms: 50001 },
  ]) {
    const f = fixture(),
      point = checkpoint(f);
    f.stream.closure = {
      kind: "remote-end",
      at: 1200,
      observed_at_ms: 20200,
      trace_id: "a".repeat(32),
      ...change,
    };
    await assert.rejects(() => finish(f, point));
  }
});

test("a different diagnostic Trace ID cannot reject the original observed stream closure", async () => {
  const f = fixture(),
    point = checkpoint(f);
  f.stream.closure = {
    kind: "remote-end",
    at: 1200,
    observed_at_ms: 20200,
    trace_id: "b".repeat(32),
  };
  const result = await finish(f, point);
  assert.equal(result.localClose, false);
  assert.equal(result.traceDiagnostic, "trace_id_mismatch");
  assert.equal(result.closure.trace_id, "b".repeat(32));
});

test("matching Trace metadata cannot substitute a different stream object", async () => {
  const f = fixture(),
    point = checkpoint(f);
  f.stream = { ...f.stream };
  await assert.rejects(() => finish(f, point));
});

test("the observer retains original deadlines for the raw gate without comparing Identity and client clocks", async () => {
  for (const reason of ["revoked", "unavailable"])
    for (const key of ["expiresAt", "idleExpiresAt"]) {
      const f = fixture(reason);
      f.context[key] = 21000;
      const point = checkpoint(f);
      assert.equal((await finish(f, point)).authorizationCauseVerified, false);
    }
});

test("absolute expiry clock ownership is checked by raw Gateway and CCT evidence", async () => {
  for (const shift of [-300000, 300000]) {
    const f = fixture("expired");
    f.context.now = () => ({ at: 1000, observed_at_ms: 20000 + shift });
    const point = checkpoint(f);
    f.stream.closure = {
      kind: "remote-end",
      at: 1200,
      observed_at_ms: 20200 + shift,
      trace_id: "a".repeat(32),
    };
    assert.equal((await finish(f, point)).authorizationCauseVerified, false);
  }
});

test("an idle-limited Session cannot stand in for an absolute expiry case", async () => {
  const f = fixture("expired"),
    point = checkpoint(f);
  point.idleExpiresAt = point.expiresAt - 1;
  await assert.rejects(() => finish(f, point));
});

test("a recorded timely remote close remains valid when its receipt is read after the deadline", async () => {
  const f = fixture(),
    point = checkpoint(f);
  f.stream.closure = {
    kind: "remote-end",
    at: 1200,
    observed_at_ms: 20200,
    trace_id: "a".repeat(32),
  };
  f.stream.waitClosed = () =>
    assert.fail("already recorded closure must not wait again");
  const result = await call(
    "expectBridgeSessionClose",
    f.browser,
    f.client,
    f.stream,
    point,
    { now: () => 31001 },
  );
  assert.equal(result.closedAt, 20200);
});

test("an open stream with an expired checkpoint never dispatches a probe", async () => {
  const f = fixture(),
    point = checkpoint(f);
  let waited = 0;
  f.stream.waitClosed = async () => {
    waited++;
    throw new Error("fixture");
  };
  await assert.rejects(() =>
    call("expectBridgeSessionClose", f.browser, f.client, f.stream, point, {
      now: () => 31001,
    }),
  );
  assert.equal(waited, 0);
  assert.equal(f.browser.requests, 0);
  assert.equal(f.client.requests.length, 1);
});

const invalidTraceCanary = "PRIVATE-INVALID-TRACE-CANARY";
for (const [label, traceID] of [
  ["missing", undefined],
  ["invalid", invalidTraceCanary],
])
  test(`${label} Trace ID retains the original scoped remote closure without exposing its input`, async () => {
    const f = fixture();
    f.stream.evidence.trace_id = traceID;
    const point = checkpoint(f);
    assert.equal(point.stream.trace_id, undefined);
    assert.equal(point.stream.traceDiagnostic, "missing_or_invalid_trace_id");
    f.stream.closure = {
      kind: "remote-end",
      at: 1200,
      observed_at_ms: 20200,
      trace_id: traceID,
    };
    const result = await finish(f, point);
    assert.equal(result.traceID, undefined);
    assert.equal(result.traceDiagnostic, "missing_or_invalid_trace_id");
    assert.equal(result.closure.trace_id, undefined);
    assert.equal(result.transport, "http-sse");
    assert.equal(result.agentId, "agent-1");
    assert.equal(result.sessionId, "session-1");
    assert.equal(result.credentialScope, "original-cookie-observation");
    assert.equal(result.localClose, false);
    assert.equal(result.silent, true);
    assert.equal(result.authorizationCauseVerified, false);
    assert.equal(result.closedAt, 20200);
    assert.deepEqual(result.sdkRequests, point.sdkRequests);
    assert.equal(f.browser.requests, 0);
    assert.equal(f.client.requests.length, 1);
    assert(!JSON.stringify({ point, result }).includes(invalidTraceCanary));
  });

for (const [label, mutate] of [
  ["local cancellation", (f) => (f.stream.closure.kind = "local-close")],
  [
    "foreign credential scope",
    (f) => (f.stream.evidence.credential_scope = "foreign"),
  ],
  ["late remote closure", (f) => (f.stream.closure.at = 31001)],
])
  test(`a missing Trace ID cannot excuse ${label}`, async () => {
    const f = fixture();
    f.stream.evidence.trace_id = undefined;
    const point = checkpoint(f);
    f.stream.closure = {
      kind: "remote-end",
      at: 1200,
      observed_at_ms: 20200,
      trace_id: undefined,
    };
    mutate(f);
    await assert.rejects(() => finish(f, point));
    assert.equal(f.browser.requests, 0);
    assert.equal(f.client.requests.length, 1);
  });
