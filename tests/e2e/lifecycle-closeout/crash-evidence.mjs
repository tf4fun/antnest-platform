import assert from "node:assert/strict";
import { runtimeCommandId } from "../stage3-base/contracts.mjs";

export function assertCrashCheckpoint(before, initial, phase) {
  const { ac, rc, physical, gate } = before;
  assert(["before-create", "after-start"].includes(phase));
  assert.equal(ac.state, "running");
  assert.equal(ac.phase, "runtime_update");
  assert.equal(ac.runtime_result, null);
  assert.equal(rc.request_id, ac.child_request_id);
  assert.equal(
    rc.request_id,
    runtimeCommandId(ac.request_id, "runtime_update"),
  );
  assert.equal(rc.agent_id, ac.agent_id);
  assert.equal(rc.kind, "update_runtime");
  assert.equal(rc.state, "running");
  assert.notEqual(rc.effect, "completed");
  assert.equal(rc.attempt, 1);
  assert.equal(rc.source_revision, ac.source_runtime_revision);
  assert(rc.runtime_revision && rc.request_digest && rc.target_spec_digest);
  assert.notEqual(rc.runtime_revision, rc.source_revision);
  assert.equal(rc.source_generation, 1);
  assert.equal(rc.target_generation, 2);
  assert.equal(gate.phase, phase);
  assert.equal(gate.delivery, "held");
  if (phase === "before-create")
    assert.deepEqual(physical, { ids: [], volumes: [initial.volume] });
  else {
    assert.equal(physical.id, gate.target_id);
    assert.notEqual(physical.id, initial.id);
    assert.equal(physical.running, true);
    assert.equal(physical.volume, initial.volume);
    assert.equal(physical.agent_id, ac.agent_id);
    assert.equal(physical.generation, rc.target_generation);
    assert.equal(physical.digest, rc.target_spec_digest);
  }
  assert.equal(before.claims, 2);
  assert.equal(before.updated, 0);
  assert.equal(before.publications, 1);
}
export function assertCrashRecovery(before, after) {
  for (const key of [
    "request_id",
    "agent_id",
    "target_spec_revision_id",
    "source_runtime_revision",
  ])
    assert.equal(after.ac[key], before.ac[key]);
  assert.equal(after.ac.state, "completed");
  assert.equal(after.ac.phase, "completed");
  for (const key of [
    "request_id",
    "request_digest",
    "kind",
    "agent_id",
    "source_revision",
    "source_generation",
    "source_spec_digest",
    "runtime_revision",
    "target_generation",
    "target_spec_digest",
  ])
    assert.equal(after.rc[key], before.rc[key]);
  assert.equal(after.rc.state, "completed");
  assert.equal(after.rc.effect, "completed");
  assert.equal(after.rc.attempt, before.rc.attempt + 1);
  assert.equal(after.physical.agent_id, before.ac.agent_id);
  assert.equal(after.physical.generation, before.rc.target_generation);
  assert.equal(after.physical.digest, before.rc.target_spec_digest);
  assert.equal(after.physical.running, true);
  if (before.gate.phase === "after-start")
    for (const key of ["id", "volume", "started_at", "restarts"])
      assert.equal(after.physical[key], before.physical[key]);
  else assert.equal(after.physical.volume, before.physical.volumes[0]);
  assert.equal(after.claims, 2);
  assert.equal(after.updated, 1);
  assert.equal(after.publications, 2);
}

// The crash proxy reaches Docker only through its Unix socket and is driven by
// docker exec, so any network attachment would be an unreviewed path.
export function inspectCrashProxyDeployment(rows, config) {
  const service = (row) => row.Config.Labels["com.docker.compose.service"];
  const peers = rows.filter((r) => service(r) === "crash-proxy");
  assert.equal(peers.length, 1);
  const peer = peers[0];
  assert.equal(
    peer.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(peer.State.Health.Status, "healthy");
  assert.deepEqual(peer.HostConfig.PortBindings ?? {}, {});
  assert.equal(peer.HostConfig.NetworkMode, "none");
  assert.deepEqual(Object.keys(peer.NetworkSettings.Networks), ["none"]);
  const rc = rows.find((r) => service(r) === "runtime-controller");
  assert(
    rc.Config.Env.includes("ANTNEST_DOCKER_HOST=unix:///fault/docker.sock"),
  );
  assert.equal(
    rc.Mounts.find((m) => m.Destination === "/fault")?.Name,
    peer.Mounts.find((m) => m.Destination === "/fault")?.Name,
  );
  return peer;
}
