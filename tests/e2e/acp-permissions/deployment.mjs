import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { inspect as inspectError } from "node:util";
import { createHash } from "node:crypto";
import {
  permissionImagePlan,
  buildPermissionImages,
  checkedPermissionManifest,
  cleanupPermissionImages,
} from "./images.mjs";
import { grantContainerArgs } from "../../support/service-grants.mjs";
import {
  durablePath,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { inspectDeployment } from "../stage3-base/deployment.mjs";
import { servePermissionRuntimeInspection } from "./runtime-inspection.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const owner = "io.antnest.deployment-admission";
const services = [
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
];
const contracts = [
  "contracts/identity/identity-contract.json",
  "contracts/agent-controller/control-contract.json",
  "services/runtime-controller/api/control-contract.json",
];

function configuration(env) {
  permissionImagePlan(env);
  const project = env.COMPOSE_PROJECT_NAME,
    runID = env.ANTNEST_E2E_RUN_ID;
  assert.match(project ?? "", /^antnest-stage3-e2e-\d+$/u);
  assert.match(runID ?? "", /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  const tag = "permission-" + runID;
  assert.equal(env.ANTNEST_ADMISSION_TAG, tag);
  assert.equal(
    env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    `antnest/antnest-runtime:${tag}`,
  );
  return { project, runID, tag };
}

function serviceUser(env) {
  for (const name of ["ANTNEST_SERVICE_AUTH_UID", "ANTNEST_SERVICE_AUTH_GID"]) {
    assert.match(env[name] ?? "", /^[1-9]\d*$/u);
    assert(Number.isSafeInteger(Number(env[name])));
  }
  return `${env.ANTNEST_SERVICE_AUTH_UID}:${env.ANTNEST_SERVICE_AUTH_GID}`;
}
function harnessMounts(env, role, evidence) {
  evidence = durablePath(evidence);
  shellStoragePreflight(evidence);
  assert(env.ANTNEST_SERVICE_AUTH_DIRECTORY);
  const bind = (source, target, writable = false) => ({
    Type: "bind",
    Source: source,
    Destination: target,
    RW: writable,
  });
  return [
    bind(join(root, "tests"), "/app/tests"),
    ...(role !== "model"
      ? [
          ...["traces", "deployment"].map((name) =>
            bind(join(evidence, name), "/evidence/" + name, true),
          ),
          ...contracts.map((name) => bind(join(root, name), "/app/" + name)),
          bind(
            join(
              env.ANTNEST_SERVICE_AUTH_DIRECTORY,
              "edge-gateway/tokens/identity-service",
            ),
            "/run/auth/gateway-identity",
          ),
          bind(
            join(
              env.ANTNEST_SERVICE_AUTH_DIRECTORY,
              "agent-ui/tokens/agent-acp-service",
            ),
            "/run/auth/agent-ui-acp",
          ),
        ]
      : []),
  ];
}
function clientEnvironment(env) {
  return {
    TEST_RUNTIME_IMAGE: env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    COMPOSE_PROJECT_NAME: env.COMPOSE_PROJECT_NAME,
    ANTNEST_E2E_RUN_ID: env.ANTNEST_E2E_RUN_ID,
    ANTNEST_PERMISSION_EVIDENCE_DIR: "/evidence/traces",
    TEST_PERMISSION_RUN_ID: env.ANTNEST_E2E_RUN_ID,
    TEST_BROWSER: env.ANTNEST_E2E_BROWSER ?? "false",
    TEST_PERMISSION_CRASH: env.ANTNEST_E2E_PERMISSION_CRASH ?? "false",
    ANTNEST_PERMISSION_RUNTIME_CHECKPOINT_DIR: "/evidence/deployment",
  };
}
export function permissionHarnessArguments(env, { evidence }) {
  const { project, runID, tag } = configuration(env),
    user = serviceUser(env);
  const grants = grantContainerArgs(
    { credentials: env.ANTNEST_SERVICE_AUTH_DIRECTORY, env },
    ["gateway-identity", "agent-ui-acp"],
  );
  const mountArgs = (role) =>
    harnessMounts(env, role, evidence)
      .filter((item) => !item.Destination.startsWith("/run/auth/"))
      .flatMap((item) => [
        "-v",
        `${item.Source}:${item.Destination}${item.RW ? "" : ":ro"}`,
      ]);
  const labels = (role) => [
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    `com.docker.compose.service=permission-${role}`,
    "--label",
    `io.antnest.e2e-run-id=${runID}`,
  ];
  const image = `antnest/agent-acp-service:${tag}`;
  const privateRole = (role) => [
    "create",
    "--pull",
    "never",
    "--name",
    `${project}-permission-${role}`,
    ...labels(role),
    ...grants.args,
    `--add-host=edge-gateway:${env.ANTNEST_SERVICE_NETWORK_PREFIX}.130`,
    ...[
      "gateway-ingress",
      "observability",
      "acp-provider",
      ...grants.networks,
    ].flatMap((name) => ["--network", `${project}_${name}`]),
    ...Object.entries(clientEnvironment(env)).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]),
    ...mountArgs(role),
    image,
    "node",
    `/app/tests/e2e/acp-permissions/${role}.mjs`,
  ];
  return {
    client: privateRole("client"),
    cleanup: privateRole("cleanup"),
    model: [
      "run",
      "-d",
      "--pull",
      "never",
      "--name",
      `${project}-permission-model`,
      ...labels("model"),
      "--user",
      user,
      ...["acp-provider", "controller-provider"].flatMap((name) => [
        "--network",
        `name=${project}_${name},alias=permission-model`,
      ]),
      ...mountArgs("model"),
      image,
      "node",
      "/app/tests/e2e/acp-permissions/model.mjs",
    ],
  };
}
function actualSetting(row, name, value) {
  assert.deepEqual(
    (row.Config.Env ?? []).filter((item) => item.startsWith(name + "=")),
    [name + "=" + value],
  );
}
export function inspectPermissionHarness(
  rows,
  env,
  role,
  imageID,
  { evidence, state = role === "model" ? "running" : "created", exitCode = 0 },
) {
  const { project, runID, tag } = configuration(env);
  assert(["client", "cleanup", "model"].includes(role));
  assert.match(imageID ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert(Array.isArray(rows) && rows.length === 1);
  const row = rows[0];
  assert.match(row.Id ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(row.Image, imageID);
  assert.equal(row.Config.Image, `antnest/agent-acp-service:${tag}`);
  assert.equal(row.Config.Labels["com.docker.compose.project"], project);
  assert.equal(
    row.Config.Labels["com.docker.compose.service"],
    "permission-" + role,
  );
  assert.equal(row.Config.Labels["io.antnest.e2e-run-id"], runID);
  assert.equal(row.Config.User, serviceUser(env));
  assert.deepEqual(row.Config.Cmd, [
    "node",
    `/app/tests/e2e/acp-permissions/${role}.mjs`,
  ]);
  assert(["created", "running", "exited"].includes(state));
  assert(Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255);
  assert.equal(row.State.Status, state);
  assert.equal(row.State.Running, state === "running");
  for (const key of ["Paused", "Restarting", "Dead", "OOMKilled"])
    assert.equal(row.State[key], false);
  assert.equal(row.State.ExitCode, exitCode);
  assert.equal(row.State.Error, "");
  assert.equal(row.HostConfig.Privileged, false);
  assert.equal(row.HostConfig.PidMode, "");
  assert.equal((row.HostConfig.CapAdd ?? []).length, 0);
  assert.equal((row.HostConfig.Devices ?? []).length, 0);
  const sort = (items) =>
    items.sort((a, b) => a.Destination.localeCompare(b.Destination));
  const mounts = sort(
    row.Mounts.map(({ Type, Source, Destination, RW }) => ({
      Type,
      Source,
      Destination,
      RW,
    })),
  );
  assert.deepEqual(mounts, sort(harnessMounts(env, role, evidence)));
  if (role !== "model")
    for (const [name, value] of Object.entries(clientEnvironment(env)))
      actualSetting(row, name, value);
  const networks =
    role === "model"
      ? ["acp-provider", "controller-provider"]
      : [
          "gateway-ingress",
          "observability",
          "acp-provider",
          "identity-clients",
          "edge",
        ];
  assert.deepEqual(
    Object.keys(row.NetworkSettings.Networks).sort(),
    networks.map((name) => project + "_" + name).sort(),
  );
  if (role === "model")
    for (const name of networks)
      assert(
        row.NetworkSettings.Networks[project + "_" + name].Aliases.includes(
          "permission-model",
        ),
      );
  assert.deepEqual(
    [...(row.HostConfig.ExtraHosts ?? [])].sort(),
    role === "model"
      ? []
      : [
          "identity-service:" + env.ANTNEST_SERVICE_NETWORK_PREFIX + ".66",
          "agent-acp-service:" + env.ANTNEST_SERVICE_NETWORK_PREFIX + ".5",
          "edge-gateway:" + env.ANTNEST_SERVICE_NETWORK_PREFIX + ".130",
        ].sort(),
  );
  return {
    project,
    run_id: runID,
    role,
    container_id: row.Id,
    image_id: row.Image,
    image_ref: row.Config.Image,
    user: row.Config.User,
    mounts,
  };
}

function inspectPermissionImages(rows, env, manifest) {
  const { project } = checkedPermissionManifest(manifest, env, true);
  inspectDeployment(rows, project);
  const actual = [];
  for (const name of services) {
    const selected = manifest.images.find((item) => item.name === name);
    const found = rows.filter(
      (row) => row.Config.Labels["com.docker.compose.service"] === name,
    );
    assert.equal(found.length, 1);
    const row = found[0];
    assert.match(row.Id ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(row.Image, selected.id);
    assert.equal(row.Config.Image, selected.ref);
    assert.equal(row.Config.Labels[owner], project);
    assert.equal(row.State.Status, "running");
    for (const key of ["Paused", "Restarting", "Dead", "OOMKilled"])
      assert.equal(row.State[key], false);
    assert.equal(row.State.ExitCode, 0);
    assert.equal(row.State.Error, "");
    if (name === "runtime-controller")
      actualSetting(row, "ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE", selected.ref);
    if (name === "admin-console")
      actualSetting(
        row,
        "ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF",
        env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
      );
    actual.push({
      service: name,
      container_id: row.Id,
      image_id: row.Image,
      image_ref: row.Config.Image,
    });
  }
  return { project, services: actual };
}
function harnessOwnership(row, { project, runID }, role, id) {
  assert.equal(row.Id, id);
  assert.equal(row.Config.Labels["com.docker.compose.project"], project);
  assert.equal(row.Config.Labels["io.antnest.e2e-run-id"], runID);
  assert.equal(
    row.Config.Labels["com.docker.compose.service"],
    "permission-" + role,
  );
}
function startedAt(row) {
  const value = row.State.StartedAt;
  assert.match(value ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z$/u);
  assert(Number.isFinite(Date.parse(value)) && Date.parse(value) > 0);
  return value;
}
export function inspectPermissionRuntimes(rows, env, manifest, agents) {
  const { project } = checkedPermissionManifest(manifest, env, true);
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
  const selected = manifest.images.find(
    (item) => item.name === "antnest-runtime",
  );
  return agents.map((agent) => {
    const found = rows.filter(
      (row) => row.Config.Labels["io.antnest.agent-id"] === agent,
    );
    assert.equal(found.length, 1);
    const row = found[0];
    assert.match(row.Id ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(row.State.Running, true);
    assert.equal(row.State.Status, "running");
    assert.equal(row.State.Health?.Status, "healthy");
    for (const key of ["Paused", "Restarting", "Dead", "OOMKilled"])
      assert.equal(row.State[key], false);
    assert.equal(row.State.ExitCode, 0);
    assert.equal(row.State.Error, "");
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
      started_at: startedAt(row),
    };
  });
}

async function cleanupHarness(docker, env, directory, save) {
  const config = configuration(env);
  let attempts;
  try {
    attempts = JSON.parse(
      await readFile(join(directory, "harness-attempts.private.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert(Array.isArray(attempts) && attempts.length <= 3);
  assert.equal(new Set(attempts.map((row) => row.role)).size, attempts.length);
  for (const record of attempts) {
    assert(["model", "cleanup", "client"].includes(record.role));
    assert.equal(record.project, config.project);
    assert.equal(record.run_id, config.runID);
    if (record.container_id !== null)
      assert.match(record.container_id ?? "", /^[a-f0-9]{64}$/u);
  }
  const errors = [];
  const attempt = async (action) => {
    try {
      return await action();
    } catch (error) {
      errors.push(error);
    }
  };
  const original = async (role) => {
    const record = attempts.find((row) => row.role === role);
    if (!record) return { absent: true, role };
    const target = {
      id: record.container_id,
      permitted: Boolean(record.container_id),
      role,
      absent: false,
    };
    if (!target.id)
      await attempt(async () => {
        const found = (
          await docker([
            "ps",
            "-aq",
            "--no-trunc",
            "--filter",
            `label=com.docker.compose.project=${config.project}`,
            "--filter",
            `label=io.antnest.e2e-run-id=${config.runID}`,
            "--filter",
            `label=com.docker.compose.service=permission-${role}`,
          ])
        )
          .split(/\s+/u)
          .filter(Boolean);
        assert(found.length <= 1, "ambiguous Permission harness recovery");
        if (found.length) {
          assert.match(found[0], /^[a-f0-9]{64}$/u);
          target.id = found[0];
          target.permitted = true;
        } else target.absent = true;
      });
    if (target.id)
      await attempt(async () => {
        const raw = await docker(["inspect", target.id]);
        await attempt(() =>
          save(`cleanup-${role}.private.json`, raw + "\n", true),
        );
        try {
          const rows = JSON.parse(raw);
          assert(Array.isArray(rows) && rows.length === 1);
          harnessOwnership(rows[0], config, role, target.id);
          target.row = rows[0];
        } catch (error) {
          target.permitted = false;
          throw error;
        }
      });
    return target;
  };
  const remove = async (target) => {
    if (target.absent) return true;
    if (!target.id || !target.permitted) return false;
    if (target.row?.State.Running)
      await attempt(async () => {
        await docker(["stop", "--time", "5", target.id]);
        await docker(["wait", target.id], true);
      });
    await attempt(async () => {
      const raw = await docker(["logs", target.id], false, {
        captureStderr: true,
      });
      await save(`cleanup-${target.role}.private.log`, raw + "\n", true);
    });
    let joined = false;
    await attempt(async () => {
      await docker(["rm", "-f", "-v", target.id]);
      joined = true;
    });
    return joined;
  };
  // A precreated cleaner exists before the business client can create Agents.
  // Stop and join that client first, then retain the model for cleanup diagnostics.
  const clientJoined = await remove(await original("client"));
  const cleaner = await original("cleanup");
  if (cleaner.id && cleaner.permitted)
    await attempt(async () => {
      assert(clientJoined, "Permission business client was not joined");
      assert(cleaner.row, "independent cleanup needs its actual inspection");
      const manifest = JSON.parse(
        await readFile(join(directory, "candidate-images.json"), "utf8"),
      );
      checkedPermissionManifest(manifest, env, true);
      const imageID = manifest.images.find(
        (row) => row.name === "agent-acp-service",
      ).id;
      inspectPermissionHarness([cleaner.row], env, "cleanup", imageID, {
        evidence: directory,
      });
      await docker(["start", cleaner.id]);
      const code = await docker(["wait", cleaner.id], true);
      assert.match(code, /^(?:0|[1-9]\d{0,2})$/u);
      const exitCode = Number(code);
      const raw = await docker(["inspect", cleaner.id]);
      await save("cleanup-terminal.private.json", raw + "\n", true);
      const rows = JSON.parse(raw);
      assert.equal(rows[0]?.Id, cleaner.id);
      inspectPermissionHarness(rows, env, "cleanup", imageID, {
        evidence: directory,
        state: "exited",
        exitCode,
      });
      cleaner.row = rows[0];
      await save("cleanup-result.json", {
        project: config.project,
        run_id: config.runID,
        container_id: cleaner.id,
        exit_code: exitCode,
      });
      assert.equal(exitCode, 0, "independent Permission cleanup failed");
    });
  await remove(cleaner);
  await remove(await original("model"));
  if (errors.length)
    throw new AggregateError(errors, "Permission harness cleanup failed");
}

export async function runPermissionDeployment(
  action,
  { env, directory, docker, signal, timeout = 900000 },
) {
  assert(
    [
      "build",
      "cleanup",
      "cleanup-harness",
      "inspect-stack",
      "create-harness",
      "inspect-runtimes",
    ].includes(action),
  );
  signal?.throwIfAborted();
  const config = configuration(env),
    { project, runID } = config;
  directory = durablePath(directory);
  shellStoragePreflight(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const save = (name, value, raw = false) =>
    writeEvidenceFile(
      directory,
      name,
      raw ? value : JSON.stringify(value) + "\n",
    );
  const capture = async (name, args, boundedSignal = signal) => {
    const raw = await docker(args, false, { signal: boundedSignal });
    save(name, raw + "\n", true);
    boundedSignal?.throwIfAborted();
    return JSON.parse(raw);
  };
  if (action === "cleanup-harness")
    return cleanupHarness(docker, env, directory, save);
  const manifestPath = join(directory, "candidate-images.json");
  if (action === "build") {
    let first = true;
    return buildPermissionImages(docker, env, async (record) => {
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
    return cleanupPermissionImages(docker, env, manifest);
  checkedPermissionManifest(manifest, env, true);
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
    assert(ids.length > 0, "Permission stack has no actual containers");
    const rows = await capture("deployment.private.json", ["inspect", ...ids]);
    const result = inspectPermissionImages(rows, env, manifest);
    save("actual-candidate-images.json", result);
    return result;
  }
  const imageID = manifest.images.find(
    (item) => item.name === "agent-acp-service",
  ).id;
  if (action === "create-harness") {
    const args = permissionHarnessArguments(env, { evidence: directory });
    for (const role of ["model", "cleanup", "client"])
      assert.equal(
        await docker([
          "ps",
          "-aq",
          "--no-trunc",
          "--filter",
          `name=^/${project}-permission-${role}$`,
        ]),
        "",
        "Permission harness name already exists",
      );
    for (const name of ["traces", "deployment"]) {
      const target = join(directory, name);
      await mkdir(target, { recursive: true, mode: 0o700 });
      assert.deepEqual(
        await readdir(target),
        [],
        "Permission client directory must be empty",
      );
    }
    shellStoragePreflight(directory);
    const attempts = [],
      receipts = [];
    await writeFile(join(directory, "harness-attempts.private.json"), "[]\n", {
      flag: "wx",
      mode: 0o600,
    });
    for (const role of ["model", "cleanup", "client"]) {
      signal?.throwIfAborted();
      attempts.push({ role, project, run_id: runID, container_id: null });
      save("harness-attempts.private.json", attempts);
      const id = await docker(args[role]);
      assert.match(id, /^[a-f0-9]{64}$/u);
      attempts.at(-1).container_id = id;
      save("harness-attempts.private.json", attempts);
      const rows = await capture(`permission-${role}.private.json`, [
        "inspect",
        id,
      ]);
      assert.equal(rows[0]?.Id, id);
      const receipt = inspectPermissionHarness(rows, env, role, imageID, {
        evidence: directory,
      });
      save(`permission-${role}-receipt.json`, receipt);
      receipts.push(receipt);
    }
    return receipts;
  }
  const expected = [];
  const starts = new Map();
  for (const role of ["model", "cleanup", "client"]) {
    const rows = JSON.parse(
      await readFile(
        join(directory, `permission-${role}.private.json`),
        "utf8",
      ),
    );
    const receipt = inspectPermissionHarness(rows, env, role, imageID, {
      evidence: directory,
    });
    assert.deepEqual(
      receipt,
      JSON.parse(
        await readFile(
          join(directory, `permission-${role}-receipt.json`),
          "utf8",
        ),
      ),
    );
    if (role === "model") starts.set(role, startedAt(rows[0]));
    expected.push(receipt);
  }
  let sequence = 0;
  const check = async (boundedSignal, clientExited = false) => {
    const rows = await capture(
      `harness-live-${String(++sequence).padStart(6, "0")}.private.json`,
      ["inspect", ...expected.map((row) => row.container_id)],
      boundedSignal,
    );
    assert(Array.isArray(rows) && rows.length === 3);
    for (const original of expected) {
      const found = rows.filter((row) => row.Id === original.container_id);
      const current = inspectPermissionHarness(
        found,
        env,
        original.role,
        imageID,
        {
          evidence: directory,
          state:
            original.role === "cleanup"
              ? "created"
              : clientExited && original.role === "client"
                ? "exited"
                : "running",
          exitCode: clientExited && original.role === "client" ? 137 : 0,
        },
      );
      assert.deepEqual(
        current,
        original,
        "original Permission harness changed",
      );
      if (original.role === "cleanup") continue;
      const started = startedAt(found[0]);
      if (starts.has(original.role))
        assert.equal(
          started,
          starts.get(original.role),
          "original Permission harness restarted",
        );
      else starts.set(original.role, started);
    }
  };
  class CrashComplete extends Error {
    constructor(result) {
      super("Permission crash control completed");
      this.result = result;
    }
  }
  const crash = env.ANTNEST_E2E_PERMISSION_CRASH === "true";
  try {
    return await servePermissionRuntimeInspection({
      env,
      directory: join(directory, "deployment"),
      signal,
      timeout,
      inspect: async (request, boundedSignal) => {
        assert(
          !crash,
          "crash control must not request or publish a Runtime ACK",
        );
        await check(boundedSignal);
        const ids = (
          await docker(
            [
              "ps",
              "-q",
              "--no-trunc",
              "--filter",
              `label=io.antnest.runtime-controller-scope=${project}`,
              "--filter",
              "label=io.antnest.managed=runtime",
            ],
            false,
            { signal: boundedSignal },
          )
        )
          .split(/\s+/u)
          .filter(Boolean);
        assert.equal(ids.length, 2);
        const raw =
          (await docker(["inspect", ...ids], false, {
            signal: boundedSignal,
          })) + "\n";
        save("runtime-containers.private.json", raw, true);
        boundedSignal.throwIfAborted();
        const runtimes = inspectPermissionRuntimes(
          JSON.parse(raw),
          env,
          manifest,
          request.agent_ids,
        );
        await check(boundedSignal);
        save("actual-runtimes.json", runtimes);
        return {
          raw_sha256: createHash("sha256").update(raw).digest("hex"),
          runtimes,
        };
      },
      waiting: async (boundedSignal) => {
        await check(boundedSignal);
        if (!crash) return;
        const original = expected.find((row) => row.role === "client");
        const raw = await docker(["logs", original.container_id], false, {
          signal: boundedSignal,
          captureStderr: true,
        });
        const ready = raw.split(/\r?\n/u).some((line) => {
          try {
            const value = JSON.parse(line);
            return (
              value?.status === "crash_ready" && Object.keys(value).length === 1
            );
          } catch {
            return false;
          }
        });
        if (!ready) return;
        save("crash-ready.private.log", raw + "\n", true);
        await docker(
          ["kill", "--signal", "KILL", original.container_id],
          false,
          { signal: boundedSignal },
        );
        const code = await docker(["wait", original.container_id], true, {
          signal: boundedSignal,
        });
        assert.equal(code, "137");
        const rows = await capture(
          "crash-terminal.private.json",
          ["inspect", original.container_id],
          boundedSignal,
        );
        const terminal = inspectPermissionHarness(
          rows,
          env,
          "client",
          imageID,
          { evidence: directory, state: "exited", exitCode: 137 },
        );
        assert.deepEqual(terminal, original);
        assert.equal(startedAt(rows[0]), starts.get("client"));
        await check(boundedSignal, true);
        const result = {
          status: "crash_control",
          project,
          run_id: runID,
          container_id: original.container_id,
          exit_code: 137,
        };
        save("crash-result.json", result);
        throw new CrashComplete(result);
      },
    });
  } catch (error) {
    if (error instanceof CrashComplete) return error.result;
    throw error;
  }
}

async function main() {
  const [action] = process.argv.slice(2),
    env = process.env;
  const { project } = configuration(env);
  const directory = join(
    root,
    "artifacts/verification/acp-permissions",
    project,
  );
  const controller = new AbortController(),
    stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  try {
    const remaining = Number(env.ANTNEST_E2E_DEADLINE_MS) - Date.now();
    assert(Number.isSafeInteger(remaining) && remaining > 0);
    try {
      await runPermissionDeployment(action, {
        env,
        directory,
        docker: dockerClient(env, controller.signal, remaining),
        signal: controller.signal,
        timeout: Math.min(remaining, 900000),
      });
    } catch (error) {
      try {
        shellStoragePreflight(directory);
        writeEvidenceFile(
          directory,
          `deployment-${action}-failure.private.txt`,
          inspectError(error, {
            depth: null,
            maxArrayLength: null,
            maxStringLength: null,
          }) + "\n",
        );
      } catch (storage) {
        throw new AggregateError(
          [error, storage],
          "Permission deployment evidence preservation failed",
          { cause: storage },
        );
      }
      throw error;
    }
    console.log(
      JSON.stringify({ stage: `permission-${action}`, status: "completed" }),
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
        stage: "permission-deployment",
        status: "failed",
        ...summarizeFailure(error),
      }),
    );
    process.exitCode = 1;
  }
}
