import assert from "node:assert/strict";
import { scopeLabel } from "./docker.mjs";
import { assertAgentReady } from "../../support/verification/agent-state.mjs";

export function assertOwnedRuntime(container, initial, project) {
  assert.match(project, /^antnest-lifecycle-[a-f0-9]{8}$/);
  assert.equal(container.Id, initial.container.Id);
  assert.equal(container.State.Running, true);
  const labels = container.Config.Labels;
  assert.equal(labels[scopeLabel], project);
  assert.equal(labels["io.antnest.agent-id"], initial.agent.agent_id);
  if (labels["com.docker.compose.project"])
    assert.equal(labels["com.docker.compose.project"], project);
}

export function assertLoss(initial, agent, events, recorded) {
  assert.equal(agent.agent_id, initial.agent.agent_id);
  assert.equal(agent.desired_state, "enabled");
  assert.equal(agent.lifecycle_state, "created");
  assert.equal(agent.activation_state, "enabled");
  assert.equal(agent.runtime_state, "absent");
  assert(!agent.active_operation_request_id);
  assert(!agent.executable_execution_revision && !agent.runtime?.mcp_endpoint);
  assert.equal(
    agent.runtime?.runtime_revision,
    initial.agent.runtime.runtime_revision,
  );
  assert.equal(agent.agent_spec_revision, initial.agent.agent_spec_revision);
  assert.deepEqual(agent.configuration, initial.agent.configuration);
  assert.equal(
    agent.last_successful_execution_revision,
    initial.agent.executable_execution_revision,
  );
  assert.equal(agent.failure_stage, "runtime_observation");
  assert(["runtime_missing", "runtime_exited"].includes(agent.failure_code));
  assert(agent.aggregate_sequence > initial.agent.aggregate_sequence);
  const losses = events.filter(
    (event) => event.event_type === "agent_runtime_missing",
  );
  assert.equal(losses.length, 1, "missing/duplicate loss audit");
  const loss = losses[0];
  assert.equal(loss.agent_id, agent.agent_id);
  assert(
    loss.event_id &&
      Number.isSafeInteger(loss.global_sequence) &&
      loss.global_sequence > 0,
  );
  assert(!loss.operation_request_id && !loss.admission_id);
  assert(recorded, "private loss audit missing");
  for (const field of ["event_id", "global_sequence", "agent_id", "event_type"])
    assert.equal(
      recorded[field],
      loss[field],
      "public/private loss audit mismatch",
    );
  assert(!recorded.operation_request_id && !recorded.admission_id);
  assert.equal(recorded.data.reason, agent.failure_code);
  assert.equal(
    recorded.data.runtime_revision,
    initial.agent.runtime.runtime_revision,
  );
  assert.equal(recorded.data.observation_sequence, 0);
  assert.match(recorded.event_id, /^event_[a-f0-9]{32}$/);
  return recorded;
}

export function assertReplacement(initial, replacement) {
  const agent = replacement.agent;
  assert.equal(agent.agent_id, initial.agent.agent_id);
  assertAgentReady(agent);
  assert.equal(agent.desired_state, "enabled");
  assert(!agent.failure_code && !agent.active_operation_request_id);
  assert(agent.aggregate_sequence > initial.agent.aggregate_sequence);
  assert(agent.executable_execution_revision);
  assert.notEqual(
    agent.executable_execution_revision,
    initial.agent.executable_execution_revision,
  );
  assert.equal(
    agent.last_successful_execution_revision,
    agent.executable_execution_revision,
  );
  assert(agent.runtime?.runtime_revision);
  assert.notEqual(
    agent.runtime.runtime_revision,
    initial.agent.runtime.runtime_revision,
  );
  assert(replacement.container.Id);
  assert.notEqual(replacement.container.Id, initial.container.Id);
  assert.equal(replacement.volume, initial.volume);
  assert.deepEqual(agent.configuration, initial.agent.configuration);
}

export function assertLossDenial(error) {
  assert.equal(error?.code, -32020);
  assert.equal(error.data?.code, "agent_unavailable");
  assert.equal(error.data?.retryable, false);
}

export function assertLossBinding(initial, binding) {
  assert.equal(
    binding.runtime_revision,
    initial.agent.runtime.runtime_revision,
  );
  assert.equal(
    binding.executable_spec_revision_id,
    initial.agent.agent_spec_revision,
  );
  assert.equal(
    binding.last_successful_execution_revision_id,
    initial.agent.executable_execution_revision,
  );
  for (const field of [
    "runtime_execution_id",
    "runtime_mcp_endpoint",
    "executable_execution_revision_id",
  ])
    assert.equal(binding[field], "", `${field} remains executable after loss`);
}

export function assertLossProducer(
  mode,
  initial,
  loss,
  observation,
  inspection,
) {
  assert(["live", "cold"].includes(mode));
  assert(
    Number.isSafeInteger(observation.sequence) && observation.sequence > 0,
  );
  assert.equal(loss.data.observation_sequence, 0);
  assert.equal(
    loss.data.reason,
    mode === "live" ? "runtime_exited" : "runtime_missing",
  );
  assert.equal(observation.agent_id, initial.agent.agent_id);
  assert.equal(
    observation.runtime_revision,
    initial.agent.runtime.runtime_revision,
  );
  assert.equal(
    observation.generation,
    Number(initial.container.Config.Labels["io.antnest.runtime-generation"]),
  );
  assert.equal(
    observation.kind,
    mode === "live" ? "runtime_deleted" : "runtime_missing",
  );
  assert.equal(
    observation.source,
    mode === "live" ? "docker_event" : "platform_reconciliation",
  );
  if (mode === "live")
    assert.equal(observation.platform_resource_id, initial.container.Id);
  assert.equal(inspection.agent_id, initial.agent.agent_id);
  assert.equal(
    inspection.runtime_revision,
    initial.agent.runtime.runtime_revision,
  );
  assert.equal(inspection.lifecycle_state, "provisioned");
  assert.equal(inspection.health, "absent");
  assert(!inspection.mcp_endpoint && !inspection.runtime_execution_id);
}
