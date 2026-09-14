import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export function agentReady(agent) {
  return (
    agent.lifecycle_state === "created" &&
    agent.activation_state === "enabled" &&
    agent.desired_state === "enabled" &&
    agent.runtime_state === "available" &&
    Boolean(
      agent.executable_execution_revision && agent.runtime?.runtime_revision,
    ) &&
    !agent.active_operation_request_id
  );
}

export function assertAgentReady(agent) {
  assert(
    agentReady(agent),
    "Agent has no currently executable Runtime binding",
  );
}

export function assertAgentDisabled(agent) {
  assert.equal(agent.lifecycle_state, "created");
  assert.equal(agent.activation_state, "disabled");
  assert.equal(agent.desired_state, "disabled");
  assert(!agent.executable_execution_revision);
}

export function assertAgentDeleted(agent) {
  assert.equal(agent.lifecycle_state, "deleted");
  assert.equal(agent.desired_state, "deleted");
  assert.equal(agent.runtime_state, "absent");
  assert(!agent.activation_state);
  assert(!agent.agent_spec_revision);
  assert(!agent.configuration);
  assert(!agent.executable_execution_revision);
  assert(!agent.active_operation_request_id);
  assert(!agent.runtime?.runtime_revision);
  assert(!agent.runtime?.runtime_execution_id);
  assert(!agent.runtime?.mcp_endpoint);
}

export async function waitForAgentReady(read, signal) {
  const deadline = Date.now() + 120000;
  let agent;
  do {
    signal?.throwIfAborted();
    agent = await read();
    if (agentReady(agent)) return agent;
    await delay(250, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error(
    `Agent readiness timed out: ${agent?.runtime_state} (${agent?.runtime_reason ?? "no observation"})`,
  );
}
