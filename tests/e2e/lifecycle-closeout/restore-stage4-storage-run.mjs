import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  temporaryStorageRoot,
  evidenceDirectory,
  evidenceFilePath,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { configuration, dockerClient, cleanup, lines } from "./docker.mjs";
import {
  configureFoundation,
  inspectFoundationDeployment,
} from "./foundation-setup.mjs";
import { applicationServices, assertDeployment } from "./deployment.mjs";
import { configureRestore } from "./restore-flow.mjs";
import {
  stage4WriterServices,
  assertQuiesced,
  restorableVolume,
  keyNames,
  keyDigests,
} from "./restore-evidence.mjs";
import {
  backupStorage,
  restoreStorage,
  stage4RecoveryPlan,
  volumeTool,
  postgresContainer,
} from "./restore-storage.mjs";

function failure(errors) {
  const unique = [...new Set(errors)];
  return unique.length === 1
    ? unique[0]
    : new AggregateError(
        unique,
        "Skill storage recovery, evidence or cleanup failed",
      );
}

export async function runStage4StorageRestore(
  { runtimeImage, candidateTag, signal: parent } = {},
  overrides = {},
) {
  temporaryStorageRoot();
  assert.match(candidateTag, /^shell-[a-f0-9]{8}$/u);
  assert.equal(runtimeImage, "antnest/antnest-runtime:" + candidateTag);
  const dependencies = {
    configuration,
    configure(config) {
      configureFoundation(config);
      configureRestore(config);
    },
    createDocker: dockerClient,
    createEvidence(project) {
      const path = evidenceDirectory(
        `artifacts/verification/lifecycle-skill-storage/${project}`,
      );
      for (const name of [
        "storage.private.json",
        "failure.private.txt",
        "result.json",
      ])
        evidenceFilePath(path, name);
      return path;
    },
    async createDirectory(output) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      return mkdtemp(join(output, "recovery-"));
    },
    removeDirectory: (directory) =>
      rm(directory, { recursive: true, force: true }),
    archive: writeEvidenceFile,
    scenario: storageScenario,
    cleanup,
    ...overrides,
  };
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, ...(parent ? [parent] : [])]);
  const interrupt = () =>
    abort.abort(new Error("Stage 4 storage recovery interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 900000);
  const errors = [],
    work = {};
  let config,
    early,
    directory,
    output,
    result,
    cleaned = false,
    directoryRemoved = false;
  const archive = async (name, value) => {
    if (!output) return;
    try {
      await dependencies.archive(output, name, value);
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    signal.throwIfAborted();
    config = await dependencies.configuration(
      signal,
      (project) => {
        // This scope exists before credentials or ownership preparation can fail.
        early = { project, env: process.env };
        work.project = project;
        output = dependencies.createEvidence(project);
      },
      runtimeImage,
    );
    config.env.ANTNEST_ADMISSION_TAG = candidateTag;
    config.evidence = output;
    dependencies.configure(config);
    directory = await dependencies.createDirectory(output);
    work.recovery_directory = directory;
    const docker = dependencies.createDocker(config.env, signal);
    result = await dependencies.scenario(
      config,
      docker,
      directory,
      work,
      signal,
    );
    work.business = result;
  } catch (error) {
    errors.push(error);
  } finally {
    if (signal.aborted) errors.push(signal.reason);
    await archive("storage.private.json", JSON.stringify(work));
    if (errors.length)
      await archive(
        "failure.private.txt",
        inspect(failure(errors), { depth: 8 }),
      );
    try {
      const scope = config ?? early;
      if (scope) {
        if (!config) {
          const root = fileURLToPath(new URL("../../../", import.meta.url));
          const credentials = resolve(
            root,
            "artifacts/verification/authenticated-e2e",
            scope.project,
            "credentials",
          );
          if (existsSync(credentials)) scope.credentials = credentials;
        }
        await dependencies.cleanup(scope);
      }
      cleaned = true;
    } catch (error) {
      errors.push(error);
    }
    // Keep the private recovery inputs available if owned Docker cleanup failed.
    if (directory && cleaned) {
      try {
        await dependencies.removeDirectory(directory);
        directoryRemoved = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (signal.aborted) errors.push(signal.reason);
    if (errors.length)
      await archive(
        "failure.private.txt",
        inspect(failure(errors), { depth: 8 }),
      );
    await archive(
      "result.json",
      JSON.stringify({
        status: errors.length ? "failed" : "passed",
        project: work.project,
        cleanup: cleaned ? "verified" : "failed",
        recovery_removed: directoryRemoved,
        ...(directory && !directoryRemoved
          ? { recovery_retained: directory }
          : {}),
      }),
    );
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  if (errors.length) throw failure(errors);
  return { ...result, cleanup: "verified" };
}

export function storageFixturePlan(project) {
  assert.match(project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  const agents = ["a", "b"].map(
    (name) =>
      "agent_" +
      createHash("sha256")
        .update(project + "\0" + name)
        .digest("hex")
        .slice(0, 32),
  );
  const workspaceVolumes = agents.map((agent) => "antnest-workspace-" + agent);
  const skillVolumes = ["ready-a", "ready-empty-b", "candidate-a"].map(
    (suffix) => `${project}-skill-${suffix}`,
  );
  const volumes = [...workspaceVolumes, ...skillVolumes].map((name, i) => ({
    name,
    agent: agents[i === 1 || i === 3 ? 1 : 0],
  }));
  return { agents, workspaceVolumes, skillVolumes, volumes };
}

export async function createStorageFixtureVolumes(config, docker, work) {
  const plan = storageFixturePlan(config.project);
  work.fixture = plan;
  work.initial_volumes = [];
  for (const row of plan.volumes) {
    const existing = lines(
      await docker(["volume", "ls", "-q", "--filter", `name=^${row.name}$`]),
    );
    assert.deepEqual(existing, [], "storage fixture volume already exists");
    await docker([
      "volume",
      "create",
      "--label",
      `io.antnest.runtime-controller-scope=${config.project}`,
      "--label",
      `io.antnest.agent-id=${row.agent}`,
      row.name,
    ]);
    const raw = JSON.parse(await docker(["volume", "inspect", row.name]));
    work.initial_volumes.push(...raw);
    assert.equal(raw.length, 1);
    restorableVolume(raw[0], config.project, row.name);
    assert.equal(raw[0].Labels["io.antnest.agent-id"], row.agent);
  }
  return plan;
}

async function executionInventory(docker, pg) {
  const query =
    "SELECT json_build_object('sessions', (SELECT count(*) FROM acp_sessions), 'runs', (SELECT count(*) FROM runs))";
  const raw = await docker([
    "exec",
    pg,
    "psql",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "antnest_test_admin",
    "-d",
    "antnest_agent_acp",
    "-c",
    query,
  ]);
  return { postgres_id: pg, query, raw, counts: JSON.parse(raw) };
}

async function storageScenario(config, docker, directory, work, signal) {
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
  const ids = lines(
    await docker([
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${config.project}`,
    ]),
  );
  const rows = JSON.parse(await docker(["inspect", ...ids]));
  work.deployment = rows;
  const images = {};
  for (const name of applicationServices)
    images[name] = await docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      config.images[name],
    ]);
  work.images = images;
  work.deployment_admission = {
    ...inspectFoundationDeployment(rows, config),
    ...assertDeployment(
      config,
      rows.map((row) => ({
        labels: row.Config.Labels,
        image: row.Image,
        running: row.State.Running,
        health: row.State.Health?.Status ?? "none",
        ports: row.NetworkSettings.Ports,
      })),
      images,
    ),
  };
  work.key_digests_before = keyDigests(config.env);
  const model = await fetch(config.model + "/status", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  work.model = { status: model.status, body: await model.json() };
  assert.equal(work.model.status, 200);
  assert.deepEqual(work.model.body.requests, []);
  assert.deepEqual(work.model.body.errors, []);

  const fixture = await createStorageFixtureVolumes(config, docker, work);
  const [agentA, agentB] = fixture.agents;
  const { workspaceVolumes, skillVolumes } = fixture;
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
  work.writers = JSON.parse(await docker(["inspect", ...writerIDs]));
  assertQuiesced(work.writers, config.project, stage4WriterServices);
  work.execution_before = await executionInventory(docker, pg);
  assert.deepEqual(work.execution_before.counts, { sessions: 0, runs: 0 });
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
  work.plan_before = structuredClone(plan);
  assert.deepEqual(plan.volumes, [...workspaceVolumes, ...skillVolumes.sort()]);
  const backup = await backupStorage(
    config,
    docker,
    directory,
    plan.volumes,
    plan.databases,
  );
  work.backup = backup;
  assert.equal(backup.volumes.length, 5);
  assert.equal(Object.keys(backup.fingerprints).length, 8);
  for (const key of keyNames) delete config.env[key];
  const restored = await restoreStorage(config, docker, directory, {
    postgres: backup.postgres.name,
    ...plan,
  });
  work.restored = restored;
  work.plan_after = await stage4RecoveryPlan(config, docker, workspaceVolumes);
  assert.deepEqual(work.plan_after, plan);
  work.postgres_after = await postgresContainer(config, docker);
  assert.notEqual(work.postgres_after.Id, backup.postgresID);
  assert.equal(work.postgres_after.Image, backup.postgresImage);
  work.execution_after = await executionInventory(
    docker,
    work.postgres_after.Id,
  );
  assert.deepEqual(work.execution_after.counts, work.execution_before.counts);
  work.key_digests_after = keyDigests(config.env);
  assert.deepEqual(work.key_digests_after, work.key_digests_before);
  assert.equal(restored.database_count, 8);
  assert.equal(restored.persistent_volumes, 5);
  return {
    status: "passed",
    project: config.project,
    databases: restored.database_count,
    persistent_volumes: restored.persistent_volumes,
    encryption_keys: restored.encryption_keys,
    replaced_postgres: restored.replaced_postgres,
    permission_drift_probes: restored.permission_drift_probes,
    acp_sessions: work.execution_after.counts.sessions,
    runs: work.execution_after.counts.runs,
    model_requests: work.model.body.requests.length,
    services: work.deployment_admission.services,
    application_images: work.deployment_admission.applicationImages,
  };
}
