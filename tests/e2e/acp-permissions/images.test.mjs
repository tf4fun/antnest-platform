import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./images.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const entry = (name) => {
  assert.equal(typeof implementation[name], "function", name);
  return implementation[name];
};
const project = "antnest-stage3-e2e-1234";
const runID = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855";
const tag = "permission-" + runID;
const owner = "io.antnest.deployment-admission";
const ref = (name) => `antnest/${name}:${tag}`;
const id = (value) => "sha256:" + String(value).padStart(64, "0");
const env = {
  COMPOSE_PROJECT_NAME: project,
  ANTNEST_E2E_RUN_ID: runID,
  ANTNEST_ADMISSION_TAG: tag,
  ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF: ref("antnest-runtime"),
  ANTNEST_SERVICE_AUTH_DIRECTORY: "/fixture/credentials",
  ANTNEST_SERVICE_AUTH_UID: "501",
  ANTNEST_SERVICE_AUTH_GID: "20",
  ANTNEST_SERVICE_NETWORK_PREFIX: "10.242.187",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318",
};
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
const names = [
  ...services,
  "runtime-base",
  "runtime-fixture",
  "antnest-runtime",
];
function fixture({ existing, failBuild, mutate, beforeBuild } = {}) {
  const calls = [],
    images = new Map();
  let builds = 0;
  function image(target, index) {
    return {
      Id: id(index),
      RepoTags: [target],
      RootFS: {
        Type: "layers",
        Layers: [
          id(100),
          ...(target === ref("antnest-runtime") ? [id(101)] : []),
        ],
      },
      Config: {
        Labels: { [owner]: project },
        User: "1000:1000",
        Entrypoint: ["/usr/local/bin/antnest-runtime"],
        Cmd: null,
        Env: ["PATH=/usr/bin"],
        WorkingDir: "/workspace",
        Healthcheck: { Test: ["CMD", "health"] },
      },
    };
  }
  if (existing) images.set(existing, image(existing, 99));
  return {
    calls,
    images,
    async docker(args, long, options) {
      calls.push({ args, long, options });
      if (args[0] === "image" && args[1] === "ls")
        return images.get(args.at(-1))?.Id ?? "";
      if (args[0] === "build") {
        const target = args[args.indexOf("-t") + 1];
        await beforeBuild?.(target);
        const actual = image(target, ++builds);
        mutate?.(actual, target);
        images.set(target, actual);
        if (builds === failBuild) throw new Error("interrupted build");
        return "";
      }
      if (args[0] === "image" && args[1] === "inspect")
        return JSON.stringify([images.get(args.at(-1))]);
      if (args[0] === "image" && args[1] === "rm") {
        images.delete(args.at(-1));
        return "";
      }
      throw new Error("unexpected Docker operation");
    },
  };
}
test("Permission builds all services, a production Runtime base and fixture source before the final candidate", () => {
  const plan = entry("permissionImagePlan")(env);
  assert.deepEqual(
    plan.map((item) => item.name),
    names,
  );
  assert.equal(new Set(plan.map((item) => item.ref)).size, 13);
  for (const item of plan) {
    assert(item.command.includes(`${owner}=${project}`));
    assert(item.command.includes(item.ref));
  }
  assert(plan.at(-3).command.includes("runtimes/antnest-runtime/Dockerfile"));
  assert(!plan.at(-3).command.includes("--target"));
  assert(plan.at(-2).command.includes("--target"));
  assert(plan.at(-1).command.includes("tests/e2e/managed-mcp/Dockerfile"));
  assert.equal(plan.at(-1).ref, ref("antnest-runtime"));
});
test("provided CI sources replace only the base and fixture builds, never the final fixture COPY", () => {
  const plan = entry("permissionImagePlan")({
    ...env,
    ANTNEST_CI_PROVIDED_IMAGES:
      "identity-service,antnest-runtime,antnest-runtime-fixture",
  });
  assert(
    plan
      .find((item) => item.name === "identity-service")
      .command.includes("IMAGE=antnest/identity-service:local"),
  );
  assert(plan.at(-3).command.includes("IMAGE=antnest/antnest-runtime:local"));
  assert(
    plan.at(-2).command.includes("IMAGE=antnest/antnest-runtime-fixture:local"),
  );
  assert(plan.at(-1).command.includes("tests/e2e/managed-mcp/Dockerfile"));
  assert(!plan.at(-1).command.some((item) => item.startsWith("IMAGE=")));
});
for (const change of [
  { COMPOSE_PROJECT_NAME: "production" },
  { ANTNEST_E2E_RUN_ID: "" },
  { ANTNEST_ADMISSION_TAG: "local" },
  { ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF: "antnest/antnest-runtime:local" },
])
  test(
    "Permission rejects unrelated configuration " + Object.keys(change)[0],
    () => {
      const plan = entry("permissionImagePlan");
      assert.throws(() => plan({ ...env, ...change }));
    },
  );
