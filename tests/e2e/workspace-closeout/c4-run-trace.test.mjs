import assert from "node:assert/strict";
import test from "node:test";
import { c4RunTraceFixture } from "./c4-run-trace.fixture.mjs";
import { traceTopology } from "../observability/trace-tree.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const url = new URL("./c4-run-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (f) => {
  assert.equal(typeof implementation.inspectC4RunTrace, "function");
  return implementation.inspectC4RunTrace(f.trace, f.expected, [], f);
};
test("C4 audio rejection retains its original failure when the optional catalog refresh is skipped", () => {
  const f = c4RunTraceFixture("unsupported-audio"),
    tree = traceTopology(f.trace);
  f.trace.spans = f.trace.spans.filter(
    (span) => !tree.chain(span).includes(f.post.read),
  );
  const original = structuredClone(f.trace),
    result = inspect(f);
  assert.equal(result.runtime_information_reads, 1);
  assert.equal(result.post_prompt_information_reads, 0);
  assert.equal(result.local_failures, 1);
  assert.equal(result.owned_error_spans.length, 3);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(f.trace, original);
  setTag(f.run, "error.type", "unrelated");
  assert.throws(() => inspect(f));
});
for (const suffix of [
  "write",
  "read",
  "attachments",
  "unsupported-audio",
  "approve",
  "hold-cancel",
  "after-cancel",
  "hold-offline",
  "hold-close",
  "after-rebuild",
  "mobile",
])
  test(`C4 owns the original ${suffix} Bridge Run, complete Runtime exchanges and Provider inventory`, () => {
    const f = c4RunTraceFixture(suffix),
      original = structuredClone(f.trace),
      result = inspect(f);
    assert.equal(result.run_id, f.expected.runId);
    assert.equal(result.provider_requests, f.expected.requests.length);
    assert.equal(result.runtime_tool_calls, f.expected.toolName ? 1 : 0);
    assert.equal(result.persistence, true);
    assert.deepEqual(f.trace, original);
    if (suffix === "unsupported-audio") {
      assert.equal(result.local_failures, 1);
      assert.equal(result.owned_error_spans.length, 3);
      assert(
        result.owned_error_spans.every(
          (claim) => claim.reason === "multimodal-model-unsupported-content",
        ),
      );
    }
  });
for (const [name, suffix, change] of [
  [
    "duplicate audio error diagnostic",
    "unsupported-audio",
    (f) => f.run.tags.push({ key: "error.type", value: "unrelated" }),
  ],
  [
    "foreign Run Runtime revision",
    "attachments",
    (f) => f.set(f.run, "antnest.runtime.revision", "other"),
  ],
  [
    "foreign Run execution revision",
    "attachments",
    (f) => f.set(f.run, "antnest.execution.revision", "other"),
  ],
  [
    "audio finish before model execution",
    "unsupported-audio",
    (f) => {
      f.finish.startTime = f.run.startTime + 1;
    },
  ],
  [
    "unknown cancellation outside the observed Run",
    "hold-cancel",
    (f) => f.set(f.request, "antnest.outcome", "cancelled"),
  ],
  [
    "wrong Bridge Agent",
    "attachments",
    (f) => f.set(f.request, "antnest.agent.id", "other"),
  ],
  ["wrong Run", "attachments", (f) => f.set(f.run, "antnest.run.id", "other")],
  [
    "wrong Runtime binding",
    "attachments",
    (f) => f.set(f.models[0], "antnest.runtime.execution_id", "other"),
  ],
  [
    "wrong model",
    "attachments",
    (f) => f.set(f.models[0], "model.name", "other"),
  ],
  [
    "missing Run closure",
    "attachments",
    (f) => {
      f.trace.spans = f.trace.spans.filter((span) => span !== f.finish);
    },
  ],
  [
    "abbreviated finish CTE",
    "attachments",
    (f) =>
      f.set(
        f.finish,
        "db.query.text",
        "WITH finished AS (UPDATE runs SET state=$1) SELECT * FROM finished",
      ),
  ],
  [
    "missing Runtime information",
    "attachments",
    (f) => {
      f.trace.spans = f.trace.spans.filter(
        (span) => span.operationName !== "mcp.runtime.info.read",
      );
    },
  ],
  [
    "failed Tool result",
    "read",
    (f) =>
      f.set(
        f.trace.spans.find((span) => span.operationName === "mcp.tools.call"),
        "antnest.mcp.tool_result.outcome",
        "tool_error",
      ),
  ],
  [
    "wrong Tool",
    "read",
    (f) =>
      f.set(
        f.trace.spans.find((span) => span.operationName === "mcp.tools.call"),
        "tool.name",
        "bash",
      ),
  ],
  [
    "wrong audio error",
    "unsupported-audio",
    (f) => f.set(f.models[0], "error.code", "model_unavailable"),
  ],
  [
    "audio Provider execution",
    "unsupported-audio",
    (f) => {
      f.expected.requests.push({
        phase: f.expected.phase,
        stage: "reply",
        trace_id: f.trace.traceID,
        model_span_id: "invented",
      });
    },
  ],
  [
    "missing original page receipt",
    "unsupported-audio",
    (f) => {
      delete f.expected.receipt;
    },
  ],
  ["unknown error", "attachments", (f) => f.set(f.finish, "error", true)],
  [
    "unobserved cancellation",
    "hold-cancel",
    (f) => {
      delete f.expected.requests[0].disconnected;
    },
  ],
])
  test(`C4 rejects ${name}`, () => {
    const f = c4RunTraceFixture(suffix);
    change(f);
    assert.equal(typeof implementation.inspectC4RunTrace, "function");
    assert.throws(() => inspect(f));
  });

for (const suffix of [
  "attachments",
  "read",
  "unsupported-audio",
  "hold-cancel",
])
  test(`C4 retains owned Runtime cleanup diagnostics for ${suffix}`, () => {
    const f = c4RunTraceFixture(suffix, { cleanup: true }),
      raw = structuredClone(f.trace),
      result = inspect(f);
    assert(result.neutral_diagnostics.length >= 2);
    assert(result.error_spans >= 1);
    assert.equal(result.strict_trace, "failed");
    assert.deepEqual(f.trace, raw);
  });
