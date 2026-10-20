import assert from "node:assert/strict";
import test from "node:test";

function fixture() {
  const calls = [];
  const failure = Object.assign(new Error("unsupported audio"), {
    code: -32022,
    data: { code: "model_unsupported_content", retryable: false },
  });
  const receipt = {
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: 1,
    agentId: "agent_12345678",
    connectionTraceID: "1".repeat(32),
    clientSpanID: "2".repeat(16),
    requestId: "3",
    method: "session/prompt",
    sessionId: "session_12345678",
    inputSessionID: "session_12345678",
    outcome: "failed",
    rejectionReceipt: {
      rpcCode: failure.code,
      ...failure.data,
    },
  };
  const client = {
    requestEvidence: [receipt],
    async request(method) {
      calls.push(method);
      if (method === "new") return { sessionId: receipt.sessionId };
      throw failure;
    },
    async closeAndWait() {
      calls.push("connection joined");
    },
  };
  const access = {
    async open() {
      calls.push("open");
      return client;
    },
    async collect(expected) {
      assert.equal(calls.at(-1), "connection joined");
      assert.deepEqual(expected, { ...receipt, kind: "request" });
      assert.equal(expected.traceID, undefined);
      calls.push("collect original request");
      return { trace_id: "4".repeat(32), strict_trace: "failed" };
    },
    async closeAndWait() {
      calls.push("access joined");
    },
  };
  return {
    calls,
    receipt,
    access,
    failure,
    config: { jaeger: "http://127.0.0.1:16686" },
    context: {
      privateAccess: {},
      directory: "/private/evidence",
      agentId: receipt.agentId,
      browser: { accessToken: "original-cookie" },
      principal: { user_id: "original-user" },
      secrets: [],
    },
    createAccess: async (_config, options) => {
      assert.equal(typeof options.collectTrace, "function");
      return access;
    },
  };
}

test("Development rejection selects the RPC Trace from the original WS receipt before exporter shutdown", async () => {
  const { runDevelopmentRejection } = await import("./rejection.mjs");
  const f = fixture();
  const result = await runDevelopmentRejection(f.config, f.context, f);
  assert.equal(result.traceID, "4".repeat(32));
  assert.notEqual(result.traceID, f.receipt.connectionTraceID);
  assert.equal(result.code, "model_unsupported_content");
  assert.deepEqual(result.receipt, f.receipt);
  assert.equal(result.trace.strict_trace, "failed");
  assert.deepEqual(f.calls, [
    "open",
    "new",
    "prompt",
    "connection joined",
    "collect original request",
    "access joined",
  ]);
});

test("Development rejection retains collection and cleanup failures", async () => {
  const { runDevelopmentRejection } = await import("./rejection.mjs");
  const f = fixture();
  const original = new Error("original trace lookup");
  const cleanup = new Error("exporter shutdown");
  f.access.collect = async () => {
    throw original;
  };
  f.access.closeAndWait = async () => {
    throw cleanup;
  };
  await assert.rejects(
    runDevelopmentRejection(f.config, f.context, f),
    (error) => {
      assert.deepEqual(error.errors, [original, cleanup]);
      return true;
    },
  );
});

for (const [name, change] of [
  [
    "foreign Session receipt",
    (f) => {
      f.receipt.sessionId = "session_other";
      f.receipt.inputSessionID = "session_original";
    },
  ],
  [
    "successful receipt",
    (f) => {
      f.receipt.outcome = "succeeded";
    },
  ],
  [
    "different rejection",
    (f) => {
      f.receipt.rejectionReceipt.code = "runtime_unavailable";
    },
  ],
  [
    "connection Trace substituted for RPC",
    (f) => {
      f.access.collect = async () => ({
        trace_id: f.receipt.connectionTraceID,
      });
    },
  ],
])
  test(`Development rejection refuses ${name} and joins access`, async () => {
    const { runDevelopmentRejection } = await import("./rejection.mjs");
    const f = fixture();
    change(f);
    await assert.rejects(runDevelopmentRejection(f.config, f.context, f));
    assert.equal(f.calls.at(-1), "access joined");
  });
