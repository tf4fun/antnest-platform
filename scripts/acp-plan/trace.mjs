import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { caseFor, stepsFor } from "./model.mjs";

export function inspectPlanTrace(trace, requests, secrets = []) {
  assert(trace?.spans?.length, "missing plan execution trace");
  assert(requests?.length, "missing model request correlation");
  const spans = new Map(trace.spans.map((span) => [span.spanID, span]));
  assert.equal(spans.size, trace.spans.length, "duplicate span identity");
  const service = (span) => trace.processes[span.processID]?.serviceName;
  const tag = (span, key) => span.tags?.find((tag) => tag.key === key)?.value;
  const parents = (span) => {
    const result = [],
      seen = new Set();
    while (span && !seen.has(span.spanID)) {
      seen.add(span.spanID);
      result.push(span);
      span = spans.get(
        span.references?.find((ref) => ref.refType === "CHILD_OF")?.spanID,
      );
    }
    return result;
  };
  const acp = (operation) =>
    trace.spans.filter(
      (span) =>
        service(span) === "agent-acp-service" &&
        span.operationName === operation,
    );
  for (const span of trace.spans.filter((span) =>
    ["agent-acp-service", "antnest-runtime"].includes(service(span)),
  ))
    assert(
      parents(span).some((parent) => service(parent) === "edge-gateway"),
      `missing Gateway ancestry: ${span.operationName}`,
    );
  const models = acp("model.complete");
  assert.equal(models.length, requests.length, "unaccounted model requests");
  assert.equal(
    new Set(requests.map((request) => request.model_span_id)).size,
    requests.length,
  );
  const phases = [...new Set(requests.map((request) => request.phase))];
  assert.equal(acp("agent.run").length, phases.length);
  assert.equal(acp("agent_controller.acquire_run").length, phases.length);
  assert.equal(acp("agent_controller.finish_run").length, phases.length);
  const admissions = new Set(),
    runs = [];
  for (const phase of phases) {
    const expected = caseFor(phase);
    const observations = requests.filter((request) => request.phase === phase);
    assert.deepEqual(
      observations.map((request) => request.stage),
      Array.from({ length: stepsFor(phase).length + 1 }, (_, index) => index),
    );
    const observedModels = observations.map((request) => {
      assert.equal(request.trace_id, trace.traceID);
      const model = models.find(
        (span) => span.spanID === request.model_span_id,
      );
      assert(model, "actual model span missing");
      return model;
    });
    const admission = tag(observedModels[0], "admission.id");
    assert(
      admission && !admissions.has(admission),
      "admission missing or reused",
    );
    admissions.add(admission);
    assert(
      observedModels.every((span) => tag(span, "admission.id") === admission),
    );
    const owned = (operation) =>
      acp(operation).filter((span) => tag(span, "admission.id") === admission);
    const run = owned("agent.run");
    assert.equal(run.length, 1);
    const inRun = (span) =>
      parents(span).some((parent) => parent.spanID === run[0].spanID);
    assert(observedModels.every(inRun), "model not under actual Run");
    assert(
      acp("postgres.transaction").some(inRun),
      "missing Run persistence path",
    );
    assert.equal(owned("agent_controller.finish_run").length, 1);
    for (const operation of ["mcp.runtime.info", "mcp.tools.list"]) {
      const prepared = owned(operation);
      assert.equal(prepared.length, 1, "missing fresh Runtime preparation");
      assert(inRun(prepared[0]));
      assert(
        prepared[0].startTime + prepared[0].duration <=
          observedModels[0].startTime,
      );
      assert(
        trace.spans.some(
          (span) =>
            service(span) === "antnest-runtime" &&
            parents(span).some(
              (parent) => parent.spanID === prepared[0].spanID,
            ),
        ),
        "missing Runtime preparation descendant",
      );
    }
    const calls = owned("mcp.tools.call");
    assert.equal(
      calls.length,
      expected.remote,
      "incorrect per-Run remote dispatch count",
    );
    for (const call of calls) {
      assert(inRun(call));
      assert.equal(
        tag(call, "tool.name"),
        "write",
        "local plan forwarded to Runtime",
      );
      const tools = trace.spans.filter(
        (span) =>
          service(span) === "antnest-runtime" &&
          span.operationName === "runtime.mcp.tool" &&
          parents(span).some((parent) => parent.spanID === call.spanID),
      );
      assert.equal(
        tools.length,
        1,
        "actual Runtime Tool descendant missing or duplicated",
      );
    }
    runs.push({
      phase,
      remote_calls: calls.length,
      model_requests: observations.length,
    });
  }
  for (const operation of ["mcp.runtime.info", "mcp.tools.list"])
    assert.equal(acp(operation).length, phases.length);
  const remote = runs.reduce((sum, run) => sum + run.remote_calls, 0);
  assert.equal(acp("mcp.tools.call").length, remote);
  assert.equal(
    trace.spans.filter(
      (span) =>
        service(span) === "antnest-runtime" &&
        span.operationName === "runtime.mcp.tool",
    ).length,
    remote,
  );
  assertSecretFree(JSON.stringify(trace), secrets);
  return {
    trace_id: trace.traceID,
    spans: spans.size,
    runs,
    model_requests: models.length,
    runtime_tool_calls: remote,
    gateway_ancestry: true,
  };
}
