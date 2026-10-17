import assert from "node:assert/strict";
import {
  candidateCommand,
  candidateEnvironment,
} from "../../support/candidate-images.mjs";
import { imageSpec } from "../../support/ci-changes.mjs";

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

function configuration(env) {
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

export function permissionImagePlan(env) {
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

export async function buildPermissionImages(docker, env, save) {
  const { project, runID, tag } = configuration(env),
    plan = permissionImagePlan(env);
  for (const { ref } of plan)
    assert.equal(
      await docker(["image", "ls", "-q", ref]),
      "",
      "Permission candidate tag already exists",
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
export function checkedPermissionManifest(record, env, complete = false) {
  const { project, runID, tag } = configuration(env),
    plan = permissionImagePlan(env);
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
export async function cleanupPermissionImages(docker, env, record) {
  const { project } = checkedPermissionManifest(record, env),
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
    throw new AggregateError(failures, "Permission candidate cleanup failed");
}
