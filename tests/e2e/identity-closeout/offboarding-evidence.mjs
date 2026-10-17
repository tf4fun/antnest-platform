import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { saveSessionTrace } from "./session-trace.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";

export function assertDisabled(agent, runtime, agentID) {
  assert(
    agent.agent_id === agentID &&
      agent.desired_state === "disabled" &&
      agent.lifecycle_state === "created" &&
      agent.activation_state === "disabled",
    "Agent did not finish Disable",
  );
  assert(
    runtime.agent_id === agentID &&
      runtime.lifecycle_state === "disabled" &&
      runtime.health === "absent" &&
      !runtime.runtime_execution_id &&
      !runtime.mcp_endpoint,
    "Runtime is not independently confirmed disabled/absent",
  );
}

export function failureCategory(error) {
  if (error?.code === "ERR_ASSERTION") return "assertion_failed";
  if (error?.name === "TimeoutError") return "request_timeout";
  return "fixture_or_dependency_failed";
}

export function installFailureBoundary() {
  const fatal = (error) => {
    writeSync(
      2,
      JSON.stringify({
        event: "agent_access_failed",
        reason: failureCategory(error),
      }) + "\n",
    );
    // The coordinating shell owns container/volume cleanup, even on bootstrap failure.
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}

// One revocation disables every Agent the principal owns from a shared source
// Trace; each Agent's Disable is validated without its siblings' subtrees.
function withoutSiblingDisables(trace, agentID) {
  const tree = traceTopology(trace);
  const siblings = trace.spans.filter(
    (s) =>
      tree.service(s) === "agent-controller" &&
      s.operationName === "agent_controller.identity_offboarding.disable" &&
      tag(s, "agent.id") !== agentID,
  );
  if (!siblings.length) return trace;
  return {
    ...trace,
    spans: trace.spans.filter(
      (s) => !tree.chain(s).some((ancestor) => siblings.includes(ancestor)),
    ),
  };
}

export function inspectOwnerRevocation(trace, event, expected) {
  assert(
    event && typeof event.event_id === "string" && event.event_id,
    "original owner revocation event required",
  );
  assert.equal(event.event_type, "agent_owner_revoked");
  assert.equal(event.agent_id, expected.agentID);
  assert.equal(event.trace_id, expected.sourceID);
  assert.equal(trace.traceID, expected.sourceID);
  assert(typeof expected.ownerUserID === "string" && expected.ownerUserID);
  assert.equal(event.data?.owner_user_id, expected.ownerUserID);
  assert.equal(event.data.organization_id, expected.organizationID);
  assert.equal(event.data.reason, expected.reason);
  const tree = traceTopology(trace);
  const schedules = trace.spans.filter(
    (s) =>
      tree.service(s) === "agent-controller" &&
      s.operationName === "agent_controller.identity_offboarding.disable" &&
      tag(s, "agent.id") === expected.agentID,
  );
  assert.equal(schedules.length, 1, "one actual owner Disable required");
  const sequence = tag(schedules[0], "identity.revocation.sequence");
  assert(Number.isSafeInteger(sequence) && sequence > 0);
  assert.equal(
    event.data.identity_revocation_sequence,
    sequence,
    "owner event and Disable sequence differ",
  );
  return structuredClone(event);
}

export function inspectOffboardingTrace(traces, expected, secrets) {
  const source = traces.filter((t) => t.traceID === expected.sourceID);
  assert.equal(source.length, 1, "missing or duplicated source Trace");
  const result = inspectLifecycle(
    withoutSiblingDisables(source[0], expected.agentID),
    {
      kind: "disable",
      offboarding: true,
      traceID: expected.sourceID,
      requestId: expected.requestID,
      agentId: expected.agentID,
    },
    secrets,
  );
  return {
    ...result,
    ...(expected.ownerRevocation
      ? {
          owner_revocation: inspectOwnerRevocation(
            source[0],
            expected.ownerRevocation.event,
            {
              sourceID: expected.sourceID,
              agentID: expected.agentID,
              ...expected.ownerRevocation,
            },
          ),
        }
      : {}),
    source_trace_id: expected.sourceID,
    phases: result.activities.map((a) => a.phase),
    gateway_ancestry: true,
  };
}
export async function verifyOffboardingTrace(base, expected, secrets) {
  return collectTrace(base, expected.sourceID, (trace) => {
    saveSessionTrace(trace);
    return inspectOffboardingTrace([trace], expected, secrets);
  });
}
