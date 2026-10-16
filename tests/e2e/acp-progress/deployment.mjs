import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { inspect as inspectError } from "node:util";
import {
  candidateCommand,
  candidateEnvironment,
} from "../../support/candidate-images.mjs";
import { imageSpec } from "../../support/ci-changes.mjs";
import { grantContainerArgs } from "../../support/service-grants.mjs";
import {
  durablePath,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { inspectDeployment } from "../stage3-base/deployment.mjs";
import { serveProgressGates } from "./gate.mjs";

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
  const project = env.COMPOSE_PROJECT_NAME,
    runID = env.ANTNEST_E2E_RUN_ID;
  assert.match(project ?? "", /^antnest-stage3-e2e-\d+$/u);
  assert.match(runID ?? "", /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  const tag = "progress-" + runID;
  assert.equal(env.ANTNEST_ADMISSION_TAG, tag);
  assert.equal(
    env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    `antnest/antnest-runtime:${tag}`,
  );
  return { project, runID, tag };
}

export function progressImagePlan(env) {
  const { project, tag } = configuration(env);
  const runtime = `antnest/antnest-runtime:${tag}`;
  const input = (name, source, ref, fixture = false) => {
    const spec = imageSpec(fixture ? "antnest-runtime" : source);
    assert(!spec.target && !spec.args && !spec.contexts);
    return {
      name,
      ref,
      command: candidateCommand(
        {
          name: source,
          tag: ref,
          labels: { [owner]: project },
          build: [
            "docker",
            "build",
            "--label",
            `${owner}=${project}`,
            ...(fixture ? ["--target", "build"] : []),
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
  };
  return [
    ...services.map((name) => input(name, name, `antnest/${name}:${tag}`)),
    input("runtime-base", "antnest-runtime", runtime + "-base"),
    input(
      "runtime-fixture",
      "antnest-runtime-fixture",
      runtime + "-fixture",
      true,
    ),
    // This COPY must run even when CI supplies both source images. Replacing it
    // through candidateCommand would silently deploy the base without fixture.
    {
      name: "antnest-runtime",
      ref: runtime,
      command: [
        "docker",
        "build",
        "--label",
        `${owner}=${project}`,
        "--build-arg",
        `RUNTIME_IMAGE=${runtime}-base`,
        "--build-arg",
        `RUNTIME_BUILD_IMAGE=${runtime}-fixture`,
        "-f",
        "tests/e2e/managed-mcp/Dockerfile",
        "-t",
        runtime,
        ".",
      ],
    },
  ];
}
function inspectedImage(raw, ref, project) {
  const rows = JSON.parse(raw);
  assert(Array.isArray(rows) && rows.length === 1);
  const row = rows[0];
  assert.match(row.Id ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert(row.RepoTags?.includes(ref));
  assert.equal(row.Config?.Labels?.[owner], project);
  return row;
}
function runtimeBase(record, project) {
  const selected = (name) => record.images.find((item) => item.name === name);
  const base = selected("runtime-base"),
    fixture = selected("runtime-fixture");
  assert(base && fixture);
  assert.deepEqual(record.runtime_inputs, {
    base: base.id,
    fixture: fixture.id,
  });
  const sourceChecks = ["before", "after"].flatMap((point) =>
    [base, fixture].map((source) => ({ point, source })),
  );
  assert.equal(record.runtime_source_checks?.length, sourceChecks.length);
  for (const [index, { point, source }] of sourceChecks.entries()) {
    const check = record.runtime_source_checks[index];
    assert.equal(check.point, point);
    assert.equal(check.ref, source.ref);
    assert.equal(inspectedImage(check.raw, source.ref, project).Id, source.id);
  }
  const original = (ref) => {
    const found = record.inspections.filter((item) => item.ref === ref);
    assert.equal(found.length, 1);
    return inspectedImage(found[0].raw, ref, project);
  };
  const production = original(base.ref),
    final = original(configurationRef(record));
  assert.equal(production.Id, base.id);
  assert.equal(original(fixture.ref).Id, fixture.id);
  assert.equal(production.RootFS.Type, "layers");
  assert.equal(final.RootFS.Type, "layers");
  assert(
    Array.isArray(production.RootFS.Layers) &&
      production.RootFS.Layers.length > 0,
  );
  assert.equal(final.RootFS.Layers.length, production.RootFS.Layers.length + 1);
  assert.deepEqual(final.RootFS.Layers.slice(0, -1), production.RootFS.Layers);
  for (const key of [
    "User",
    "Entrypoint",
    "Cmd",
    "Env",
    "WorkingDir",
    "Healthcheck",
  ])
    assert.deepEqual(
      final.Config[key],
      production.Config[key],
      "final fixture image changed production Runtime " + key,
    );
}
function configurationRef(record) {
  return `antnest/antnest-runtime:${record.tag}`;
}

export async function buildProgressImages(docker, env, save) {
  const { project, runID, tag } = configuration(env),
    plan = progressImagePlan(env);
  for (const { ref } of plan)
    assert.equal(
      await docker(["image", "ls", "-q", ref]),
      "",
      "Progress candidate tag already exists",
    );
  const record = {
    version: 1,
    project,
    run_id: runID,
    tag,
    attempted: [],
    images: [],
    inspections: [],
    commands: [],
    runtime_inputs: null,
    runtime_source_checks: [],
  };
  const checkRuntimeSources = async (point) => {
    for (const name of ["runtime-base", "runtime-fixture"]) {
      const source = record.images.find((item) => item.name === name);
      const raw = await docker(["image", "inspect", source.ref]);
      record.runtime_source_checks.push({ point, ref: source.ref, raw });
      await save(record);
      assert.equal(inspectedImage(raw, source.ref, project).Id, source.id);
    }
  };
  await save(record);
  for (const { name, ref, command } of plan) {
    const args = command.slice(1);
    assert.equal(command[0], "docker");
    if (name === "antnest-runtime") {
      const base = record.images.find(
        (item) => item.name === "runtime-base",
      ).id;
      const fixture = record.images.find(
        (item) => item.name === "runtime-fixture",
      ).id;
      record.runtime_inputs = { base, fixture };
      // BuildKit resolves bare image IDs as registry names. Use this run's
      // private source refs and retain their actual identities on both sides
      // of the COPY, in addition to the final production layer/config checks.
      await checkRuntimeSources("before");
    }
    record.attempted.push(ref);
    record.commands.push({ ref, args });
    await save(record);
    await docker(args, true, { env: candidateEnvironment(env) });
    const raw = await docker(["image", "inspect", ref]);
    record.inspections.push({ ref, raw });
    await save(record);
    if (name === "antnest-runtime") await checkRuntimeSources("after");
    const row = inspectedImage(raw, ref, project);
    if (name === "antnest-runtime") runtimeBase(record, project);
    record.images.push({ name, ref, id: row.Id });
    await save(record);
  }
  return record;
}
function checkedManifest(record, env, complete = false) {
  const { project, runID, tag } = configuration(env),
    plan = progressImagePlan(env);
  assert.equal(record.version, 1);
  assert.equal(record.project, project);
  assert.equal(record.run_id, runID);
  assert.equal(record.tag, tag);
  assert(Array.isArray(record.attempted) && Array.isArray(record.images));
  assert.deepEqual(
    record.attempted,
    plan.slice(0, record.attempted.length).map((item) => item.ref),
  );
  assert(record.images.length <= record.attempted.length);
  for (const [index, item] of record.images.entries()) {
    assert.equal(item.name, plan[index].name);
    assert.equal(item.ref, plan[index].ref);
    assert.match(item.id ?? "", /^sha256:[a-f0-9]{64}$/u);
    const actual = record.inspections.filter((value) => value.ref === item.ref);
    assert.equal(actual.length, 1);
    assert.equal(inspectedImage(actual[0].raw, item.ref, project).Id, item.id);
  }
  if (complete) {
    assert.equal(record.images.length, plan.length);
    runtimeBase(record, project);
  }
  return { project };
}
export async function cleanupProgressImages(docker, env, record) {
  const { project } = checkedManifest(record, env),
    failures = [];
  // Remove the final COPY image before its two source aliases.
  for (const ref of [...record.attempted].reverse()) {
    try {
      if (!(await docker(["image", "ls", "-q", ref]))) continue;
      const row = inspectedImage(
        await docker(["image", "inspect", ref]),
        ref,
        project,
      );
      const selected = record.images.find((item) => item.ref === ref);
      if (selected) assert.equal(row.Id, selected.id);
      const captured = record.inspections.filter((item) => item.ref === ref);
      assert(captured.length <= 1);
      if (captured.length)
        assert.equal(row.Id, inspectedImage(captured[0].raw, ref, project).Id);
      await docker(["image", "rm", ref]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Progress candidate cleanup failed");
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
    ...(role === "client"
      ? [
          ...["traces", "gate", "deployment"].map((name) =>
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
    ANTNEST_PROGRESS_EVIDENCE_DIR: "/evidence/traces",
    ANTNEST_PROGRESS_GATE_DIR: "/evidence/gate",
    ANTNEST_PROGRESS_RUNTIME_CHECKPOINT_DIR: "/evidence/deployment",
  };
}
export function progressHarnessArguments(env, { evidence }) {
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
    `com.docker.compose.service=progress-${role}`,
    "--label",
    `io.antnest.e2e-run-id=${runID}`,
  ];
  const image = `antnest/agent-acp-service:${tag}`;
  return {
    client: [
      "create",
      "--pull",
      "never",
      "--name",
      `${project}-progress-client`,
      ...labels("client"),
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
      ...mountArgs("client"),
      image,
      "node",
      "/app/tests/e2e/acp-progress/client.mjs",
    ],
    model: [
      "run",
      "-d",
      "--pull",
      "never",
      "--name",
      `${project}-progress-model`,
      ...labels("model"),
      "--user",
      user,
      ...["acp-provider", "controller-provider"].flatMap((name) => [
        "--network",
        `name=${project}_${name},alias=progress-model`,
      ]),
      ...mountArgs("model"),
      image,
      "node",
      "/app/tests/e2e/acp-progress/model.mjs",
    ],
  };
}
function actualSetting(row, name, value) {
  assert.deepEqual(
    (row.Config.Env ?? []).filter((item) => item.startsWith(name + "=")),
    [name + "=" + value],
  );
}
export function inspectProgressHarness(
  rows,
  env,
  role,
  imageID,
  { evidence, running = role === "model" },
) {
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
    "progress-" + role,
  );
  assert.equal(row.Config.Labels["io.antnest.e2e-run-id"], runID);
  assert.equal(row.Config.User, serviceUser(env));
  assert.deepEqual(row.Config.Cmd, [
    "node",
    `/app/tests/e2e/acp-progress/${role}.mjs`,
  ]);
  assert.equal(row.State.Status, running ? "running" : "created");
  assert.equal(row.State.Running, running);
  for (const key of ["Paused", "Restarting", "Dead", "OOMKilled"])
    assert.equal(row.State[key], false);
  assert.equal(row.State.ExitCode, 0);
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
  if (role === "client")
    for (const [name, value] of Object.entries(clientEnvironment(env)))
      actualSetting(row, name, value);
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

function inspectProgressImages(rows, env, manifest) {
  const { project } = checkedManifest(manifest, env, true);
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
    "progress-" + role,
  );
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
  assert(Array.isArray(attempts) && attempts.length <= 2);
  assert.equal(
    new Set(attempts.map((item) => item.role)).size,
    attempts.length,
  );
  const errors = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  for (const record of [...attempts].reverse()) {
    assert(["client", "model"].includes(record.role));
    assert.equal(record.project, config.project);
    assert.equal(record.run_id, config.runID);
    let id = record.container_id,
      permitted = Boolean(id);
    if (id) assert.match(id, /^[a-f0-9]{64}$/u);
    else
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
            `label=com.docker.compose.service=progress-${record.role}`,
          ])
        )
          .split(/\s+/u)
          .filter(Boolean);
        assert(found.length <= 1);
        if (found.length) {
          assert.match(found[0], /^[a-f0-9]{64}$/u);
          id = found[0];
          permitted = true;
        }
      });
    if (!id) continue;
    await attempt(async () => {
      const raw = await docker(["inspect", id]);
      // Preserve raw inspection independently of ownership validation. A failed
      // write must not prevent removal of a known original create result.
      await attempt(() =>
        save(`cleanup-${record.role}.private.json`, raw + "\n", true),
      );
      try {
        const rows = JSON.parse(raw);
        assert(Array.isArray(rows) && rows.length === 1);
        harnessOwnership(rows[0], config, record.role, id);
        permitted = true;
      } catch (error) {
        permitted = false;
        throw error;
      }
    });
    if (!permitted) continue;
    await attempt(async () => {
      const raw = await docker(["logs", id], false, { captureStderr: true });
      save(`cleanup-${record.role}.private.log`, raw + "\n", true);
    });
    await attempt(() => docker(["rm", "-f", "-v", id]));
  }
  if (errors.length)
    throw new AggregateError(errors, "Progress harness cleanup failed");
}

export async function runProgressDeployment(
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
      "serve-gates",
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
    return buildProgressImages(docker, env, async (record) => {
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
  if (action === "cleanup") return cleanupProgressImages(docker, env, manifest);
  checkedManifest(manifest, env, true);
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
    assert(ids.length > 0, "Progress stack has no actual containers");
    const rows = await capture("deployment.private.json", ["inspect", ...ids]);
    const result = inspectProgressImages(rows, env, manifest);
    save("actual-candidate-images.json", result);
    return result;
  }
  const imageID = manifest.images.find(
    (item) => item.name === "agent-acp-service",
  ).id;
  if (action === "create-harness") {
    const args = progressHarnessArguments(env, { evidence: directory });
    for (const role of ["model", "client"])
      assert.equal(
        await docker([
          "ps",
          "-aq",
          "--no-trunc",
          "--filter",
          `name=^/${project}-progress-${role}$`,
        ]),
        "",
        "Progress harness name already exists",
      );
    for (const name of ["traces", "gate", "deployment"]) {
      const target = join(directory, name);
      await mkdir(target, { recursive: true, mode: 0o700 });
      assert.deepEqual(
        await readdir(target),
        [],
        "Progress client directory must be empty",
      );
    }
    shellStoragePreflight(directory);
    const attempts = [],
      receipts = [];
    await writeFile(join(directory, "harness-attempts.private.json"), "[]\n", {
      flag: "wx",
      mode: 0o600,
    });
    for (const role of ["model", "client"]) {
      signal?.throwIfAborted();
      attempts.push({ role, project, run_id: runID, container_id: null });
      save("harness-attempts.private.json", attempts);
      const id = await docker(args[role]);
      assert.match(id, /^[a-f0-9]{64}$/u);
      attempts.at(-1).container_id = id;
      save("harness-attempts.private.json", attempts);
      const rows = await capture(`progress-${role}.private.json`, [
        "inspect",
        id,
      ]);
      assert.equal(rows[0]?.Id, id);
      const receipt = inspectProgressHarness(rows, env, role, imageID, {
        evidence: directory,
      });
      save(`progress-${role}-receipt.json`, receipt);
      receipts.push(receipt);
    }
    return receipts;
  }
  const expected = [];
  for (const role of ["model", "client"]) {
    const rows = JSON.parse(
      await readFile(join(directory, `progress-${role}.private.json`), "utf8"),
    );
    const receipt = inspectProgressHarness(rows, env, role, imageID, {
      evidence: directory,
    });
    assert.deepEqual(
      receipt,
      JSON.parse(
        await readFile(
          join(directory, `progress-${role}-receipt.json`),
          "utf8",
        ),
      ),
    );
    expected.push(receipt);
  }
  const starts = new Map();
  let sequence = 0;
  const check = async (boundedSignal) => {
    const rows = await capture(
      `harness-live-${String(++sequence).padStart(6, "0")}.private.json`,
      ["inspect", ...expected.map((row) => row.container_id)],
      boundedSignal,
    );
    assert(Array.isArray(rows) && rows.length === 2);
    for (const original of expected) {
      const found = rows.filter((row) => row.Id === original.container_id);
      const current = inspectProgressHarness(
        found,
        env,
        original.role,
        imageID,
        { evidence: directory, running: true },
      );
      assert.deepEqual(current, original, "original Progress harness changed");
      const started = found[0].State.StartedAt;
      assert.match(
        started ?? "",
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z$/u,
      );
      assert(Number.isFinite(Date.parse(started)) && Date.parse(started) > 0);
      if (starts.has(original.role))
        assert.equal(
          started,
          starts.get(original.role),
          "original Progress harness restarted",
        );
      else starts.set(original.role, started);
    }
  };
  return serveProgressGates({
    env,
    directory: join(directory, "gate"),
    evidence: join(directory, "host-gate"),
    checkpointDirectory: join(directory, "deployment"),
    imageID: manifest.images.find((item) => item.name === "antnest-runtime").id,
    docker,
    signal,
    timeout,
    check,
  });
}

async function main() {
  const [action] = process.argv.slice(2),
    env = process.env;
  const { project } = configuration(env);
  const directory = join(root, "artifacts/verification/acp-progress", project);
  const controller = new AbortController(),
    stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  try {
    const remaining = Number(env.ANTNEST_E2E_DEADLINE_MS) - Date.now();
    assert(Number.isSafeInteger(remaining) && remaining > 0);
    try {
      await runProgressDeployment(action, {
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
          "Progress deployment evidence preservation failed",
          { cause: storage },
        );
      }
      throw error;
    }
    console.log(
      JSON.stringify({ stage: `progress-${action}`, status: "completed" }),
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
        stage: "progress-deployment",
        status: "failed",
        ...summarizeFailure(error),
      }),
    );
    process.exitCode = 1;
  }
}
