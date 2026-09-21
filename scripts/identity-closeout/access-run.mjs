import assert from "node:assert/strict";
import { requestTraceBoundary } from "../acp-commands/trace.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { hasError, timingEvidence } from "../acp-plan/requests.mjs";

export function inspectAccessRun(trace, expected, secrets, requests) {
  const { tree, request, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  const one = (rows, label) => {
    assert.equal(rows.length, 1, `missing or duplicate ${label}`);
    return rows[0];
  };
  const acp = (name) =>
    trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" && s.operationName === name,
    );
  const run = one(acp("agent.run"), "private Run");
  assert(tag(run, "antnest.run.id") && tree.chain(run).includes(request));
  const inside = (s) => tree.chain(s).includes(run);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].phase, expected.phase);
  assert.equal(requests[0].trace_id, trace.traceID);
  const http = one(acp("HTTP POST model"), "Provider HTTP");
  assert.equal(http.spanID, requests[0].model_span_id);
  assert.equal(tag(http, "span.kind"), "client");
  const model = one(acp("model.complete"), "model execution");
  assert.equal(tree.parent(http), model);
  assert(inside(model));
  for (const name of ["mcp.runtime.info", "mcp.tools.list"]) {
    const prep = one(acp(name), name);
    assert(inside(prep));
    assert(
      prep.startTime + prep.duration <= model.startTime,
      "model preceded preparation",
    );
    assert(
      trace.spans.some(
        (s) =>
          tree.service(s) === "antnest-runtime" && tree.chain(s).includes(prep),
      ),
      "missing actual Runtime preparation",
    );
  }
  const finish = one(
    acp("SELECT").filter(
      (s) =>
        inside(s) &&
        tag(s, "span.kind") === "client" &&
        tag(s, "db.system.name") === "postgresql" &&
        /^WITH finished AS \(UPDATE runs\b/i.test(
          (tag(s, "db.query.text") ?? "").replace(/\s+/g, " "),
        ),
    ),
    "durable Run finish",
  );
  for (const s of trace.spans) {
    assert(!hasError(s), "unexpected access Run error");
    assert(
      !["mcp.tools.call", "runtime.mcp.tool"].includes(s.operationName),
      "private reply dispatched a Tool",
    );
    assert(
      !(
        inside(s) &&
        ["agent-controller", "identity-service"].includes(tree.service(s))
      ),
      "Run called management service",
    );
  }
  const timing = timingEvidence(trace, tree, request, forwarded);
  const gap = finish.startTime - model.startTime - model.duration;
  return {
    trace_id: trace.traceID,
    request_id: expected.requestId,
    phase: expected.phase,
    run_id: tag(run, "antnest.run.id"),
    provider_requests: 1,
    persistence: true,
    ...timing,
    strict_trace: gap < 0 ? "failed" : timing.strict_trace,
  };
}
