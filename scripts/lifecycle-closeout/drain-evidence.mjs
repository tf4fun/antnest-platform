import assert from "node:assert/strict";

export function assertDrain({
  initial,
  requestID,
  operation,
  agent,
  containers,
  effects,
  attachment,
  settled,
}) {
  assert.equal(operation.kind, "rebuild");
  assert.equal(operation.request_id, requestID);
  assert.equal(operation.state, "running");
  assert.equal(operation.phase, "drain");
  assert.equal(agent.active_operation_request_id, requestID);
  assert.equal(
    agent.executable_execution_revision,
    initial.agent.executable_execution_revision,
  );
  assert.deepEqual(agent.configuration, initial.agent.configuration);
  assert.deepEqual(agent.runtime, initial.agent.runtime);
  assert.deepEqual(
    containers.map((c) => c.Id),
    [initial.container.Id],
  );
  assert.equal(effects, "held\n");
  assert.equal(attachment, "open");
  assert.equal(settled, false);
}

export function assertRebuildDenial(error) {
  assert.equal(error?.code, -32021);
  assert.equal(error.data?.code, "agent_rebuilding");
  assert.equal(error.data?.retryable, true);
}

export function assertControllerStopped(before, stopped, project) {
  assert.equal(stopped.Id, before.Id);
  for (const container of [before, stopped])
    assert.equal(
      container.Config.Labels["com.docker.compose.project"],
      project,
    );
  assert.equal(before.State.Running, true);
  assert.equal(stopped.State.Running, false);
  assert.equal(stopped.State.Status, "exited");
  assert.equal(stopped.State.ExitCode, 0);
  assert.equal(stopped.State.OOMKilled, false);
  assert.equal(stopped.State.Error, "");
  assert(
    Date.parse(stopped.State.FinishedAt) > Date.parse(before.State.StartedAt),
  );
}

export function heldProcessCommand(pid, release = false) {
  assert.match(pid, /^[1-9]\d*$/);
  return `test "$(cat /workspace/.c3-run-started)" = "${pid}" && test ! -e /workspace/.c3-run-release && kill -0 ${pid}${release ? " && touch /workspace/.c3-run-release" : ""}`;
}
