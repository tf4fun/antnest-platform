import assert from "node:assert/strict";

export function assertCheckpoint({ ac, rc, physical }, initial) {
  assert.equal(ac.state, "running");
  assert.equal(ac.phase, "runtime_update");
  assert.equal(ac.runtime_result, null);
  assert(ac.request_id && ac.agent_id && ac.child_request_id);
  assert.equal(rc.request_id, ac.child_request_id);
  assert.equal(rc.agent_id, ac.agent_id);
  assert.equal(rc.state, "running");
  assert.equal(rc.source_revision, ac.source_runtime_revision);
  assert.notEqual(rc.runtime_revision, rc.source_revision);
  assert.equal(physical.agent_id, ac.agent_id);
  assert.equal(physical.generation, rc.target_generation);
  assert.equal(physical.digest, rc.target_spec_digest);
  assert.notEqual(physical.id, initial.id);
  assert.equal(physical.volume, initial.volume);
  assert.equal(physical.running, true);
  assert.equal(physical.healthy, false);
  assert.equal(physical.entered, true);
}

export function assertFrozen(before, after) {
  assert.deepEqual(after.ac, before.ac, "AC changed during kill");
  assert.deepEqual(after.rc, before.rc, "RC changed during kill");
  assert.deepEqual(
    after.physical,
    before.physical,
    "target changed during kill",
  );
}

export function assertRecovery(before, after) {
  for (const field of [
    "request_id",
    "agent_id",
    "target_spec_revision_id",
    "source_runtime_revision",
  ])
    assert.equal(after.ac[field], before.ac[field]);
  assert.equal(after.ac.state, "completed");
  assert(
    Date.parse(after.ac.updated_at) > Date.parse(before.ac.updated_at),
    "completion timestamp did not advance",
  );
  for (const field of [
    "request_id",
    "agent_id",
    "runtime_revision",
    "source_revision",
    "target_generation",
    "target_spec_digest",
  ])
    assert.equal(after.rc[field], before.rc[field]);
  assert.equal(after.rc.state, "completed");
  assert(after.rc.attempt > before.rc.attempt);
  for (const field of [
    "id",
    "agent_id",
    "generation",
    "digest",
    "volume",
    "started_at",
    "restarts",
  ])
    assert.equal(after.physical[field], before.physical[field]);
  assert.equal(after.physical.healthy, true);
  assert.equal(after.publications, 2);
  assert.equal(after.claims, 2);
  assert.equal(after.updated, 1);
}

export function assertKilled(container, id) {
  assert.equal(container.Id, id);
  assert.equal(container.State.Status, "exited");
  assert.equal(container.State.ExitCode, 137);
  assert.equal(container.State.OOMKilled, false);
  assert.equal(container.State.Error, "");
}

export function assertPublishedRuntime(before, binding, status) {
  assert.equal(binding.runtime_revision, before.rc.runtime_revision);
  assert.equal(
    binding.executable_spec_revision_id,
    before.ac.target_spec_revision_id,
  );
  assert.equal(status.agent_id, before.ac.agent_id);
  assert.equal(status.generation, before.rc.target_generation);
  assert.equal(status.status, "ready");
  assert(status.execution_id);
  assert.equal(binding.runtime_execution_id, status.execution_id);
}
