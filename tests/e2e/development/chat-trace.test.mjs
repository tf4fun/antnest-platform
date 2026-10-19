import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentId,
  sessionId,
  bridgeChatTrace,
  chatTrace,
} from "../../support/fixtures/development-read-only.mjs";

const url = new URL("./chat-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture(t) {
  const output = mkdtempSync(join(tmpdir(), "antnest-development-chat-trace-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const traces = [bridgeChatTrace(1), bridgeChatTrace(2), bridgeChatTrace(3)];
  const receipts = traces.map((trace, index) => ({
    traceID: trace.traceID,
    agentId,
    sessionId,
    body: {
      operationId: `operation-${index}`,
      acceptance: "bridge",
      phase: "dispatching",
    },
    request: { body: { intentId: `operation-${index}` } },
  }));
  const operations = traces.map((_, index) => ({
    operationId: `operation-${index}`,
    sessionId,
    runId: `run-${index + 1}`,
    phase: "completed",
    acceptance: "acp",
    stopReason: "end_turn",
  }));
  const f = { output, traces, receipts, operations };
  f.run = () => {
    assert.equal(
      typeof implementation.collectDevelopmentChatTraces,
      "function",
    );
    return implementation.collectDevelopmentChatTraces(
      {
        jaeger: "http://127.0.0.1:16686",
        sessionId,
        output,
        receipts,
        operations,
        secrets: ["private-canary"],
      },
      {
        wait: async () => {},
        search: async (base, query) => {
          assert.equal(base, "http://127.0.0.1:16686");
          assert.equal(query.get("limit"), "20");
          assert.equal(query.get("lookback"), "1h");
          assert.deepEqual(JSON.parse(query.get("tags")), {
            "rpc.method": "session/prompt",
            "antnest.session.id": sessionId,
          });
          return traces;
        },
      },
    );
  };
  return f;
}

test("Development collects three original Bridge Prompt Traces and binds their completed Runs", async (t) => {
  const f = fixture(t),
    reports = await f.run();
  assert.equal(reports.length, 3);
  assert.deepEqual(
    reports.map((row) => row.run_id),
    ["run-1", "run-2", "run-3"],
  );
  assert(
    reports.every((row) => row.runtime_calls === 1 && row.strict === "passed"),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.output, "chat-traces.private.json"))),
    f.traces,
  );
});
test("Development preserves raw clock warnings and strict failure without changing Trace sources", async (t) => {
  const f = fixture(t);
  f.traces[0].spans[2].warnings = ["clock skew adjustment disabled; fixture"];
  const before = JSON.stringify(f.traces),
    reports = await f.run();
  assert.match(reports[0].strict, /^failed/);
  assert.deepEqual(reports[0].warning_messages, f.traces[0].spans[2].warnings);
  assert.equal(JSON.stringify(f.traces), before);
});
for (const [name, change] of [
  [
    "retired Gateway topology",
    (f) => {
      f.traces[0] = chatTrace(1);
    },
  ],
  [
    "unobserved Prompt Trace",
    (f) => {
      f.traces[0] = bridgeChatTrace(4);
    },
  ],
  [
    "duplicate original receipt",
    (f) => {
      f.receipts[1] = f.receipts[0];
    },
  ],
  [
    "foreign receipt Session",
    (f) => {
      f.receipts[0].sessionId = "foreign";
    },
  ],
  [
    "foreign completed operation",
    (f) => {
      f.operations[0].operationId = "foreign";
    },
  ],
  [
    "foreign Run",
    (f) => {
      f.operations[0].runId = "foreign";
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.receipts[0].agentId = "foreign";
    },
  ],
  [
    "failed operation",
    (f) => {
      f.operations[0].phase = "failed";
    },
  ],
  [
    "unreviewed diagnostic",
    (f) => {
      f.traces[0].warnings = ["missing parent"];
    },
  ],
  [
    "internal error",
    (f) => {
      f.traces[0].spans[3].tags.push({ key: "error", value: true });
    },
  ],
  [
    "insufficient Runtime Traces",
    (f) => {
      for (const trace of f.traces.slice(0, 2))
        trace.spans = trace.spans.filter(
          (span) => !["mcp", "runtime"].includes(span.spanID),
        );
    },
  ],
])
  test(`Development rejects ${name}`, async (t) => {
    const f = fixture(t);
    change(f);
    await assert.rejects(f.run());
  });
