import assert from "node:assert/strict";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { configuration, dockerClient, cleanup, lines } from "./docker.mjs";
import { configureFoundation } from "./foundation-setup.mjs";
import { configureRestore } from "./restore-flow.mjs";
import { stage4WriterServices, assertQuiesced } from "./restore-evidence.mjs";
import {
  backupStorage,
  restoreStorage,
  stage4RecoveryPlan,
  volumeTool,
} from "./restore-storage.mjs";

const abort = new AbortController();
const interrupt = () =>
  abort.abort(new Error("Stage 4 storage recovery interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(interrupt, 900000);
let config, directory;
try {
  config = await configuration(abort.signal);
  configureFoundation(config);
  configureRestore(config);
  const docker = dockerClient(config.env, abort.signal);
  directory = await mkdtemp(
    join(temporaryStorageRoot(), "antnest-stage4-restore-"),
  );
  await chmod(directory, 0o700);
  await docker(
    config.compose([
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "--no-build",
      "--pull",
      "never",
    ]),
    true,
  );
  const pg = lines(await docker(config.compose(["ps", "-q", "postgres"])))[0];
  assert(pg);

  const agentA = `agent_${"a".repeat(32)}`;
  const agentB = `agent_${"b".repeat(32)}`;
  const workspaceVolumes = [agentA, agentB].map(
    (agent) => `antnest-workspace-${agent}`,
  );
  const skillVolumes = ["ready-a", "ready-empty-b", "candidate-a"].map(
    (suffix) => `${config.project}-skill-${suffix}`,
  );
  for (const [index, name] of [
    ...workspaceVolumes,
    ...skillVolumes,
  ].entries()) {
    const agent = index === 1 || index === 3 ? agentB : agentA;
    await docker([
      "volume",
      "create",
      "--label",
      `io.antnest.runtime-controller-scope=${config.project}`,
      "--label",
      `io.antnest.agent-id=${agent}`,
      name,
    ]);
  }
  for (const [name, file] of [
    [workspaceVolumes[0], "personal-a"],
    [workspaceVolumes[1], "personal-b"],
    [skillVolumes[0], "preset-a"],
    [skillVolumes[1], ".antnest-skills.json"],
    [skillVolumes[2], "candidate-checkpoint"],
  ]) {
    await volumeTool(config, docker, name, directory, [
      "sh",
      "-c",
      'printf \'%s\' "$1" > "/data/$2"; chmod 444 "/data/$2"',
      "sh",
      file,
      file,
    ]);
  }
  await docker(
    config.compose([
      "stop",
      "-t",
      "25",
      ...stage4WriterServices.filter((name) => name !== "temporal"),
    ]),
    true,
  );
  await docker(
    config.compose(["stop", "-t", "25", "temporal", "stage3-model"]),
    true,
  );
  const writerIDs = lines(
    await docker(config.compose(["ps", "-aq", ...stage4WriterServices])),
  );
  assertQuiesced(
    JSON.parse(await docker(["inspect", ...writerIDs])),
    config.project,
    stage4WriterServices,
  );
  const sql = `INSERT INTO runtime_controller.skill_sets
    (controller_scope, organization_id, agent_id, skill_set_digest, layout_version, frozen_skills, state,
     total_packages, total_bytes, materialization, volume_name, manifest_digest)
    VALUES
    ('${config.project}', 'org_${"a".repeat(32)}', '${agentA}', 'sha256:${"a".repeat(64)}', 1, '[]', 'ready', 1, 8, 1, '${skillVolumes[0]}', 'sha256:${"a".repeat(64)}'),
    ('${config.project}', 'org_${"a".repeat(32)}', '${agentB}', 'sha256:${"b".repeat(64)}', 1, '[]', 'ready', 0, 0, 1, '${skillVolumes[1]}', 'sha256:${"b".repeat(64)}'),
    ('${config.project}', 'org_${"a".repeat(32)}', '${agentA}', 'sha256:${"c".repeat(64)}', 1, '[]', 'preparing', 1, 8, 1, '${skillVolumes[2]}', '')`;
  await docker([
    "exec",
    pg,
    "psql",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "antnest_test_admin",
    "-d",
    "antnest_runtime_controller",
    "-c",
    sql,
  ]);
  const plan = await stage4RecoveryPlan(config, docker, workspaceVolumes);
  assert.deepEqual(plan.volumes, [...workspaceVolumes, ...skillVolumes.sort()]);
  const backup = await backupStorage(
    config,
    docker,
    directory,
    plan.volumes,
    plan.databases,
  );
  assert.equal(backup.volumes.length, 5);
  assert.equal(Object.keys(backup.fingerprints).length, 8);
  const restored = await restoreStorage(config, docker, directory, {
    postgres: backup.postgres.name,
    ...plan,
  });
  assert.deepEqual(
    await stage4RecoveryPlan(config, docker, workspaceVolumes),
    plan,
  );
  assert.equal(restored.database_count, 8);
  assert.equal(restored.persistent_volumes, 5);
  console.log(
    JSON.stringify({
      status: "passed",
      project: config.project,
      databases: restored.database_count,
      persistent_volumes: restored.persistent_volumes,
      replaced_postgres: restored.replaced_postgres,
    }),
  );
} finally {
  clearTimeout(timer);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  try {
    if (config) await cleanup(config);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
