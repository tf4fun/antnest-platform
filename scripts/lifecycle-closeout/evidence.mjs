import assert from "node:assert/strict";
import { inspectWorkflow } from "../observability/lifecycle-workflow.mjs";
export function inspectLifecycle({
  admission,
  requestID,
  agentID,
  kind,
  outcome = "completed",
  allowRetries = false,
}) {
  const evidence = inspectWorkflow(admission, requestID, {
    kind,
    outcome,
    agentID,
    allowRetries,
  });
  const stages = evidence.activities.slice(1);
  return {
    kind,
    outcome,
    request_id: requestID,
    admission_trace: admission.traceID,
    executor: "temporal",
    phases: stages.map((activity) => activity.name.replace("lifecycle.", "")),
    activity_spans: stages.map((activity) => ({
      trace_id: admission.traceID,
      span_id: activity.span_id,
      phase: activity.name.replace("lifecycle.", ""),
      attempt: activity.attempts,
    })),
    phase_traces: stages.length,
    causal_links_verified: true,
  };
}
export function assertEventPage(page, after, seen, agentID) {
  assert(Array.isArray(page.events), "event list missing");
  let cursor = after;
  for (const event of page.events) {
    assert(
      Number.isSafeInteger(event.global_sequence) &&
        event.global_sequence > cursor,
      "global cursor not exclusive/increasing",
    );
    assert.equal(event.agent_id, agentID);
    assert(
      event.event_id && !seen.has(event.event_id),
      "duplicate/missing event identity",
    );
    seen.add(event.event_id);
    cursor = event.global_sequence;
  }
  assert.equal(page.next_sequence, cursor, "incorrect next global cursor");
  return cursor;
}
