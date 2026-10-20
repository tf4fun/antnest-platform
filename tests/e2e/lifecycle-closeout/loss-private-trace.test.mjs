import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lossPrivateTraceFixture } from "./loss-private-trace.fixture.mjs";
import { inspectPrivateManagedTrace } from "../managed-mcp/request-trace.mjs";

const url = new URL("./loss-private-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (f, requests = []) => {
  assert.equal(typeof implementation.inspectPrivateLossDenial, "function");
  return implementation.inspectPrivateLossDenial(
    f.trace,
    f.expected,
    [],
    requests,
  );
};

test("Loss refusal binds original wire, private connection and exact registered cause without changing raw spans", () => {
  const f = lossPrivateTraceFixture(),
    before = JSON.stringify(f);
  const result = inspect(f);
  assert.equal(result.no_execution, true);
  assert.equal(result.runs, 0);
  assert.equal(result.runtime_tool_calls, 0);
  assert.equal(result.rejection, "agent_unavailable");
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.error_spans, 2);
  assert.deepEqual(
    result.owned_error_spans.map((r) => [r.span_id, r.reason]),
    [
      [f.application.spanID, "loss-unavailable-rejection"],
      [f.request.spanID, "loss-unavailable-rejection"],
    ],
  );
  assert.equal(JSON.stringify(f), before);
  assert.throws(() => inspectPrivateManagedTrace(f.trace, f.expected));
});

for (const [name, mutate] of [
  ["missing wire refusal", (f) => delete f.expected.rejectionReceipt],
  ["retryable refusal", (f) => (f.expected.rejectionReceipt.retryable = true)],
  ["busy refusal", (f) => (f.expected.rejection = "agent_busy")],
  ["foreign Session", (f) => (f.expected.sessionId = "other")],
  ["foreign request", (f) => (f.expected.requestId = "other")],
  ["foreign protocol", (f) => (f.expected.protocolVersion = 2)],
  [
    "closed socket substituted for refusal",
    (f) => (f.expected.closedBeforeResponse = true),
  ],
  [
    "foreign origin",
    (f) => f.field(f.request, "antnest.error.origin_span_id", "other"),
  ],
  ["missing original event", (f) => (f.application.logs = [])],
  [
    "unregistered safe message",
    (f) =>
      f.eventField(
        "antnest.error.message",
        "DomainError: unregistered message omitted",
      ),
  ],
  [
    "unknown application diagnostic",
    (f) =>
      f.field(f.application, "exception.message", "unexpected internal error"),
  ],
  [
    "duplicate application",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.application),
        spanID: "second-application",
      }),
  ],
  ["foreign upgrade", (f) => (f.request.references[0].spanID = "f".repeat(16))],
  [
    "ambiguous upgrade",
    (f) => f.request.references.push(structuredClone(f.request.references[0])),
  ],
  [
    "foreign process",
    (f) =>
      (f.trace.processes[f.request.processID].tags.find(
        (r) => r.key === "process.pid",
      ).value = 99),
  ],
])
  test("Loss refusal rejects " + name, () => {
    const f = lossPrivateTraceFixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const operation of [
  "agent.run",
  "model.complete",
  "HTTP POST model",
  "mcp.tools.call",
  "runtime.mcp.tool",
])
  test("Loss refusal rejects unexpected execution " + operation, () => {
    const f = lossPrivateTraceFixture();
    inspect(f);
    f.trace.spans.push({
      ...structuredClone(f.application),
      spanID: "unexpected-work",
      operationName: operation,
      tags: [],
      logs: [],
    });
    assert.throws(() => inspect(f));
  });
for (const [name, mutate] of [
  [
    "warning log",
    (span) => {
      span.logs = [
        {
          fields: [
            { key: "level", value: "WARN" },
            { key: "event", value: "unowned diagnostic" },
          ],
        },
      ];
    },
  ],
  [
    "RPC error status",
    (span) =>
      span.tags.push({ key: "rpc.response.status_code", value: -32603 }),
  ],
])
  test("Loss refusal rejects an unowned connection " + name, () => {
    const original = lossPrivateTraceFixture();
    for (let i = 0; i < original.connectionTrace.spans.length; i++) {
      const f = lossPrivateTraceFixture();
      inspect(f);
      mutate(f.connectionTrace.spans[i]);
      assert.throws(() => inspect(f));
    }
  });
test("Loss refusal cannot accept Provider requests", () => {
  const f = lossPrivateTraceFixture();
  inspect(f);
  assert.throws(() => inspect(f, [{ trace_id: f.trace.traceID }]));
});

async function collected(t, mutate = () => {}) {
  assert.equal(typeof implementation.collectPrivateLossTrace, "function");
  const f = lossPrivateTraceFixture();
  const directory = mkdtempSync(join(tmpdir(), "loss-private-trace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const expected = { ...f.expected };
  delete expected.connectionTrace;
  delete expected.connectionSpanID;
  let attempts = 0,
    flushed = false;
  const result = await implementation.collectPrivateLossTrace(
    "http://jaeger",
    expected,
    {
      directory,
      attempts: 6,
      wait: async () => {},
      flush: async () => {
        flushed = true;
      },
      async request(address) {
        assert(flushed);
        const path = new URL(address).pathname;
        if (path === "/api/traces/" + f.connectionTrace.traceID) attempts++;
        const state = {
          trace: structuredClone(f.trace),
          connection: structuredClone(f.connectionTrace),
        };
        mutate(state, attempts);
        if (path === "/api/traces/" + f.connectionTrace.traceID)
          return Response.json({ data: [state.connection] });
        if (path === "/api/v3/trace-summaries")
          return Response.json({
            summaries: [{ traceId: state.trace.traceID }],
          });
        assert.equal(path, "/api/traces/" + f.trace.traceID);
        return Response.json({ data: [state.trace] });
      },
    },
  );
  return { f, result, attempts };
}
test("Loss collector retains two raw errors after three identical complete observations", async (t) => {
  const { f, result, attempts } = await collected(t);
  assert.equal(attempts, 3);
  assert.equal(result.raw_error_inventory.length, 2);
  assert.equal(result.diagnostic_inventory_verified, true);
  assert.equal(result.method, "session/prompt");
  assert.equal(result.request_id, f.expected.requestId);
  assert.equal(result.connection_trace_id, f.expected.connectionTraceID);
  assert.equal(result.session_id, f.expected.sessionId);
  const outcome = implementation.lossPrivateOutcome([result]);
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.exit_code, 2);
  assert.equal(outcome.strict_trace, "failed");
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(result.evidence_directory, "request.json"), "utf8"),
    ),
    f.trace,
  );
  const missing = structuredClone(result);
  missing.raw_error_inventory.pop();
  assert.equal(implementation.lossPrivateOutcome([missing]).accepted, false);
});
test("Loss collector cannot settle before an unknown diagnostic arrives on an existing span", async (t) => {
  await assert.rejects(
    collected(t, (state, attempt) => {
      if (attempt >= 2)
        state.trace.spans
          .find((s) => s.spanID === "application")
          .tags.push({
            key: "exception.message",
            value: "late internal failure",
          });
    }),
  );
});
