import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { saveSessionTrace } from "./session-trace.mjs";

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

export function inspectOffboardingTrace(traces, expected, secrets) {
  const source = traces.filter((t) => t.traceID === expected.sourceID);
  assert.equal(source.length, 1, "missing or duplicated source Trace");
  const result = inspectLifecycle(
    source[0],
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
