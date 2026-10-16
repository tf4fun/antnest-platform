import assert from "node:assert/strict";
import { summarizeFailure } from "../../support/verification/failure.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateCommand,
  candidateEnvironment,
} from "../../support/candidate-images.mjs";
import { imageSpec } from "../../support/ci-changes.mjs";
import { grantContainerArgs } from "../../support/service-grants.mjs";
import {
  durablePath,
  writeEvidenceFile,
  shellStoragePreflight,
} from "../../support/storage.mjs";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { inspectDeployment } from "../stage3-base/deployment.mjs";
import { serveMultimodalRuntimeInspection } from "./runtime-inspection.mjs";
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
  const tag = "multimodal-" + runID;
  assert.equal(env.ANTNEST_ADMISSION_TAG, tag);
  assert.equal(
    env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    `antnest/antnest-runtime:${tag}`,
  );
  return { project, runID, tag };
}

export function multimodalImagePlan(env) {
  const { project, tag } = configuration(env);
  return names.map((name) => {
    const ref = `antnest/${name}:${tag}`;
    const spec = imageSpec(name);
    assert(
      !spec.target && !spec.args && !spec.contexts,
      "Multimodal requires release image build inputs",
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

export async function buildMultimodalImages(docker, env, save) {
  const { project, runID, tag } = configuration(env);
  const plan = multimodalImagePlan(env);
  // No tag is adopted until the complete set has been checked for collisions.
  for (const { ref } of plan)
    assert.equal(
      await docker(["image", "ls", "-q", ref]),
      "",
      "Multimodal candidate tag already exists",
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
  const references = new Map(
    multimodalImagePlan(env).map((p) => [p.ref, p.name]),
  );
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

export async function cleanupMultimodalImages(docker, env, record) {
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
      "Multimodal candidate cleanup failed ownership or removal checks",
    );
}

export function multimodalHarnessArguments(env, { evidence }) {
  const { project, runID, tag } = configuration(env);
  for (const key of ["ANTNEST_SERVICE_AUTH_UID", "ANTNEST_SERVICE_AUTH_GID"])
    assert.match(env[key] ?? "", /^\d+$/u);
  assert(env.ANTNEST_SERVICE_AUTH_DIRECTORY);
  const grants = grantContainerArgs(
    { credentials: env.ANTNEST_SERVICE_AUTH_DIRECTORY, env },
    ["gateway-identity", "agent-ui-acp"],
  );
  evidence = durablePath(evidence);
  const labels = (role) => [
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    `com.docker.compose.service=multimodal-${role}`,
    "--label",
    `io.antnest.e2e-run-id=${runID}`,
  ];
  const image = `antnest/agent-acp-service:${tag}`;
  return {
    client: [
      "create",
      "--name",
      `${project}-multimodal-client`,
      ...labels("client"),
      ...grants.args,
      `--add-host=edge-gateway:${env.ANTNEST_SERVICE_NETWORK_PREFIX}.130`,
      ...[
        "gateway-ingress",
        "observability",
        "acp-provider",
        ...grants.networks,
      ].flatMap((network) => ["--network", `${project}_${network}`]),
      "-e",
      `TEST_RUNTIME_IMAGE=${env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF}`,
      "-e",
      `COMPOSE_PROJECT_NAME=${project}`,
      "-e",
      `ANTNEST_E2E_RUN_ID=${runID}`,
      "-e",
      "ANTNEST_MULTIMODAL_EVIDENCE_DIR=/evidence/traces",
      "-e",
      "ANTNEST_MULTIMODAL_RUNTIME_CHECKPOINT_DIR=/evidence/deployment",
      "-v",
      `${evidence}:/evidence`,
      "-v",
      `${root}/tests:/app/tests:ro`,
      image,
      "node",
      "/app/tests/e2e/acp-multimodal/client.mjs",
    ],
    model: [
      "run",
      "-d",
      "--name",
      `${project}-multimodal-model`,
      ...labels("model"),
      ...["acp-provider", "controller-provider"].flatMap((network) => [
        "--network",
        `name=${project}_${network},alias=acp-closeout-model`,
      ]),
      "-v",
      `${root}/tests:/app/tests:ro`,
      image,
      "node",
      "/app/tests/e2e/acp-multimodal/model.mjs",
    ],
  };
}

function healthy(row) {
  assert.match(row.Id ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(row.State?.Running, true);
  assert.equal(row.State.Status, "running");
  assert.equal(row.State.Health?.Status, "healthy");
  for (const key of ["Paused", "Restarting", "Dead", "OOMKilled"])
    assert.equal(row.State[key], false);
  assert.equal(row.State.ExitCode, 0);
  assert.equal(row.State.Error, "");
}
function actualSetting(row, name, value) {
  assert.deepEqual(
    (row.Config.Env ?? []).filter((item) => item.startsWith(name + "=")),
    [name + "=" + value],
  );
}
export function inspectMultimodalHarness(rows, env, role, imageID) {
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
    "multimodal-" + role,
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
export function inspectMultimodalImages(rows, env, record) {
  const { project } = checkedManifest(record, env);
  assert.equal(record.images.length, names.length);
  inspectDeployment(rows, project);
  const services = [];
  for (const selected of record.images.filter(
    (item) => item.name !== "antnest-runtime",
  )) {
    const found = rows.filter(
      (row) =>
        row.Config.Labels["com.docker.compose.service"] === selected.name,
    );
    assert.equal(found.length, 1);
    const row = found[0];
    healthy(row);
    assert.equal(row.Image, selected.id);
    assert.equal(row.Config.Image, selected.ref);
    assert.equal(row.Config.Labels[owner], project);
    if (selected.name === "runtime-controller")
      actualSetting(row, "ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE", selected.ref);
    if (selected.name === "admin-console")
      actualSetting(
        row,
        "ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF",
        env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
      );
    services.push({
      service: selected.name,
      container_id: row.Id,
      image_id: row.Image,
      image_ref: row.Config.Image,
    });
  }
  return { project, services };
}
export function inspectMultimodalRuntimes(rows, env, record, agents) {
  const { project } = checkedManifest(record, env);
  assert.equal(record.images.length, names.length);
  assert(
    Array.isArray(agents) &&
      agents.length === 2 &&
      new Set(agents).size === 2 &&
      agents.every((id) => typeof id === "string" && id.length > 0),
  );
  assert(
    Array.isArray(rows) &&
      rows.length === 2 &&
      new Set(rows.map((row) => row.Id)).size === 2,
  );
  const selected = record.images.find(
    (item) => item.name === "antnest-runtime",
  );
  return agents.map((agent) => {
    const found = rows.filter(
      (row) => row.Config.Labels["io.antnest.agent-id"] === agent,
    );
    assert.equal(found.length, 1);
    const row = found[0];
    healthy(row);
    assert.equal(row.Image, selected.id);
    assert.equal(row.Config.Image, selected.id);
    assert.equal(row.Config.Labels["io.antnest.managed"], "runtime");
    assert.equal(
      row.Config.Labels["io.antnest.runtime-controller-scope"],
      project,
    );
    const value = row.Config.Labels["io.antnest.runtime-generation"];
    assert.match(value ?? "", /^[1-9]\d*$/u);
    const generation = Number(value);
    assert(Number.isSafeInteger(generation));
    actualSetting(row, "ANTNEST_RUNTIME_IMAGE_REFERENCE", selected.ref);
    actualSetting(row, "ANTNEST_RUNTIME_IMAGE_ID", selected.id);
    return {
      project,
      agent_id: agent,
      generation,
      container_id: row.Id,
      image_id: row.Image,
      image_ref: selected.ref,
    };
  });
}

export async function runMultimodalDeployment(
  action,
  { env, directory, docker, signal, timeout = 900000 },
) {
  assert(
    [
      "build",
      "cleanup",
      "inspect-stack",
      "create-harness",
      "inspect-runtimes",
    ].includes(action),
  );
  signal?.throwIfAborted();
  const { project } = configuration(env);
  directory = durablePath(directory);
  shellStoragePreflight(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const save = (name, value) =>
    writeEvidenceFile(directory, name, JSON.stringify(value) + "\n");
  const capture = async (
    name,
    args,
    target = directory,
    callSignal = signal,
  ) => {
    const raw = await docker(args, false, { signal: callSignal });
    const bytes = Buffer.from(raw + "\n");
    writeEvidenceFile(target, name, bytes);
    callSignal?.throwIfAborted();
    return { rows: JSON.parse(raw), bytes };
  };
  const manifestPath = join(directory, "candidate-images.json");
  if (action === "build") {
    let first = true;
    return buildMultimodalImages(docker, env, async (record) => {
      if (first) {
        await writeFile(manifestPath, JSON.stringify(record) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        first = false;
      } else save("candidate-images.json", record);
    });
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (action === "cleanup" && error.code === "ENOENT") return;
    throw error;
  }
  signal?.throwIfAborted();
  if (action === "cleanup")
    return cleanupMultimodalImages(docker, env, manifest);
  checkedManifest(manifest, env);
  assert.equal(manifest.images.length, names.length);
  if (action === "inspect-stack") {
    const ids = (
      await docker([
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
    )
      .split(/\s+/u)
      .filter(Boolean);
    assert(ids.length > 0, "Multimodal stack has no actual containers");
    const { rows } = await capture("deployment.private.json", [
      "inspect",
      ...ids,
    ]);
    const receipt = inspectMultimodalImages(rows, env, manifest);
    save("actual-candidate-images.json", receipt);
    return receipt;
  }
  if (action === "create-harness") {
    const args = multimodalHarnessArguments(env, { evidence: directory });
    const imageID = manifest.images.find(
      (row) => row.name === "agent-acp-service",
    ).id;
    const receipts = [];
    for (const role of ["model", "client"]) {
      const id = await docker(args[role]);
      assert.match(id, /^[a-f0-9]{64}$/u);
      const { rows } = await capture(`multimodal-${role}.private.json`, [
        "inspect",
        id,
      ]);
      const receipt = inspectMultimodalHarness(rows, env, role, imageID);
      save(`multimodal-${role}-receipt.json`, receipt);
      receipts.push(receipt);
    }
    return receipts;
  }
  const checkpoints = join(directory, "deployment");
  return serveMultimodalRuntimeInspection({
    env,
    directory: checkpoints,
    signal,
    timeout,
    waiting: async () => {
      const rows = JSON.parse(
        await docker(["inspect", `${project}-multimodal-client`]),
      );
      assert(
        Array.isArray(rows) &&
          rows.length === 1 &&
          rows[0].State?.Running === true,
        "Multimodal client exited before Runtime inspection",
      );
    },
    inspect: async (request, inspectionSignal) => {
      const ids = (
        await docker(
          [
            "ps",
            "-aq",
            "--filter",
            "label=io.antnest.managed=runtime",
            "--filter",
            `label=io.antnest.runtime-controller-scope=${project}`,
          ],
          false,
          { signal: inspectionSignal },
        )
      )
        .split(/\s+/u)
        .filter(Boolean);
      assert.equal(
        ids.length,
        2,
        "two actual Multimodal Runtime containers required",
      );
      const { rows, bytes } = await capture(
        "runtime-containers.private.json",
        ["inspect", ...ids],
        checkpoints,
        inspectionSignal,
      );
      const runtimes = inspectMultimodalRuntimes(
        rows,
        env,
        manifest,
        request.agent_ids,
      );
      return {
        runtimes,
        raw_sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  });
}

async function main() {
  const [action] = process.argv.slice(2),
    env = process.env;
  const { project } = configuration(env);
  const controller = new AbortController(),
    stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  try {
    const remaining = Number(env.ANTNEST_E2E_DEADLINE_MS) - Date.now();
    assert(Number.isSafeInteger(remaining) && remaining > 0);
    await runMultimodalDeployment(action, {
      env,
      directory: join(root, "artifacts/verification/acp-multimodal", project),
      docker: dockerClient(env, controller.signal, remaining),
      signal: controller.signal,
      timeout: Math.min(remaining, 900000),
    });
    console.log(
      JSON.stringify({ stage: `multimodal-${action}`, status: "completed" }),
    );
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        stage: "multimodal-deployment",
        status: "failed",
        ...summarizeFailure(error),
      }),
    );
    process.exitCode = 1;
  }
}
