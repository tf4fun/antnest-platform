import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateCommand,
  candidateEnvironment,
} from "../../support/candidate-images.mjs";
import { imageSpec } from "../../support/ci-changes.mjs";
import { grantContainerArgs } from "../../support/service-grants.mjs";
import { durablePath, writeEvidenceFile } from "../../support/storage.mjs";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { resolveObservationConfig } from "../observability/resolve-config.mjs";
import {
  createOwnerLifecycle,
  loadParticipantServices,
} from "../edge-gateway/resolve-cache-owner-drain.mjs";
import { serveSessionOwnerDrain } from "./session-owner-drain.mjs";
import { assertSecretFree } from "./evidence.mjs";
import {
  inspectACPClockReceipt,
  probeACPClock,
} from "../edge-gateway/resolve-cache-clock.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const owner = "io.antnest.deployment-admission";
const names = [
  "admin-console",
  "agent-acp-service",
  "agent-controller",
  "agent-ui",
  "edge-gateway",
  "identity-service",
  "runtime-controller",
  "runtime-egress",
  "skill-registry",
  "temporal",
  "antnest-runtime",
];

function configuration(env) {
  const project = env.COMPOSE_PROJECT_NAME;
  const runID = env.ANTNEST_E2E_RUN_ID;
  assert.match(project ?? "", /^antnest-stage3-e2e-\d+$/u);
  assert.match(runID ?? "", /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  const tag = "session-" + runID;
  assert.equal(env.ANTNEST_ADMISSION_TAG, tag);
  assert.equal(
    env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    `antnest/antnest-runtime:${tag}`,
  );
  return { project, runID, tag };
}

export function sessionImagePlan(env) {
  const { project, tag } = configuration(env);
  return names.map((name) => {
    const ref = `antnest/${name}:${tag}`;
    const spec = imageSpec(name);
    assert(
      !spec.target && !spec.args && !spec.contexts,
      "Session requires release image build inputs",
    );
    return {
      name,
      ref,
      command: candidateCommand(
        {
          name,
          tag: ref,
          labels: { [owner]: project },
          build: [
            "docker",
            "build",
            "--label",
            `${owner}=${project}`,
            "-f",
            spec.dockerfile,
            "-t",
            ref,
            ".",
          ],
        },
        env,
      ),
    };
  });
}

function inspectedImage(rows, ref, project) {
  assert(Array.isArray(rows) && rows.length === 1);
  const row = rows[0];
  assert.match(row.Id ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert(row.RepoTags?.includes(ref));
  assert.equal(row.Config?.Labels?.[owner], project);
  return row.Id;
}

export async function buildSessionImages(docker, env, save) {
  const { project, runID, tag } = configuration(env);
  const plan = sessionImagePlan(env);
  // No tag is adopted until the complete set has been checked for collisions.
  for (const { ref } of plan)
    assert.equal(
      await docker(["image", "ls", "-q", ref]),
      "",
      "Session candidate tag already exists",
    );
  const record = {
    version: 1,
    project,
    run_id: runID,
    tag,
    attempted: [],
    images: [],
  };
  await save(record);
  for (const { name, ref, command } of plan) {
    record.attempted.push(ref);
    await save(record);
    assert.equal(command[0], "docker");
    await docker(command.slice(1), true, { env: candidateEnvironment(env) });
    const rows = JSON.parse(await docker(["image", "inspect", ref]));
    const id = inspectedImage(rows, ref, project);
    record.images.push({ name, ref, id });
    await save(record);
  }
  return record;
}

function checkedManifest(record, env) {
  const { project, runID, tag } = configuration(env);
  assert.equal(record.version, 1);
  assert.equal(record.project, project);
  assert.equal(record.run_id, runID);
  assert.equal(record.tag, tag);
  assert(Array.isArray(record.attempted) && Array.isArray(record.images));
  const references = new Map(sessionImagePlan(env).map((p) => [p.ref, p.name]));
  assert.equal(new Set(record.attempted).size, record.attempted.length);
  assert.equal(
    new Set(record.images.map((p) => p.ref)).size,
    record.images.length,
  );
  for (const ref of record.attempted) assert(references.has(ref));
  for (const entry of record.images) {
    assert.equal(entry.name, references.get(entry.ref));
    assert(record.attempted.includes(entry.ref));
    assert.match(entry.id ?? "", /^sha256:[a-f0-9]{64}$/u);
  }
  return { project, references };
}

export async function cleanupSessionImages(docker, env, record) {
  const { project } = checkedManifest(record, env);
  const failures = [];
  for (const ref of record.attempted) {
    try {
      if (!(await docker(["image", "ls", "-q", ref]))) continue;
      const rows = JSON.parse(await docker(["image", "inspect", ref]));
      const id = inspectedImage(rows, ref, project);
      const selected = record.images.find((entry) => entry.ref === ref);
      if (selected) assert.equal(id, selected.id);
      await docker(["image", "rm", ref]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Session candidate cleanup failed ownership or removal checks",
    );
}

export function sessionHarnessArguments(env, { evidence, checkpoints }) {
  const { project, runID, tag } = configuration(env);
  for (const key of ["ANTNEST_SERVICE_AUTH_UID", "ANTNEST_SERVICE_AUTH_GID"])
    assert.match(env[key] ?? "", /^\d+$/u);
  assert(env.ANTNEST_SERVICE_AUTH_DIRECTORY);
  const grants = grantContainerArgs(
    { credentials: env.ANTNEST_SERVICE_AUTH_DIRECTORY, env },
    ["gateway-identity", "agent-ui-acp"],
  );
  const labels = (role) => [
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    `com.docker.compose.service=session-${role}`,
    "--label",
    `io.antnest.e2e-run-id=${runID}`,
  ];
  const acp = `antnest/agent-acp-service:${tag}`;
  const networks = [
    "gateway-ingress",
    "observability",
    "acp-provider",
    "agent-acp-database",
    ...grants.networks,
  ];
  const client = [
    "create",
    "--name",
    `${project}-acp-session-client`,
    ...labels("client"),
    ...grants.args,
    `--add-host=edge-gateway:${env.ANTNEST_SERVICE_NETWORK_PREFIX}.130`,
    ...networks.flatMap((network) => ["--network", `${project}_${network}`]),
    "-e",
    `TEST_ACP_DATABASE_URL=postgres://antnest_agent_acp:${env.ANTNEST_AGENT_ACP_POSTGRES_PASSWORD ?? "antnest-agent-acp-dev"}@postgres:5432/antnest_agent_acp`,
    "-e",
    `ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=${env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF}`,
    "-e",
    "ANTNEST_IDENTITY_EVIDENCE_DIR=/evidence/traces",
    "-e",
    `ANTNEST_E2E_RUN_ID=${runID}`,
    "-e",
    `COMPOSE_PROJECT_NAME=${project}`,
    "-v",
    `${evidence}:/evidence`,
    "-v",
    `${root}/tests:/app/tests:ro`,
    "-v",
    `${root}/contracts/agent-ui/workspace-api.schema.json:/app/contracts/agent-ui/workspace-api.schema.json:ro`,
    "-v",
    `${root}/services/agent-ui/web/src/lib:/app/services/agent-ui/web/src/lib:ro`,
    "-v",
    `${root}/services/agent-ui/web/server/src/protocol:/app/services/agent-ui/web/server/src/protocol:ro`,
    "-v",
    `${checkpoints}:/checkpoints`,
    acp,
    "node",
    "/app/tests/e2e/identity-closeout/acp-session-fault-client.mjs",
  ];
  const model = [
    "run",
    "-d",
    "--name",
    `${project}-acp-session-model`,
    ...labels("model"),
    "--network",
    `name=${project}_acp-provider,alias=acp-session-model`,
    "--network",
    `name=${project}_controller-provider,alias=acp-session-model`,
    "-v",
    `${root}/tests/e2e/identity-closeout:/app/identity-closeout:ro`,
    acp,
    "node",
    "/app/identity-closeout/acp-session-model.mjs",
  ];
  return { client, model };
}

export function inspectSessionHarness(rows, env, role, imageID) {
  const { project, runID, tag } = configuration(env);
  assert(["client", "model"].includes(role));
  assert.match(imageID ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert(Array.isArray(rows) && rows.length === 1);
  const row = rows[0];
  assert.match(row.Id ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(row.Image, imageID);
  assert.equal(row.Config.Image, `antnest/agent-acp-service:${tag}`);
  assert.equal(row.Config.Labels["com.docker.compose.project"], project);
  assert.equal(
    row.Config.Labels["com.docker.compose.service"],
    `session-${role}`,
  );
  assert.equal(row.Config.Labels["io.antnest.e2e-run-id"], runID);
  assert.equal(row.State.Status, role === "client" ? "created" : "running");
  assert.equal(row.State.Running, role !== "client");
  for (const key of ["Paused", "Restarting", "Dead", "OOMKilled"])
    assert.equal(row.State[key], false);
  assert.equal(row.State.ExitCode, 0);
  assert.equal(row.State.Error, "");
  return {
    project,
    run_id: runID,
    role,
    container_id: row.Id,
    image_id: row.Image,
    image_ref: row.Config.Image,
  };
}

function healthyContainer(row) {
  assert.match(row.Id ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(row.State?.Running, true);
  assert.equal(row.State?.Status, "running");
  assert.equal(row.State?.Health?.Status, "healthy");
  for (const key of ["Paused", "Restarting", "Dead", "OOMKilled"])
    assert.equal(row.State[key], false);
  assert.equal(row.State.ExitCode, 0);
  assert.equal(row.State.Error, "");
}

export function inspectSessionImages(rows, env, record) {
  const { project } = checkedManifest(record, env);
  assert.equal(record.images.length, names.length);
  assert(Array.isArray(rows));
  const services = [];
  for (const expected of record.images.filter(
    (row) => row.name !== "antnest-runtime",
  )) {
    const found = rows.filter(
      (row) =>
        row.Config?.Labels?.["com.docker.compose.service"] === expected.name,
    );
    assert.equal(found.length, 1, "missing or duplicate Session service");
    const row = found[0];
    healthyContainer(row);
    assert.equal(row.Image, expected.id);
    assert.equal(row.Config.Image, expected.ref);
    assert.equal(row.Config.Labels["com.docker.compose.project"], project);
    assert.equal(row.Config.Labels[owner], project);
    if (expected.name === "edge-gateway") {
      const key = "ANTNEST_EDGE_RESOLVE_CACHE_TTL";
      const entries = (row.Config.Env ?? []).filter((entry) =>
        entry.startsWith(key + "="),
      );
      assert.equal(
        entries.length,
        1,
        "actual Session cache budget missing or duplicated",
      );
      const settings = { [key]: entries[0].slice(key.length + 1) };
      assert.equal(
        resolveObservationConfig(settings, {}).resolveTTLMS,
        10000,
        "Session requires the actual 10s cache budget",
      );
    }
    services.push({
      service: expected.name,
      container_id: row.Id,
      image_id: row.Image,
      image_ref: row.Config.Image,
    });
  }
  return {
    project,
    services,
    resolve_cache_ttl_ms: 10000,
    resolve_timeout_max_ms: 5000,
  };
}

export function inspectSessionRuntime(rows, env, record, agentId) {
  const { project } = checkedManifest(record, env);
  assert.equal(record.images.length, names.length);
  assert.equal(typeof agentId, "string");
  assert(agentId.length > 0);
  assert(
    Array.isArray(rows) && rows.length === 1,
    "one actual Session Runtime required",
  );
  const expected = record.images.find((row) => row.name === "antnest-runtime");
  const row = rows[0];
  healthyContainer(row);
  assert.equal(row.Image, expected.id);
  assert.equal(row.Config.Image, expected.id);
  const labels = row.Config.Labels;
  assert.equal(labels["io.antnest.managed"], "runtime");
  assert.equal(labels["io.antnest.runtime-controller-scope"], project);
  assert.equal(labels["io.antnest.agent-id"], agentId);
  const rawGeneration = labels["io.antnest.runtime-generation"];
  assert.match(rawGeneration ?? "", /^[1-9]\d*$/u);
  const generation = Number(rawGeneration);
  assert(Number.isSafeInteger(generation));
  for (const [key, value] of [
    ["ANTNEST_RUNTIME_IMAGE_REFERENCE", expected.ref],
    ["ANTNEST_RUNTIME_IMAGE_ID", expected.id],
  ])
    assert.deepEqual(
      row.Config.Env.filter((item) => item.startsWith(key + "=")),
      [key + "=" + value],
    );
  return {
    project,
    agent_id: agentId,
    generation,
    container_id: row.Id,
    image_id: row.Image,
    image_ref: expected.ref,
  };
}

export async function createSessionOwnerLifecycle({
  docker,
  env,
  manifest,
  initial,
  identity,
  request,
  output,
  signal,
  createLifecycle = createOwnerLifecycle,
  clockProbe = probeACPClock,
  writeClock = writeEvidenceFile,
  now = () => performance.now(),
}) {
  signal?.throwIfAborted();
  const { project, runID } = configuration(env);
  inspectSessionImages(initial, env, manifest);
  assert.equal(request.project, project);
  assert.equal(request.run_id, runID);
  assert.equal(identity.project, project);
  assert.equal(identity.run_id, runID);
  assert.equal(identity.step, 3);
  assert.equal(identity.after.token_ttl, "12h");
  assert.equal(identity.after.running, true);
  assert.equal(request.identity_container_id, identity.after.container_id);
  const selectedIdentity = manifest.images.find(
    (row) => row.name === "identity-service",
  );
  assert.equal(identity.image_id, selectedIdentity.id);
  assert.equal(identity.image_ref, selectedIdentity.ref);
  const original = (service) => {
    const rows = initial.filter(
      (row) => row.Config?.Labels?.["com.docker.compose.service"] === service,
    );
    assert.equal(
      rows.length,
      1,
      "original Session participant missing or duplicated",
    );
    assert.equal(rows[0].Config.Labels["com.docker.compose.project"], project);
    assert(Number.isFinite(Date.parse(rows[0].State.StartedAt)));
    return rows[0];
  };
  const images = Object.fromEntries(
    manifest.images.map((row) => [row.name, row.id]),
  );
  images.runtime = images["antnest-runtime"];
  images.jaeger = original("jaeger").Image;
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        /TOKEN|KEY|PASSWORD|SECRET|CREDENTIAL/u.test(key) && value?.length >= 8,
    )
    .map(([, value]) => value);
  const owner = await createLifecycle({
    docker,
    // A cancelled measurement must still attempt a bounded normal restoration.
    cleanupDocker: (...args) => dockerClient(env, undefined, 30000)(...args),
    compose: (args) => {
      assert.equal(args[0], "ps");
      assert.equal(args[1], "-q");
      assert(
        loadParticipantServices.includes(args[2]) && args[2] !== "runtime",
      );
      return [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        `label=com.docker.compose.service=${args[2]}`,
      ];
    },
    project,
    agentID: request.agent_id,
    images,
    output,
    signal,
    now,
    artifactPrefix: "session",
    secrets,
  });
  for (const service of loadParticipantServices) {
    if (service === "runtime") continue;
    if (service === "identity-service") {
      assert.equal(owner.baseline[service].id, request.identity_container_id);
      assert(
        typeof identity.after.started_at === "string" &&
          Number.isFinite(Date.parse(identity.after.started_at)),
      );
      assert.equal(
        owner.baseline[service].started_at,
        identity.after.started_at,
        "Identity restarted after final restoration ACK",
      );
      continue;
    }
    const row = original(service);
    assert.equal(
      owner.baseline[service].id,
      row.Id,
      "Session participant replaced before owner drain",
    );
    assert.equal(
      owner.baseline[service].started_at,
      row.State.StartedAt,
      "Session participant restarted before owner drain",
    );
  }
  signal?.throwIfAborted();
  const acp = owner.baseline["agent-acp-service"];
  const clock = structuredClone(
    await clockProbe({ container: acp.id, environment: env, signal, now }),
  );
  const prepared = () => {
    signal?.throwIfAborted();
    inspectACPClockReceipt(clock);
    assert.equal(clock.container_id, acp.id, "Session clock container differs");
    assert(Number.isFinite(acp.at), "Session ACP baseline clock missing");
    assert(clock.started_at >= acp.at, "Session clock predates ACP baseline");
    const current = now();
    assert(
      Number.isFinite(current) && clock.received_at <= current,
      "Session ACP clock receipt is from the future",
    );
  };
  prepared();
  const raw = JSON.stringify(clock, null, 2);
  assertSecretFree(raw, secrets);
  await writeClock(output, "session-acp-clock.private.json", raw);
  return {
    baseline: owner.baseline,
    collect: (collect) =>
      owner.collect(collect, {
        evidence: { acp_clock: clock },
        beforeDrain: prepared,
        inspectDrain(evidence) {
          assert(
            clock.received_at <= evidence.before["agent-acp-service"].at &&
              clock.received_at <= evidence.requested_at,
            "Session clock probe did not precede the actual UI stop",
          );
        },
      }),
  };
}

async function main() {
  const [action, checkpoints] = process.argv.slice(2);
  assert(
    [
      "build",
      "cleanup",
      "create-harness",
      "inspect-stack",
      "inspect-runtime",
      "drain-owners",
    ].includes(action),
  );
  const env = process.env;
  const { project } = configuration(env);
  const output = durablePath(
    join(root, "artifacts/verification/identity-session", project),
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  const manifestPath = join(output, "candidate-images.json");
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  const remaining = Number(env.ANTNEST_E2E_DEADLINE_MS) - Date.now();
  assert(Number.isFinite(remaining) && remaining > 0);
  const docker = dockerClient(env, controller.signal, remaining);
  const save = (name, value, flag = "wx") =>
    writeFile(join(output, name), JSON.stringify(value) + "\n", {
      mode: 0o600,
      flag,
    });
  try {
    if (action === "build") {
      let first = true;
      await buildSessionImages(docker, env, async (record) => {
        await save("candidate-images.json", record, first ? "wx" : "w");
        first = false;
      });
      console.log(
        JSON.stringify({
          stage: "session-candidate-images",
          status: "built",
          images: names.length,
        }),
      );
    } else {
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (error) {
        if (action === "cleanup" && error.code === "ENOENT") return;
        throw error;
      }
      if (action === "cleanup")
        await cleanupSessionImages(docker, env, manifest);
      else if (action === "drain-owners") {
        const initial = JSON.parse(
          await readFile(join(output, "deployment.private.json"), "utf8"),
        );
        const identity = JSON.parse(
          await readFile(join(output, "identity-step-3-receipt.json"), "utf8"),
        );
        const result = await serveSessionOwnerDrain({
          directory: durablePath(checkpoints),
          project,
          runID: env.ANTNEST_E2E_RUN_ID,
          signal: controller.signal,
          createLifecycle: (request) =>
            createSessionOwnerLifecycle({
              docker,
              env,
              manifest,
              initial,
              identity,
              request,
              output,
              signal: controller.signal,
            }),
        });
        await save("session-owner-window-receipt.json", result);
        console.log(
          JSON.stringify({
            stage: "session-owner-drain",
            status: "restored",
            collection_status: result.collection_status,
          }),
        );
      } else if (action === "inspect-stack") {
        const rows = JSON.parse(
          await readFile(durablePath(checkpoints), "utf8"),
        );
        await save(
          "actual-candidate-images.json",
          inspectSessionImages(rows, env, manifest),
        );
      } else if (action === "inspect-runtime") {
        const report = JSON.parse(
          await readFile(durablePath(checkpoints), "utf8"),
        );
        assert.equal(report.status, "business_passed");
        assert.equal(typeof report.agent_id, "string");
        assert(report.agent_id.length > 0);
        const ids = (
          await docker([
            "ps",
            "-aq",
            "--filter",
            "label=io.antnest.managed=runtime",
            "--filter",
            `label=io.antnest.runtime-controller-scope=${project}`,
            "--filter",
            `label=io.antnest.agent-id=${report.agent_id}`,
          ])
        )
          .split(/\s+/u)
          .filter(Boolean);
        assert.equal(ids.length, 1, "one actual Session Runtime required");
        const rows = JSON.parse(await docker(["inspect", ...ids]));
        await save("session-runtime.private.json", rows);
        await save(
          "session-runtime-receipt.json",
          inspectSessionRuntime(rows, env, manifest, report.agent_id),
        );
      } else {
        checkedManifest(manifest, env);
        assert.equal(manifest.images.length, names.length);
        const imageID = manifest.images.find(
          (row) => row.name === "agent-acp-service",
        ).id;
        const args = sessionHarnessArguments(env, {
          evidence: output,
          checkpoints: durablePath(checkpoints),
        });
        for (const role of ["model", "client"]) {
          const id = await docker(args[role]);
          assert.match(id, /^[a-f0-9]{64}$/u);
          const rows = JSON.parse(await docker(["inspect", id]));
          await save(`session-${role}.private.json`, rows);
          await save(
            `session-${role}-receipt.json`,
            inspectSessionHarness(rows, env, role, imageID),
          );
        }
      }
    }
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
