import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelDiagnostics,
  summarizeFrames,
  summarizeSpans,
} from "./cancel-diagnostics.mjs";

const trace = {
  processes: {
    p1: { serviceName: "agent-acp-service" },
    p2: { serviceName: "antnest-runtime" },
  },
  spans: [
    {
      processID: "p2",
      operationName: "executor.run",
      startTime: 3_000_000,
      duration: 12_000_000,
      tags: [
        { key: "executor.exit.classification", value: "canceled" },
        { key: "process.command_args", value: "secret-command" },
      ],
    },
    {
      processID: "p1",
      operationName: "session/cancel",
      startTime: 1_500_000,
      duration: 4_000,
      tags: [
        { key: "rpc.method", value: "session/cancel" },
        { key: "otel.status_code", value: "ERROR" },
        { key: "antnest.error.message", value: "secret-detail" },
      ],
    },
  ],
};

test("span summaries keep only fixed fields, ordered from the cancel time", () => {
  const spans = summarizeSpans(trace, 1_000_000);
  assert.deepEqual(spans, [
    {
      service: "agent-acp-service",
      operation: "session/cancel",
      start_ms: 500,
      duration_ms: 4,
      "rpc.method": "session/cancel",
      "otel.status_code": "ERROR",
    },
    {
      service: "antnest-runtime",
      operation: "executor.run",
      start_ms: 2000,
      duration_ms: 12000,
      "executor.exit.classification": "canceled",
    },
  ]);
  assert(!JSON.stringify(spans).includes("secret"));
});

test("frame summaries keep Tool and state transitions without content", () => {
  const frames = [
    { update: { sessionUpdate: "agent_message_chunk", content: "secret" } },
    {
      update: {
        sessionUpdate: "tool_call_update",
        status: "in_progress",
        content: [{ type: "content", content: { text: "secret" } }],
      },
    },
    {
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "_unresolved",
      },
    },
    { method: "other" },
  ];
  assert.deepEqual(summarizeFrames(frames), [
    { update: "tool_call_update", status: "in_progress" },
    { update: "state_update", state: "idle", stop_reason: "_unresolved" },
  ]);
});

test("diagnostics report a late stop and the prompt and cancel traces", async () => {
  const cancelAt = Date.now() - 10_000;
  let probes = 0;
  const requested = [];
  const fetchJSON = async (url) => {
    requested.push(url);
    if (url === "http://model/status")
      return { requests: [{ phase: "v2-bash-cancel", trace_id: "t1" }] };
    if (url === "http://jaeger/api/traces/t1") return { data: [trace] };
    assert.match(url, /^http:\/\/jaeger\/api\/traces\?/);
    const query = new URL(url).searchParams;
    assert.equal(query.get("service"), "agent-acp-service");
    assert.deepEqual(JSON.parse(query.get("tags")), {
      "rpc.method": "session/cancel",
    });
    return { data: [trace] };
  };
  const result = await cancelDiagnostics({
    jaeger: "http://jaeger",
    model: "http://model",
    phase: "v2-bash-cancel",
    cancelAt,
    frames: [],
    stopped: async () => ++probes === 2,
    lateBudgetMs: 5_000,
    pollMs: 1,
    fetchJSON,
  });
  assert.equal(result.diagnostic, "cancel_timeout");
  assert(result.stopped_after_ms >= 10_000);
  assert.equal(result.traces.length, 2);
  assert.deepEqual(
    result.traces.map(({ kind }) => kind),
    ["prompt", "cancel"],
  );
  assert.equal(result.traces[0].spans.length, 2);
  assert.equal(requested.length, 3);
});

test("diagnostic failures are reported, not thrown", async () => {
  const result = await cancelDiagnostics({
    jaeger: "http://jaeger",
    model: "http://model",
    phase: "v2-bash-cancel",
    cancelAt: Date.now(),
    frames: [],
    stopped: async () => {
      throw new Error("probe failed");
    },
    lateBudgetMs: 5,
    pollMs: 1,
    fetchJSON: async () => {
      throw new Error("unreachable");
    },
  });
  assert.equal(result.stopped_after_ms, null);
  assert.deepEqual(
    result.errors.map(({ step }) => step),
    ["late_stop", "prompt_trace", "cancel_trace"],
  );
});
