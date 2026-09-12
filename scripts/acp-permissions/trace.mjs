import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

export function inspectPermissionTrace(trace, requests) {
  assert(trace?.spans?.length, "missing permission trace");
  const spans = new Map(trace.spans.map((span) => [span.spanID, span]));
  const service = (span) => trace.processes[span.processID]?.serviceName;
  const tag = (span, key) => span.tags?.find((item) => item.key === key)?.value;
  const ancestors = (span) => {
    const chain = [],
      seen = new Set();
    while (span && !seen.has(span.spanID)) {
      chain.push(span);
      seen.add(span.spanID);
      span = spans.get(
        span.references?.find((ref) => ref.refType === "CHILD_OF")?.spanID,
      );
    }
    return chain;
  };
  const owned = (operation) =>
    trace.spans.filter(
      (span) =>
        service(span) === "agent-acp-service" &&
        span.operationName === operation,
    );
  const models = owned("model.complete"),
    runs = owned("agent.run"),
    calls = owned("mcp.tools.call"),
    waits = owned("acp.permission.wait");
  assert.equal(models.length, requests.length, "unaccounted model calls");
  const phases = [...new Set(requests.map((item) => item.phase))];
  assert.equal(runs.length, phases.length);
  for (const span of trace.spans.filter((span) =>
    ["agent-acp-service", "antnest-runtime"].includes(service(span)),
  ))
    assert(
      ancestors(span).some((parent) => service(parent) === "edge-gateway"),
      `no Gateway ancestor: ${span.operationName}`,
    );
  for (const phase of phases) {
    const observed = requests.filter((item) => item.phase === phase);
    const first = models.find(
      (span) => span.spanID === observed[0].model_span_id,
    );
    assert(first);
    const admission = tag(first, "admission.id");
    const run = runs.find((span) => tag(span, "admission.id") === admission);
    assert(run);
    for (const item of observed) {
      const model = models.find((span) => span.spanID === item.model_span_id);
      assert(model);
      assert(ancestors(model).includes(run));
      assert.equal(
        tag(model, "model.purpose"),
        item.stage === "judge" ? "permission_judge" : "response",
      );
    }
    const dispatched = calls.filter(
      (span) => tag(span, "admission.id") === admission,
    );
    const expected = /deny|reject|cancel|chat/.test(phase) ? 0 : 1;
    assert.equal(
      dispatched.length,
      expected,
      `incorrect Runtime effect count: ${phase}`,
    );
    const waiting = waits.filter(
      (span) => tag(span, "run.id") === tag(run, "run.id"),
    );
    if (/once|deny|always$|reject$|cancel|reconnect|judge-ask/.test(phase))
      assert.equal(waiting.length, 1, `missing approval wait: ${phase}`);
    for (const call of dispatched) {
      assert(ancestors(call).includes(run));
      for (const wait of waiting)
        assert(
          wait.startTime + wait.duration <= call.startTime,
          "Tool preceded approval",
        );
      assert(
        trace.spans.some(
          (span) =>
            service(span) === "antnest-runtime" &&
            ancestors(span).includes(call),
        ),
        "missing Runtime execution child",
      );
    }
  }
  assertSecretFree(JSON.stringify(trace), [
    "permission-model-test",
    "read_only",
    "permission-owner-password",
  ]);
  return {
    trace_id: trace.traceID,
    runs: runs.length,
    model_requests: models.length,
    permission_waits: waits.length,
    runtime_calls: calls.length,
    gateway_ancestry: true,
  };
}
