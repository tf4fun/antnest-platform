import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeFrames, summarizeSpans } from "./cancel-diagnostics.mjs";

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
