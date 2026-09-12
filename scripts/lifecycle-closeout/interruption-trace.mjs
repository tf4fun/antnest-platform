import assert from "node:assert/strict";
import { inspectWorkflow } from "../observability/lifecycle-workflow.mjs";
import { traceTree, tag } from "../observability/trace-tree.mjs";
import { verifyLifecycleTrace } from "./trace.mjs";

export function inspectInterruptedTrace({
  admission,
  requestID,
  agentID,
  killed,
}) {
  assert.equal(killed.request_id, requestID);
  assert.equal(killed.agent_id, agentID);
  assert.equal(killed.phase, "runtime_update");
  const trace = admission;
  const evidence = inspectWorkflow(trace, requestID, {
    kind: "rebuild",
    agentID,
    allowRetries: true,
  });
  const tree = traceTree(trace);
  const update = evidence.activities.find(
    (activity) => activity.name === "lifecycle.runtime_update",
  );
  const call = trace.spans.find(
    (span) =>
      tag(span, "rpc.method") === "update" &&
      tag(span, "antnest.operation.request_id") === killed.child_request_id &&
      tag(span, "http.response.status_code") === 200 &&
      tag(span, "error") !== true &&
      tree.chain(span).some((parent) => parent.spanID === update.span_id),
  );
  assert(call, "recovered update must reuse the durable child request");
  assert(
    trace.spans.some(
      (span) =>
        tree.service(span) === "runtime-controller" &&
        tree.chain(span).includes(call),
    ),
    "recovered Runtime server disconnected",
  );
  return {
    admission_trace: trace.traceID,
    phase_traces: evidence.activities.length - 1,
    recovered_child_request: killed.child_request_id,
    causal_links_verified: true,
  };
}

export async function verifyInterruptedTrace(base, operation, killed, signal) {
  const evidence = await verifyLifecycleTrace(
    base,
    { ...operation, allowRetries: true },
    ["stage3-admin-password", "stage3-model-secret", "update-owner-password"],
    signal,
  );
  const response = await fetch(base + "/api/traces/" + operation.traceID, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const admission = (await response.json()).data?.[0];
  return {
    ...evidence,
    ...inspectInterruptedTrace({ admission, ...operation, killed }),
  };
}
