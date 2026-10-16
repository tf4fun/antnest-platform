import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestMultimodalRuntimeInspection } from "./runtime-inspection.mjs";

const url = new URL("./deployment.mjs", import.meta.url);
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
const project = "antnest-stage3-e2e-1234",
  runID = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855",
  tag = "multimodal-" + runID;
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
const env = {
  COMPOSE_PROJECT_NAME: project,
  ANTNEST_E2E_RUN_ID: runID,
  ANTNEST_ADMISSION_TAG: tag,
  ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF: `antnest/antnest-runtime:${tag}`,
  ANTNEST_SERVICE_AUTH_DIRECTORY: "/fixture/credentials",
  ANTNEST_SERVICE_AUTH_UID: "501",
  ANTNEST_SERVICE_AUTH_GID: "20",
  ANTNEST_SERVICE_NETWORK_PREFIX: "10.242.187",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318",
};
const id = (n) => "sha256:" + String(n).padStart(64, "0");
const ref = (name) => `antnest/${name}:${tag}`;
const manifest = () => ({
  version: 1,
  project,
  run_id: runID,
  tag,
  attempted: names.map(ref),
  images: names.map((name, i) => ({ name, ref: ref(name), id: id(i + 1) })),
});
function dockerFixture({ existing, failBuild, beforeBuild } = {}) {
  const calls = [],
    images = new Map();
  const image = (ref, index) => ({
    Id: id(index),
    RepoTags: [ref],
    Config: { Labels: { "io.antnest.deployment-admission": project } },
  });
  if (existing) images.set(existing, image(existing, 99));
  let builds = 0;
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
        images.set(target, image(target, ++builds));
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

test("command candidates cover all current release images with owned unique tags", () => {
  const plan = entry("multimodalImagePlan")(env);
  assert.deepEqual(
    plan.map((item) => item.name),
    names,
  );
  for (const item of plan) {
    assert.equal(item.ref, ref(item.name));
    assert(item.command.includes("io.antnest.deployment-admission=" + project));
    assert(!item.command.includes("--target"));
    assert(item.command.includes(item.ref));
  }
  assert(plan.at(-1).command.includes("runtimes/antnest-runtime/Dockerfile"));
});
test("only explicitly provided CI images may supply the command candidate build", () => {
  const plan = entry("multimodalImagePlan")({
    ...env,
    ANTNEST_CI_PROVIDED_IMAGES: "identity-service,antnest-runtime",
  });
  for (const item of plan)
    assert.equal(
      item.command.includes(`IMAGE=antnest/${item.name}:local`),
      ["identity-service", "antnest-runtime"].includes(item.name),
    );
});
for (const change of [
  { COMPOSE_PROJECT_NAME: "production" },
  { ANTNEST_E2E_RUN_ID: "" },
  { ANTNEST_ADMISSION_TAG: "local" },
  { ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF: "antnest/antnest-runtime:local" },
])
  test(
    "command selection rejects unrelated deployment " + Object.keys(change)[0],
    () => {
      const plan = entry("multimodalImagePlan");
      assert.throws(() => plan({ ...env, ...change }));
    },
  );
test("builds persist attempted ownership before starting and preserve actual image identities", async () => {
  const build = entry("buildMultimodalImages"),
    saved = [],
    f = dockerFixture({
      beforeBuild(target) {
        assert.equal(saved.at(-1).attempted.at(-1), target);
        assert(!saved.at(-1).images.some((item) => item.ref === target));
        assert.equal(
          f.calls.filter(
            (item) => item.args[0] === "image" && item.args[1] === "ls",
          ).length,
          11,
        );
      },
    });
  const result = await build(f.docker, env, (value) =>
    saved.push(structuredClone(value)),
  );
  assert.deepEqual(result, manifest());
  assert.equal(saved[0].attempted.length, 0);
  assert.equal(saved[1].attempted.length, 1);
  assert.equal(saved[1].images.length, 0);
  for (const call of f.calls.filter((item) => item.args[0] === "build"))
    assert(
      !Object.keys(call.options.env).some((key) => key.startsWith("OTEL_")),
    );
});
test("a collision prevents every build and cannot be adopted for cleanup", async () => {
  const build = entry("buildMultimodalImages"),
    f = dockerFixture({ existing: ref("identity-service") }),
    saved = [];
  await assert.rejects(build(f.docker, env, (value) => saved.push(value)));
  assert.deepEqual(saved, []);
  assert(
    !f.calls.some((item) => item.args[0] === "build" || item.args[1] === "rm"),
  );
});
test("interrupted image builds are cleaned only through recorded owned tags", async () => {
  const build = entry("buildMultimodalImages"),
    cleanup = entry("cleanupMultimodalImages"),
    f = dockerFixture({ failBuild: 3 });
  let record;
  await assert.rejects(
    build(f.docker, env, (value) => {
      record = structuredClone(value);
    }),
  );
  assert.equal(record.attempted.length, 3);
  await cleanup(f.docker, env, record);
  assert.equal(f.images.size, 0);
  assert(
    !f.calls.some(
      (item) =>
        item.args.includes("--force") ||
        item.args.some((arg) => arg.endsWith(":local")),
    ),
  );
});
for (const mutation of [
  (image) => {
    image.Config.Labels["io.antnest.deployment-admission"] = "foreign";
  },
  (image) => {
    image.Id = id(99);
  },
])
  test("cleanup refuses changed image ownership or identity", async () => {
    const build = entry("buildMultimodalImages"),
      cleanup = entry("cleanupMultimodalImages"),
      f = dockerFixture();
    const record = await build(f.docker, env, () => {}),
      target = record.images[0].ref;
    mutation(f.images.get(target));
    await assert.rejects(cleanup(f.docker, env, record));
    assert(f.images.has(target));
  });

test("command harness uses current ACP and exactly two read-only grants on the required networks", () => {
  const { client, model } = entry("multimodalHarnessArguments")(env, {
    evidence: "/fixture/evidence",
  });
  assert.equal(client[client.indexOf("--user") + 1], "501:20");
  assert.equal(client.filter((item) => item === "--user").length, 1);
  assert.deepEqual(client.filter((arg) => arg.includes(":/run/auth/")).sort(), [
    "/fixture/credentials/agent-ui/tokens/agent-acp-service:/run/auth/agent-ui-acp:ro",
    "/fixture/credentials/edge-gateway/tokens/identity-service:/run/auth/gateway-identity:ro",
  ]);
  const networks = client.flatMap((arg, i) =>
    arg === "--network" ? [client[i + 1]] : [],
  );
  assert.deepEqual(
    new Set(networks),
    new Set(
      [
        "gateway-ingress",
        "observability",
        "acp-provider",
        "identity-clients",
        "edge",
      ].map((name) => `${project}_${name}`),
    ),
  );
  assert(client.includes("--add-host=agent-acp-service:10.242.187.5"));
  assert(client.includes("--add-host=identity-service:10.242.187.66"));
  assert(client.includes(`TEST_RUNTIME_IMAGE=${ref("antnest-runtime")}`));
  assert(client.includes("ANTNEST_MULTIMODAL_EVIDENCE_DIR=/evidence/traces"));
  assert(
    client.includes(
      "ANTNEST_MULTIMODAL_RUNTIME_CHECKPOINT_DIR=/evidence/deployment",
    ),
  );
  assert(
    client.includes(ref("agent-acp-service")) &&
      model.includes(ref("agent-acp-service")),
  );
  assert(
    !client.some((arg) => /docker\.sock|TEST_ACP_DATABASE|\/web\//u.test(arg)),
  );
  for (const network of ["acp-provider", "controller-provider"])
    assert(
      model.includes(`name=${project}_${network},alias=acp-closeout-model`),
    );
  assert.deepEqual(
    model.flatMap((arg, i) => (arg === "--network" ? [model[i + 1]] : [])),
    ["acp-provider", "controller-provider"].map(
      (name) => `name=${project}_${name},alias=acp-closeout-model`,
    ),
  );
  assert(
    !model.some(
      (arg) =>
        arg.includes("/run/auth/") ||
        arg.includes("credentials") ||
        arg.includes("docker.sock"),
    ),
  );
});

const state = () => ({
  Running: true,
  Status: "running",
  Health: { Status: "healthy" },
  Paused: false,
  Restarting: false,
  Dead: false,
  OOMKilled: false,
  ExitCode: 0,
  Error: "",
});
function row(name, index = 1) {
  const expected = manifest().images.find((item) => item.name === name);
  return {
    Id: String(index).padStart(64, "0"),
    Image: expected?.id ?? id(90),
    State: state(),
    Config: {
      Image: expected?.ref ?? name,
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": name,
        "io.antnest.deployment-admission": project,
      },
      Env: [],
    },
    HostConfig: {
      PortBindings: Object.fromEntries(
        Array.from(
          {
            length:
              name === "diagnostic-relay" ? 2 : name === "edge-gateway" ? 1 : 0,
          },
          (_, i) => [
            `${i}/tcp`,
            [{ HostIp: "127.0.0.1", HostPort: String(40000 + i) }],
          ],
        ),
      ),
    },
  };
}
function stack() {
  const rows = [
    ...names.filter((name) => name !== "antnest-runtime"),
    "postgres",
    "jaeger",
    "diagnostic-relay",
    "runtime-telemetry-ingress",
  ].map((name, i) => row(name, i + 1));
  rows
    .find(
      (item) =>
        item.Config.Labels["com.docker.compose.service"] ===
        "runtime-controller",
    )
    .Config.Env.push(
      "ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE=" + ref("runtime-controller"),
    );
  rows
    .find(
      (item) =>
        item.Config.Labels["com.docker.compose.service"] === "admin-console",
    )
    .Config.Env.push(
      "ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=" + ref("antnest-runtime"),
    );
  return rows;
}
test("actual Compose and preparer images must match the independently built candidate set", () => {
  const inspect = entry("inspectMultimodalImages");
  assert.equal(inspect(stack(), env, manifest()).services.length, 10);
  for (const mutate of [
    (rows) => {
      rows[0].Image = id(99);
    },
    (rows) => {
      rows[0].Config.Image = "antnest/admin-console:local";
    },
    (rows) => {
      rows[0].Config.Labels["io.antnest.deployment-admission"] = "foreign";
    },
    (rows) => {
      rows[0].State.Health.Status = "unhealthy";
    },
    (rows) => {
      rows.find(
        (item) =>
          item.Config.Labels["com.docker.compose.service"] ===
          "runtime-controller",
      ).Config.Env = [
        "ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE=antnest/runtime-controller:local",
      ];
    },
    (rows) => {
      rows[0].HostConfig.PortBindings = {
        "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }],
      };
    },
    (rows) => {
      rows.push(structuredClone(rows[0]));
    },
  ]) {
    const rows = stack();
    mutate(rows);
    assert.throws(() => inspect(rows, env, manifest()));
  }
});
test("harness inspection binds the actual model and created client to the same current ACP image", () => {
  const inspect = entry("inspectMultimodalHarness");
  for (const role of ["client", "model"]) {
    const actual = row("agent-acp-service");
    actual.Config.Labels["com.docker.compose.service"] = "multimodal-" + role;
    actual.Config.Labels["io.antnest.e2e-run-id"] = runID;
    if (role === "client") {
      actual.State.Running = false;
      actual.State.Status = "created";
    }
    assert.equal(inspect([actual], env, role, id(2)).image_id, id(2));
    actual.Image = id(99);
    assert.throws(() => inspect([actual], env, role, id(2)));
  }
});
function runtime(agent, index) {
  const actual = row("antnest-runtime", index);
  actual.Config.Image = id(11);
  actual.Config.Labels = {
    "io.antnest.managed": "runtime",
    "io.antnest.runtime-controller-scope": project,
    "io.antnest.agent-id": agent,
    "io.antnest.runtime-generation": "1",
  };
  actual.Config.Env = [
    "ANTNEST_RUNTIME_IMAGE_REFERENCE=" + ref("antnest-runtime"),
    "ANTNEST_RUNTIME_IMAGE_ID=" + id(11),
  ];
  return actual;
}
test("two actual Runtime containers must match both created Agents and the candidate image", () => {
  const inspect = entry("inspectMultimodalRuntimes"),
    agents = ["agent-one", "agent-two"];
  const rows = [runtime(agents[0], 1), runtime(agents[1], 2)];
  const checked = inspect(rows, env, manifest(), agents);
  assert.deepEqual(
    checked.map((item) => item.agent_id),
    agents,
  );
  for (const mutate of [
    (r) => {
      r.pop();
    },
    (r) => {
      r.push(structuredClone(r[0]));
    },
    (r) => {
      r[1].Config.Labels["io.antnest.agent-id"] = agents[0];
    },
    (r) => {
      r[1].Id = r[0].Id;
    },
    (r) => {
      r[0].Image = id(99);
    },
    (r) => {
      r[0].Config.Labels["io.antnest.runtime-controller-scope"] = "foreign";
    },
    (r) => {
      r[0].Config.Labels["io.antnest.runtime-generation"] = "0";
    },
    (r) => {
      r[0].State.Running = false;
    },
    (r) => {
      r[0].Config.Env[0] =
        "ANTNEST_RUNTIME_IMAGE_REFERENCE=antnest/antnest-runtime:local";
    },
  ]) {
    const altered = structuredClone(rows);
    mutate(altered);
    assert.throws(() => inspect(altered, env, manifest(), agents));
  }
});

async function deploymentFixture(t, record = true) {
  const directory = await mkdtemp(
    join(tmpdir(), "antnest-command-deployment-"),
  );
  const controller = new AbortController(),
    pending = [];
  const signal = AbortSignal.any([controller.signal, t.signal]);
  t.after(async () => {
    controller.abort(new Error("deployment test finished"));
    await Promise.allSettled(pending);
    await rm(directory, { recursive: true, force: true });
  });
  if (record)
    await writeFile(
      join(directory, "candidate-images.json"),
      JSON.stringify(manifest()),
    );
  return {
    directory,
    options: { env, directory, signal, timeout: 2000 },
    track(promise) {
      pending.push(promise);
      promise.catch(() => {});
      return promise;
    },
  };
}

test("deployment runner saves real build progress and resumes only recorded cleanup", async (t) => {
  const run = entry("runMultimodalDeployment"),
    f = await deploymentFixture(t, false);
  const docker = dockerFixture({ failBuild: 3 });
  await assert.rejects(
    run("build", { ...f.options, docker: docker.docker }),
    /interrupted build/,
  );
  const saved = JSON.parse(
    await readFile(join(f.directory, "candidate-images.json"), "utf8"),
  );
  assert.equal(saved.attempted.length, 3);
  assert.equal(saved.images.length, 2);
  await run("cleanup", { ...f.options, docker: docker.docker });
  assert.equal(docker.images.size, 0);
});

for (const valid of [true, false])
  test(
    "deployment runner archives actual stack inspection before " +
      (valid ? "acceptance" : "refusal"),
    async (t) => {
      const run = entry("runMultimodalDeployment"),
        f = await deploymentFixture(t);
      const rows = stack();
      if (!valid) rows[0].Image = id(99);
      const completed = [
        "skill-registry-database-init",
        "temporal-databases",
        "temporal-schema",
        "temporal-namespace",
      ].map((name, index) => {
        const actual = row(name, 90 + index);
        actual.State.Status = "exited";
        actual.State.Running = false;
        return actual;
      });
      const raw = JSON.stringify(rows, null, 2),
        calls = [];
      let selected;
      const docker = async (args) => {
        calls.push(args);
        if (args[0] === "ps") {
          assert(args.includes("label=com.docker.compose.project=" + project));
          selected = args.includes("-aq") ? [...rows, ...completed] : rows;
          return selected.map((row) => row.Id).join("\n");
        }
        assert.deepEqual(args, ["inspect", ...selected.map((row) => row.Id)]);
        return JSON.stringify(selected, null, 2);
      };
      const result = run("inspect-stack", { ...f.options, docker });
      if (valid) await result;
      else await assert.rejects(result);
      assert.equal(
        await readFile(join(f.directory, "deployment.private.json"), "utf8"),
        raw + "\n",
      );
      const files = await readdir(f.directory);
      assert.equal(files.includes("actual-candidate-images.json"), valid);
      assert.equal(calls.length, 2);
    },
  );

test("deployment runner inspects both current harness containers before admission", async (t) => {
  const run = entry("runMultimodalDeployment"),
    f = await deploymentFixture(t);
  const roles = [];
  let actual;
  await run("create-harness", {
    ...f.options,
    docker: async (args) => {
      if (["run", "create"].includes(args[0])) {
        const role = args[0] === "run" ? "model" : "client";
        roles.push(role);
        assert(args.includes(ref("agent-acp-service")));
        actual = row("agent-acp-service", roles.length);
        actual.Config.Labels["com.docker.compose.service"] =
          "multimodal-" + role;
        actual.Config.Labels["io.antnest.e2e-run-id"] = runID;
        if (role === "client") {
          actual.State.Status = "created";
          actual.State.Running = false;
        }
        return actual.Id;
      }
      assert.deepEqual(args, ["inspect", actual.Id]);
      return JSON.stringify([actual]);
    },
  });
  assert.deepEqual(roles, ["model", "client"]);
  for (const role of roles) {
    const receipt = JSON.parse(
      await readFile(
        join(f.directory, `multimodal-${role}-receipt.json`),
        "utf8",
      ),
    );
    assert.equal(receipt.image_id, id(2));
    assert.equal(receipt.role, role);
    assert.equal(
      JSON.parse(
        await readFile(
          join(f.directory, `multimodal-${role}.private.json`),
          "utf8",
        ),
      )[0].Image,
      receipt.image_id,
    );
  }
});

for (const valid of [true, false])
  test(
    "host Runtime checkpoint " +
      (valid
        ? "binds its receipt to the archived Docker bytes"
        : "retains wrong-image evidence without acknowledging it"),
    async (t) => {
      const run = entry("runMultimodalDeployment"),
        f = await deploymentFixture(t);
      const agents = ["agent-one", "agent-two"],
        rows = agents.map((agent, index) => runtime(agent, index + 1));
      if (!valid) rows[0].Image = id(99);
      const raw = JSON.stringify(rows, null, 2);
      const client = f.track(
        requestMultimodalRuntimeInspection(agents, {
          ...f.options,
          directory: join(f.directory, "deployment"),
        }),
      );
      const host = f.track(
        run("inspect-runtimes", {
          ...f.options,
          docker: async (args) => {
            if (args[0] === "ps") {
              assert(args.includes("label=io.antnest.managed=runtime"));
              assert(
                args.includes(
                  "label=io.antnest.runtime-controller-scope=" + project,
                ),
              );
              return rows.map((row) => row.Id).join("\n");
            }
            assert.deepEqual(args, ["inspect", ...rows.map((row) => row.Id)]);
            return raw;
          },
        }),
      );
      if (!valid) {
        await assert.rejects(host);
        assert(
          !(await readdir(join(f.directory, "deployment"))).includes(
            "runtime-receipt.json",
          ),
        );
      } else {
        const [receipt, acknowledged] = await Promise.all([host, client]);
        assert.deepEqual(receipt, acknowledged);
        const captured = await readFile(
          join(f.directory, "deployment", "runtime-containers.private.json"),
        );
        assert.equal(
          receipt.raw_sha256,
          createHash("sha256").update(captured).digest("hex"),
        );
        assert(receipt.runtimes.every((row) => row.image_id === id(11)));
      }
      assert.equal(
        await readFile(
          join(f.directory, "deployment", "runtime-containers.private.json"),
          "utf8",
        ),
        raw + "\n",
      );
    },
  );

test("host stops waiting when the actual command client exits before its checkpoint", async (t) => {
  const run = entry("runMultimodalDeployment"),
    f = await deploymentFixture(t);
  let checks = 0;
  await assert.rejects(
    run("inspect-runtimes", {
      ...f.options,
      docker: async (args) => {
        checks++;
        assert.deepEqual(args, ["inspect", `${project}-multimodal-client`]);
        return JSON.stringify([{ State: { Running: false } }]);
      },
    }),
    /client exited before Runtime inspection/,
  );
  assert.equal(checks, 1);
  assert.deepEqual(await readdir(join(f.directory, "deployment")), []);
});
