import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

export function inspectNativeTrace(trace, expected, secrets = []) {
  assert(trace?.spans?.length, "trace not exported");
  const spans = new Map(trace.spans.map((s) => [s.spanID, s]));
  assert.equal(spans.size, trace.spans.length, "duplicate span IDs");
  const service = (s) => trace.processes[s.processID]?.serviceName;
  const ancestors = (span) => {
    const result = [],
      seen = new Set();
    while (span) {
      assert(!seen.has(span.spanID), "cyclic ancestry");
      seen.add(span.spanID);
      result.push(span);
      const ref = span.references?.find((r) => r.refType === "CHILD_OF");
      span = ref?.traceID === trace.traceID ? spans.get(ref.spanID) : undefined;
    }
    return result;
  };
  const within = (s, parent) => ancestors(s).includes(parent);
  const named = (name) =>
    trace.spans.filter(
      (s) => service(s) === "agent-acp-service" && s.operationName === name,
    );
  const tag = (s, key) => s.tags?.find((t) => t.key === key)?.value;
  for (const span of trace.spans) {
    assert(service(span), "unknown span process");
    assert(
      !["mcp.tools.call", "runtime.mcp.tool"].includes(span.operationName),
      "unexpected Tool execution",
    );
    if (
      ["agent-acp-service", "agent-controller", "antnest-runtime"].includes(
        service(span),
      )
    )
      assert(
        ancestors(span).some((s) => service(s) === "edge-gateway"),
        `missing Gateway ancestry: ${span.operationName}`,
      );
  }
  const runs = named("agent.run"),
    models = named("model.complete"),
    finishes = named("agent_controller.finish_run");
  for (const method of expected.methods ?? ["acp.session.prompt"])
    assert(named(method).length > 0, `missing ${method}`);
  assert.equal(runs.length, expected.runs, "Run count mismatch");
  assert.equal(
    named("agent_controller.acquire_run").length,
    expected.runs,
    "admission count mismatch",
  );
  assert.equal(finishes.length, expected.runs, "closure count mismatch");
  assert.equal(models.length, expected.runs, "model attempt count mismatch");
  for (const admit of named("agent_controller.acquire_run"))
    assert(
      trace.spans.some(
        (s) => service(s) === "agent-controller" && within(s, admit),
      ),
      "missing Controller admission RPC",
    );
  const admissions = new Set(),
    runIDs = new Set();
  for (const run of runs) {
    const admission = tag(run, "admission.id"),
      id = tag(run, "run.id");
    assert(
      admission && id && !admissions.has(admission) && !runIDs.has(id),
      "invalid Run identity",
    );
    admissions.add(admission);
    runIDs.add(id);
    // Failed model attempts need no message append transaction. Finalization
    // uses one atomic SQL statement, observed as postgres.query by the kernel.
    assert(
      named("postgres.query").some((s) => within(s, run)),
      "missing Run persistence",
    );
    const model = models.filter(
      (s) => within(s, run) && tag(s, "admission.id") === admission,
    );
    assert.equal(model.length, 1, "missing Run-specific model attempt");
    const closure = finishes.filter(
      (s) => within(s, run) && tag(s, "admission.id") === admission,
    );
    assert.equal(closure.length, 1, "missing Run-specific closure");
    const received = expected.modelRequests.some(
      (r) => r.model_span_id === model[0].spanID,
    );
    assert.equal(
      tag(closure[0], "run.terminal_class"),
      received ? "completed" : "failed",
      "wrong Run terminal class",
    );
    assert.equal(
      tag(closure[0], "run.tool_effect_state"),
      "none",
      "unexpected Tool effect",
    );
    if (received)
      assert(
        named("postgres.transaction").some((s) => within(s, run)),
        "missing durable reply",
      );
    assert(
      trace.spans.some(
        (s) => service(s) === "agent-controller" && within(s, closure[0]),
      ),
      "missing Controller closure RPC",
    );
    for (const name of ["mcp.runtime.info", "mcp.tools.list"]) {
      const prepared = named(name).filter(
        (s) => within(s, run) && tag(s, "admission.id") === admission,
      );
      assert.equal(prepared.length, 1, "missing Runtime preparation");
      assert(
        trace.spans.some(
          (s) => service(s) === "antnest-runtime" && within(s, prepared[0]),
        ),
        "missing Runtime descendant",
      );
    }
  }
  const requestIDs = new Set();
  for (const request of expected.modelRequests) {
    assert.equal(request.trace_id, trace.traceID, "wrong Provider trace");
    assert(!requestIDs.has(request.model_span_id), "repeated Provider attempt");
    requestIDs.add(request.model_span_id);
    assert(
      models.includes(spans.get(request.model_span_id)),
      "Provider correlation missing",
    );
  }
  assert.equal(
    models.filter((s) => !requestIDs.has(s.spanID)).length,
    expected.localFailures ?? 0,
    "unexplained model attempts",
  );
  assertSecretFree(JSON.stringify(trace), secrets);
  return {
    trace_id: trace.traceID,
    spans: spans.size,
    runs: runs.length,
    provider_requests: requestIDs.size,
    local_failures: expected.localFailures ?? 0,
    gateway_ancestry: true,
    no_tool_execution: true,
  };
}
