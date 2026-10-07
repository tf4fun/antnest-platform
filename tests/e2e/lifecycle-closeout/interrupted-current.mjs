import assert from "node:assert/strict";
export function assertUpdateReceiptCheckpoint(
  { ac, rc, physical, receipt },
  initial,
) {
  assert.equal(ac.state, "running");
  assert.equal(ac.phase, "runtime_update");
  assert.equal(ac.runtime_result, null);
  assert(ac.request_id && ac.agent_id && ac.child_request_id);
  assert.equal(rc.request_id, ac.child_request_id);
  assert.equal(rc.agent_id, ac.agent_id);
  assert.equal(rc.state, "completed");
  assert.equal(rc.effect, "completed");
  assert.equal(rc.source_revision, ac.source_runtime_revision);
  assert.notEqual(rc.runtime_revision, rc.source_revision);
  assert.equal(receipt.delivery, "held");
  assert.equal(receipt.status, 200);
  assert.equal(receipt.agent_id, ac.agent_id);
  assert.equal(receipt.request_id, rc.request_id);
  assert.equal(receipt.target_revision, rc.runtime_revision);
  assert.equal(physical.agent_id, ac.agent_id);
  assert.equal(physical.generation, rc.target_generation);
  assert.equal(physical.digest, rc.target_spec_digest);
  assert.notEqual(physical.id, initial.id);
  assert.equal(physical.volume, initial.volume);
  assert.equal(physical.running, true);
}
export function assertUpdateReceiptRecovery(before, after) {
  for (const key of [
    "request_id",
    "agent_id",
    "target_spec_revision_id",
    "source_runtime_revision",
  ])
    assert.equal(after.ac[key], before.ac[key]);
  assert.equal(after.ac.state, "completed");
  assert.equal(after.ac.phase, "completed");
  assert.notEqual(after.ac.updated_at, before.ac.updated_at);
  assert.deepEqual(
    after.rc,
    before.rc,
    "terminal Runtime operation changed on replay",
  );
  for (const key of [
    "id",
    "agent_id",
    "generation",
    "digest",
    "volume",
    "started_at",
    "restarts",
  ])
    assert.equal(after.physical[key], before.physical[key]);
  assert.equal(after.physical.running, true);
  assert.equal(after.claims, 2);
  assert.equal(after.updated, 1);
  assert.equal(after.publications, 2);
}
export function inspectUpdateProxyDeployment(rows, config) {
  const peers = rows.filter(
    (r) => r.Config.Labels["com.docker.compose.service"] === "update-proxy",
  );
  assert.equal(peers.length, 1);
  const proxy = peers[0];
  assert.equal(
    proxy.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(proxy.State.Health.Status, "healthy");
  assert.equal(proxy.State.Running, true);
  assert.deepEqual(proxy.HostConfig.PortBindings ?? {}, {});
  assert(
    Object.values(proxy.NetworkSettings.Ports ?? {}).every((v) => !v?.length),
  );
  assert.deepEqual(Object.keys(proxy.NetworkSettings.Networks), [
    `${config.project}_controller-runtime`,
  ]);
  return { update_proxy_private: true };
}

export function assertUpdateTemplate(initial, final, target) {
  assert(target.revision > initial.configuration.template.revision);
  assert.equal(final.configuration.template.template_id, target.template_id);
  assert.equal(final.configuration.template.revision, target.revision);
  assert.equal(
    final.configuration.max_model_requests,
    target.max_model_requests,
  );
  const stable = (c) =>
    Object.fromEntries(
      Object.entries(c).filter(
        ([k]) => !["template", "max_model_requests"].includes(k),
      ),
    );
  assert.deepEqual(stable(final.configuration), stable(initial.configuration));
}
