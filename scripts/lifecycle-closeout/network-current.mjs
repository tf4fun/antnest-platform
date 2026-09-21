import assert from "node:assert/strict";
import { assertCompletedExecution } from "./foundation-evidence.mjs";

export function assertNetworkRun(runs, agent, sessionId) {
  assert.equal(runs.length, 1, "network prompt must create exactly one Run");
  const run = runs[0];
  assert(run.run_id, "public Run identity missing");
  assert.equal(
    run.session_id,
    sessionId,
    "network Run belongs to another Session",
  );
  assertCompletedExecution(run, agent);
  return run;
}

export function inspectNetworkTarget(rows, config) {
  const targets = rows.filter(
    (r) => r.Config.Labels["com.docker.compose.service"] === "network-target",
  );
  assert.equal(targets.length, 1, "missing or duplicate network target");
  const target = targets[0];
  assert.equal(
    target.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(target.State.Running, true);
  assert.equal(target.State.Health.Status, "healthy");
  assert.deepEqual(target.HostConfig.PortBindings ?? {}, {});
  assert(
    Object.values(target.NetworkSettings.Ports ?? {}).every(
      (bindings) => !bindings?.length,
    ),
  );
  assert.deepEqual(Object.keys(target.NetworkSettings.Networks), [
    `${config.project}_egress`,
  ]);
  return { network_target_private: true };
}
