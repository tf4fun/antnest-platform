import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { writeDevelopmentJSON } from "../../support/development-configuration.mjs";
import {
  inspectChatTrace,
  inspectChatTraceTopology,
} from "../workspace-closeout/chat-trace.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";

export function reviewDevelopmentChatTrace(trace, expected) {
  expected = { ...expected, bridge: true };
  const report = inspectChatTraceTopology(trace, expected);
  let strict = "passed";
  try {
    inspectChatTrace(trace, expected);
  } catch (error) {
    assert.equal(
      error.message.split("\n")[0],
      "Jaeger span warnings require review",
    );
    strict = "failed: Jaeger span warnings require review";
  }
  const warnings = [
    ...new Set([
      ...(trace.warnings ?? []),
      ...trace.spans.flatMap((span) => span.warnings ?? []),
    ]),
  ];
  assert(
    warnings.every((warning) =>
      warning.startsWith("clock skew adjustment disabled"),
    ),
  );
  const tree = traceTopology(trace);
  const anomalies = trace.spans.flatMap((span) => {
    const parent = tree.parent(span);
    if (!parent || !["client", "producer"].includes(tag(parent, "span.kind")))
      return [];
    const startDelta = span.startTime - parent.startTime;
    const endDelta =
      parent.startTime + parent.duration - (span.startTime + span.duration);
    if (startDelta >= 0 && endDelta >= 0) return [];
    return [
      {
        service: tree.service(span),
        operation: span.operationName,
        span: span.spanID,
        parent: parent.spanID,
        parent_service: tree.service(parent),
        start_delta_us: startDelta,
        end_delta_us: endDelta,
        child_start_us: span.startTime,
        parent_start_us: parent.startTime,
      },
    ];
  });
  return {
    ...report,
    diagnostics: undefined,
    strict,
    warning_messages: warnings,
    timestamp_anomalies: anomalies,
  };
}

export async function collectDevelopmentChatTraces(
  { jaeger, sessionId, receipts, operations, output, secrets, signal },
  {
    search = searchJaegerTraces,
    wait = (ms, signal) => delay(ms, undefined, { signal }),
  } = {},
) {
  assert.equal(
    receipts.length,
    3,
    "three original Development Prompt receipts required",
  );
  assert.equal(operations.length, 3);
  assert.equal(
    new Set(receipts.map((row) => row.traceID)).size,
    3,
    "duplicate Development Prompt Trace",
  );
  assert.equal(new Set(operations.map((row) => row.operationId)).size, 3);
  assert.equal(new Set(operations.map((row) => row.runId)).size, 3);
  for (const [index, receipt] of receipts.entries()) {
    assert.match(receipt.traceID, /^(?!0{32}$)[a-f0-9]{32}$/u);
    assert.equal(receipt.sessionId, sessionId);
    assert.equal(receipt.agentId, receipts[0].agentId);
    assert.equal(receipt.body.operationId, receipt.request.body.intentId);
    assert.equal(operations[index].operationId, receipt.body.operationId);
    assert.equal(operations[index].sessionId, sessionId);
    assert.equal(operations[index].phase, "completed");
    assert.equal(operations[index].acceptance, "acp");
    assert.equal(operations[index].stopReason, "end_turn");
  }
  signal?.throwIfAborted();
  await wait(6000, signal);
  const query = new URLSearchParams({
    service: "agent-acp-service",
    limit: "20",
    lookback: "1h",
    tags: JSON.stringify({
      "rpc.method": "session/prompt",
      "antnest.session.id": sessionId,
    }),
  });
  const timeout = AbortSignal.timeout(10000);
  const data = await search(jaeger, query, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  writeDevelopmentJSON({ output }, "chat-traces.private.json", data);
  assert.equal(data.length, 3, "expected greeting and two Tool prompts");
  assert.deepEqual(
    data.map((trace) => trace.traceID).sort(),
    receipts.map((row) => row.traceID).sort(),
    "Development Trace did not belong to the observed Prompt",
  );
  const reports = receipts.map((receipt, index) => {
    const trace = data.find((item) => item.traceID === receipt.traceID);
    const report = reviewDevelopmentChatTrace(trace, {
      sessionId,
      secrets,
      requireTools: index > 0,
    });
    const tree = traceTopology(trace);
    const prompt = trace.spans.find(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        tag(span, "rpc.method") === "session/prompt" &&
        tag(span, "span.kind") === "server",
    );
    assert.equal(tag(prompt, "antnest.agent.id"), receipt.agentId);
    const run = trace.spans.find(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        span.operationName === "agent.run",
    );
    assert.equal(
      tag(run, "antnest.run.id"),
      operations[index].runId,
      "Development Trace belongs to another Run",
    );
    return {
      ...report,
      operation_id: operations[index].operationId,
      run_id: operations[index].runId,
    };
  });
  assert(
    reports.filter((report) => report.runtime_calls > 0).length >= 2,
    "both Tool prompts must include Runtime spans",
  );
  signal?.throwIfAborted();
  return reports;
}