test("build records attempts before effects, original inspections and exact base/fixture image IDs", async () => {
  const saved = [],
    f = fixture({
      beforeBuild(target) {
        assert.equal(saved.at(-1).attempted.at(-1), target);
        assert.equal(
          f.calls.filter(
            (call) => call.args[0] === "image" && call.args[1] === "ls",
          ).length,
          13,
        );
      },
    });
  const result = await entry("buildPermissionImages")(f.docker, env, (record) =>
    saved.push(structuredClone(record)),
  );
  assert.equal(result.images.length, 13);
  assert.equal(result.inspections.length, 13);
  for (const inspection of result.inspections)
    assert.equal(
      JSON.parse(inspection.raw)[0].Id,
      result.images.find((item) => item.ref === inspection.ref).id,
    );
  assert.deepEqual(result.runtime_inputs, { base: id(11), fixture: id(12) });
  const final = f.calls.filter((call) => call.args[0] === "build").at(-1);
  assert(
    final.args.includes("RUNTIME_IMAGE=" + ref("antnest-runtime") + "-base"),
  );
  assert(
    final.args.includes(
      "RUNTIME_BUILD_IMAGE=" + ref("antnest-runtime") + "-fixture",
    ),
  );
  assert.deepEqual(
    result.runtime_source_checks.map((check) => [
      check.point,
      check.ref,
      JSON.parse(check.raw)[0].Id,
    ]),
    [
      ["before", ref("antnest-runtime") + "-base", id(11)],
      ["before", ref("antnest-runtime") + "-fixture", id(12)],
      ["after", ref("antnest-runtime") + "-base", id(11)],
      ["after", ref("antnest-runtime") + "-fixture", id(12)],
    ],
  );
  assert.deepEqual(result.commands.at(-1).args, final.args);
  for (const call of f.calls.filter((item) => item.args[0] === "build"))
    assert(
      !Object.keys(call.options.env).some((key) => key.startsWith("OTEL_")),
    );
});

for (const source of ["base", "fixture"])
  test(`source ${source} reference replaced during final COPY cannot be admitted`, async () => {
    const target = ref("antnest-runtime") + "-" + source;
    const f = fixture({
      beforeBuild(refValue) {
        if (refValue === ref("antnest-runtime"))
          f.images.get(target).Id = id(99);
      },
    });
    let record;
    await assert.rejects(
      entry("buildPermissionImages")(f.docker, env, (value) => {
        record = structuredClone(value);
      }),
    );
    assert(
      record.runtime_source_checks.some(
        (check) =>
          check.point === "after" &&
          check.ref === target &&
          JSON.parse(check.raw)[0].Id === id(99),
      ),
    );
    assert(!record.images.some((item) => item.name === "antnest-runtime"));
  });
test("source reference replaced before final COPY is rejected before issuing the build", async () => {
  const f = fixture(),
    target = ref("antnest-runtime") + "-base";
  let reads = 0;
  const docker = async (args, ...rest) => {
    if (
      args[0] === "image" &&
      args[1] === "inspect" &&
      args.at(-1) === target &&
      ++reads === 2
    )
      f.images.get(target).Id = id(99);
    return f.docker(args, ...rest);
  };
  await assert.rejects(entry("buildPermissionImages")(docker, env, () => {}));
  assert(
    !f.calls.some(
      (call) =>
        call.args[0] === "build" && call.args.includes(ref("antnest-runtime")),
    ),
  );
});
test("a collision in a support image prevents all builds and cleanup adoption", async () => {
  const f = fixture({ existing: ref("antnest-runtime") + "-fixture" }),
    saved = [];
  await assert.rejects(
    entry("buildPermissionImages")(f.docker, env, (record) =>
      saved.push(record),
    ),
  );
  assert.deepEqual(saved, []);
  assert(!f.calls.some((call) => call.args[0] === "build"));
});
for (const failedBuild of [3, 12, 13])
  test(`interrupted build ${failedBuild} cleans every recorded candidate in reverse order`, async () => {
    const f = fixture({ failBuild: failedBuild });
    let record;
    await assert.rejects(
      entry("buildPermissionImages")(f.docker, env, (value) => {
        record = structuredClone(value);
      }),
    );
    await entry("cleanupPermissionImages")(f.docker, env, record);
    assert.equal(f.images.size, 0);
    assert.deepEqual(
      f.calls
        .filter((call) => call.args[1] === "rm")
        .map((call) => call.args.at(-1)),
      [...record.attempted].reverse(),
    );
    assert(!f.calls.some((call) => call.args.includes("--force")));
  });
for (const corrupt of ["layer", "entrypoint", "user", "environment"])
  test(`final Runtime rejects changed production base ${corrupt}`, async () => {
    const f = fixture({
      mutate(image, target) {
        if (target !== ref("antnest-runtime")) return;
        if (corrupt === "layer") image.RootFS.Layers[0] = id(99);
        if (corrupt === "entrypoint") image.Config.Entrypoint = ["/fixture"];
        if (corrupt === "user") image.Config.User = "0:0";
        if (corrupt === "environment") image.Config.Env.push("SECRET=changed");
      },
    });
    await assert.rejects(
      entry("buildPermissionImages")(f.docker, env, () => {}),
    );
  });
for (const mutate of [
  (image) => {
    image.Id = id(99);
  },
  (image) => {
    image.Config.Labels[owner] = "foreign";
  },
])
  test("cleanup refuses a substituted owned candidate while continuing other removals", async () => {
    const f = fixture(),
      record = await entry("buildPermissionImages")(f.docker, env, () => {}),
      target = record.images[1].ref;
    mutate(f.images.get(target));
    await assert.rejects(
      entry("cleanupPermissionImages")(f.docker, env, record),
    );
    assert.deepEqual([...f.images.keys()], [target]);
  });

test("failed final validation still binds cleanup to its already captured image ID", async () => {
  const f = fixture({
    mutate(image, target) {
      if (target === ref("antnest-runtime")) image.RootFS.Layers[0] = id(99);
    },
  });
  let record;
  await assert.rejects(
    entry("buildPermissionImages")(f.docker, env, (value) => {
      record = structuredClone(value);
    }),
  );
  assert.equal(record.images.length, 12);
  assert.equal(record.inspections.length, 13);
  f.images.get(ref("antnest-runtime")).Id = id(98);
  await assert.rejects(entry("cleanupPermissionImages")(f.docker, env, record));
  assert.deepEqual([...f.images.keys()], [ref("antnest-runtime")]);
});
