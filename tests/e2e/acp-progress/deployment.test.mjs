import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

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
const root = fileURLToPath(new URL("../../../", import.meta.url));
const project = "antnest-stage3-e2e-1234";
const runID = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855";
const tag = "progress-" + runID;
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
const contracts = [
  "contracts/identity/identity-contract.json",
  "contracts/agent-controller/control-contract.json",
  "services/runtime-controller/api/control-contract.json",
];
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
test("Progress builds all services, a production Runtime base and fixture source before the final candidate", () => {
  const plan = entry("progressImagePlan")(env);
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
  const plan = entry("progressImagePlan")({
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
    "Progress rejects unrelated configuration " + Object.keys(change)[0],
    () => {
      const plan = entry("progressImagePlan");
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
  const result = await entry("buildProgressImages")(f.docker, env, (record) =>
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
      entry("buildProgressImages")(f.docker, env, (value) => {
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
  await assert.rejects(entry("buildProgressImages")(docker, env, () => {}));
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
    entry("buildProgressImages")(f.docker, env, (record) => saved.push(record)),
  );
  assert.deepEqual(saved, []);
  assert(!f.calls.some((call) => call.args[0] === "build"));
});
for (const failedBuild of [3, 12, 13])
  test(`interrupted build ${failedBuild} cleans every recorded candidate in reverse order`, async () => {
    const f = fixture({ failBuild: failedBuild });
    let record;
    await assert.rejects(
      entry("buildProgressImages")(f.docker, env, (value) => {
        record = structuredClone(value);
      }),
    );
    await entry("cleanupProgressImages")(f.docker, env, record);
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
    await assert.rejects(entry("buildProgressImages")(f.docker, env, () => {}));
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
      record = await entry("buildProgressImages")(f.docker, env, () => {}),
      target = record.images[1].ref;
    mutate(f.images.get(target));
    await assert.rejects(entry("cleanupProgressImages")(f.docker, env, record));
    assert.deepEqual([...f.images.keys()], [target]);
  });

const values = (args, flag) =>
  args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
function mounts(role, evidence = "/fixture/evidence") {
  return [
    {
      Type: "bind",
      Source: join(root, "tests"),
      Destination: "/app/tests",
      RW: false,
    },
    ...(role === "client"
      ? [
          ...["traces", "gate", "deployment"].map((name) => ({
            Type: "bind",
            Source: join(evidence, name),
            Destination: `/evidence/${name}`,
            RW: true,
          })),
          ...contracts.map((name) => ({
            Type: "bind",
            Source: join(root, name),
            Destination: "/app/" + name,
            RW: false,
          })),
          {
            Type: "bind",
            Source: "/fixture/credentials/edge-gateway/tokens/identity-service",
            Destination: "/run/auth/gateway-identity",
            RW: false,
          },
          {
            Type: "bind",
            Source: "/fixture/credentials/agent-ui/tokens/agent-acp-service",
            Destination: "/run/auth/agent-ui-acp",
            RW: false,
          },
        ]
      : []),
  ];
}
function harness(role) {
  return {
    Id: "a".repeat(64),
    Image: id(2),
    State: {
      ...state(),
      Running: role === "model",
      Status: role === "model" ? "running" : "created",
    },
    Config: {
      Image: ref("agent-acp-service"),
      User: "501:20",
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": "progress-" + role,
        "io.antnest.e2e-run-id": runID,
      },
      Env:
        role === "client"
          ? [
              `TEST_RUNTIME_IMAGE=${ref("antnest-runtime")}`,
              `COMPOSE_PROJECT_NAME=${project}`,
              `ANTNEST_E2E_RUN_ID=${runID}`,
              "ANTNEST_PROGRESS_EVIDENCE_DIR=/evidence/traces",
              "ANTNEST_PROGRESS_GATE_DIR=/evidence/gate",
              "ANTNEST_PROGRESS_RUNTIME_CHECKPOINT_DIR=/evidence/deployment",
            ]
          : [],
      Cmd: ["node", `/app/tests/e2e/acp-progress/${role}.mjs`],
    },
    Mounts: mounts(role),
    HostConfig: { Privileged: false, PidMode: "", CapAdd: null, Devices: [] },
  };
}
test("non-root Progress client mounts only three writable evidence subdirectories and two exact read-only grants", () => {
  const args = entry("progressHarnessArguments")(env, {
    evidence: "/fixture/evidence",
  });
  for (const role of ["client", "model"]) {
    assert.deepEqual(values(args[role], "--user"), ["501:20"]);
    assert.deepEqual(
      values(args[role], "-v").sort(),
      mounts(role)
        .map((row) => `${row.Source}:${row.Destination}${row.RW ? "" : ":ro"}`)
        .sort(),
    );
    assert(!args[role].some((arg) => arg.includes("docker.sock")));
    assert(args[role].includes(ref("agent-acp-service")));
  }
  assert.deepEqual(
    values(args.client, "--network").sort(),
    [
      "gateway-ingress",
      "observability",
      "acp-provider",
      "identity-clients",
      "edge",
    ]
      .map((name) => project + "_" + name)
      .sort(),
  );
  assert(args.client.includes("ANTNEST_PROGRESS_GATE_DIR=/evidence/gate"));
  assert.deepEqual(
    values(args.model, "--network"),
    ["acp-provider", "controller-provider"].map(
      (name) => `name=${project}_${name},alias=progress-model`,
    ),
  );
});
for (const user of ["0", "00", "root", "-1", "501:0"])
  test("reject root or malformed client UID " + user, () => {
    const args = entry("progressHarnessArguments");
    assert.throws(() =>
      args(
        { ...env, ANTNEST_SERVICE_AUTH_UID: user },
        { evidence: "/fixture/evidence" },
      ),
    );
  });
test("actual harness inspection verifies candidate image, user, exact mounts and runtime context", () => {
  for (const role of ["client", "model"]) {
    const result = entry("inspectProgressHarness")(
      [harness(role)],
      env,
      role,
      id(2),
      { evidence: "/fixture/evidence" },
    );
    assert.equal(result.image_id, id(2));
    assert.equal(result.user, "501:20");
    assert.deepEqual(
      result.mounts,
      mounts(role).sort((a, b) => a.Destination.localeCompare(b.Destination)),
    );
  }
});
for (const [label, mutate] of [
  [
    "root user",
    (row) => {
      row.Config.User = "0:0";
    },
  ],
  [
    "foreign image",
    (row) => {
      row.Image = id(99);
    },
  ],
  [
    "foreign run",
    (row) => {
      row.Config.Labels["io.antnest.e2e-run-id"] = "foreign";
    },
  ],
  [
    "privileged",
    (row) => {
      row.HostConfig.Privileged = true;
    },
  ],
  [
    "host PID",
    (row) => {
      row.HostConfig.PidMode = "host";
    },
  ],
  [
    "grant writable",
    (row) => {
      row.Mounts.find(
        (mount) => mount.Destination === "/run/auth/agent-ui-acp",
      ).RW = true;
    },
  ],
  [
    "all evidence",
    (row) => {
      row.Mounts.push({
        Type: "bind",
        Source: "/fixture/evidence",
        Destination: "/host",
        RW: true,
      });
    },
  ],
  [
    "socket",
    (row) => {
      row.Mounts.push({
        Type: "bind",
        Source: "/var/run/docker.sock",
        Destination: "/socket",
        RW: true,
      });
    },
  ],
  [
    "missing contract",
    (row) => {
      row.Mounts = row.Mounts.filter(
        (mount) => !mount.Destination.endsWith("identity-contract.json"),
      );
    },
  ],
  [
    "wrong private source",
    (row) => {
      row.Mounts.find(
        (mount) => mount.Destination === "/evidence/gate",
      ).Source = "/fixture/evidence/host-gate";
    },
  ],
  [
    "wrong checkpoint",
    (row) => {
      row.Config.Env.push("ANTNEST_PROGRESS_RUNTIME_CHECKPOINT_DIR=/wrong");
    },
  ],
])
  test("actual client rejects " + label, () => {
    const row = harness("client");
    mutate(row);
    const inspect = entry("inspectProgressHarness");
    assert.throws(() =>
      inspect([row], env, "client", id(2), { evidence: "/fixture/evidence" }),
    );
  });

test("failed final validation still binds cleanup to its already captured image ID", async () => {
  const f = fixture({
    mutate(image, target) {
      if (target === ref("antnest-runtime")) image.RootFS.Layers[0] = id(99);
    },
  });
  let record;
  await assert.rejects(
    entry("buildProgressImages")(f.docker, env, (value) => {
      record = structuredClone(value);
    }),
  );
  assert.equal(record.images.length, 12);
  assert.equal(record.inspections.length, 13);
  f.images.get(ref("antnest-runtime")).Id = id(98);
  await assert.rejects(entry("cleanupProgressImages")(f.docker, env, record));
  assert.deepEqual([...f.images.keys()], [ref("antnest-runtime")]);
});

test("a client evidence source cannot alias the private host diagnostics", async (t) => {
  const args = entry("progressHarnessArguments"),
    options = await deploymentFixture(t, false);
  await mkdir(join(options.directory, "host-gate"));
  await symlink(
    join(options.directory, "host-gate"),
    join(options.directory, "traces"),
  );
  assert.throws(() => args(env, { evidence: options.directory }), /links/u);
});

async function deploymentFixture(t, built = true) {
  const directory = await mkdtemp(
    join(tmpdir(), "antnest-progress-deployment-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (built) {
    const record = await entry("buildProgressImages")(
      fixture().docker,
      env,
      () => {},
    );
    await writeFile(
      join(directory, "candidate-images.json"),
      JSON.stringify(record),
    );
  }
  return { env, directory, signal: t.signal, timeout: 3000 };
}
function stack() {
  return [
    ...services,
    "postgres",
    "jaeger",
    "diagnostic-relay",
    "runtime-telemetry-ingress",
  ].map((name, index) => ({
    Id: String(index + 1).padStart(64, "0"),
    Image: id(index + 1),
    State: state(),
    Config: {
      Image: ref(name),
      Labels: {
        [owner]: project,
        "com.docker.compose.project": project,
        "com.docker.compose.service": name,
      },
      Env:
        name === "admin-console"
          ? [
              "ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=" +
                ref("antnest-runtime"),
            ]
          : name === "runtime-controller"
            ? [
                "ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE=" +
                  ref("runtime-controller"),
              ]
            : [],
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
  }));
}
test("runner persists partial build evidence before allowing recorded cleanup", async (t) => {
  const run = entry("runProgressDeployment"),
    options = await deploymentFixture(t, false),
    f = fixture({ failBuild: 12 });
  await assert.rejects(
    run("build", { ...options, docker: f.docker }),
    /interrupted build/u,
  );
  const record = JSON.parse(
    await readFile(join(options.directory, "candidate-images.json"), "utf8"),
  );
  assert.equal(record.attempted.length, 12);
  await run("cleanup", { ...options, docker: f.docker });
  assert.equal(f.images.size, 0);
});
for (const valid of [true, false])
  test(
    "runner archives actual stack before " +
      (valid ? "admission" : "rejection"),
    async (t) => {
      const run = entry("runProgressDeployment"),
        options = await deploymentFixture(t),
        rows = stack();
      if (!valid) rows[0].Image = id(99);
      const raw = JSON.stringify(rows, null, 2);
      const docker = async (args) => {
        if (args[0] === "ps") {
          assert(args.includes("label=com.docker.compose.project=" + project));
          assert(args.includes("-q"));
          return rows.map((row) => row.Id).join("\n");
        }
        assert.deepEqual(args, ["inspect", ...rows.map((row) => row.Id)]);
        return raw;
      };
      const result = run("inspect-stack", { ...options, docker });
      if (valid) await result;
      else await assert.rejects(result);
      assert.equal(
        await readFile(
          join(options.directory, "deployment.private.json"),
          "utf8",
        ),
        raw + "\n",
      );
      assert.equal(
        (await readdir(options.directory)).includes(
          "actual-candidate-images.json",
        ),
        valid,
      );
    },
  );
test("runner creates only empty private client subdirectories and records original container IDs before inspection", async (t) => {
  const run = entry("runProgressDeployment"),
    options = await deploymentFixture(t),
    roles = [];
  const rows = new Map();
  await run("create-harness", {
    ...options,
    docker: async (args) => {
      if (args[0] === "ps") return "";
      if (["run", "create"].includes(args[0])) {
        const role = args[0] === "run" ? "model" : "client";
        roles.push(role);
        const row = harness(role);
        row.Id = (role === "model" ? "a" : "b").repeat(64);
        row.Mounts = mounts(role, options.directory);
        rows.set(row.Id, row);
        return row.Id;
      }
      assert.equal(args[0], "inspect");
      const row = rows.get(args[1]);
      const attempts = JSON.parse(
        await readFile(
          join(options.directory, "harness-attempts.private.json"),
          "utf8",
        ),
      );
      assert.equal(attempts.at(-1).container_id, row.Id);
      return JSON.stringify([row]);
    },
  });
  assert.deepEqual(roles, ["model", "client"]);
  for (const name of ["traces", "gate", "deployment"]) {
    assert.equal(
      (await stat(join(options.directory, name))).mode & 0o777,
      0o700,
    );
    assert.deepEqual(await readdir(join(options.directory, name)), []);
  }
  for (const role of roles)
    assert.equal(
      JSON.parse(
        await readFile(
          join(options.directory, `progress-${role}-receipt.json`),
          "utf8",
        ),
      ).role,
      role,
    );
});
test("existing harness names prevent any adoption or creation", async (t) => {
  const run = entry("runProgressDeployment"),
    options = await deploymentFixture(t),
    calls = [];
  await assert.rejects(
    run("create-harness", {
      ...options,
      docker: async (args) => {
        calls.push(args);
        assert.equal(args[0], "ps");
        return "f".repeat(64);
      },
    }),
  );
  assert(calls.every((args) => args[0] === "ps"));
  assert(
    !(await readdir(options.directory)).includes(
      "harness-attempts.private.json",
    ),
  );
});
for (const failed of ["inspect", "logs"])
  test(
    "harness cleanup joins and removes the original ID even when " +
      failed +
      " fails",
    async (t) => {
      const run = entry("runProgressDeployment"),
        options = await deploymentFixture(t),
        row = harness("client"),
        calls = [];
      await writeFile(
        join(options.directory, "harness-attempts.private.json"),
        JSON.stringify([
          { role: "client", project, run_id: runID, container_id: row.Id },
        ]),
      );
      await assert.rejects(
        run("cleanup-harness", {
          ...options,
          docker: async (args) => {
            calls.push(args);
            if (args[0] === failed)
              throw new Error("controlled cleanup failure");
            if (args[0] === "inspect") return JSON.stringify([row]);
            if (args[0] === "logs") return "partial original log\n";
            if (args[0] === "rm") return "";
            throw new Error("unexpected cleanup command");
          },
        }),
      );
      assert(calls.some((args) => args[0] === "logs"));
      assert.deepEqual(
        calls.find((args) => args[0] === "rm"),
        ["rm", "-f", "-v", row.Id],
      );
    },
  );
test("actual CLI failure summary never prints private configuration", () => {
  const canary = "PRIVATE_PROGRESS_DEPLOYMENT_CANARY";
  const result = spawnSync(process.execPath, [url.pathname, "serve-gates"], {
    env: { ...process.env, COMPOSE_PROJECT_NAME: canary },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert(!result.stderr.includes(canary));
  assert.deepEqual(JSON.parse(result.stderr), {
    stage: "progress-deployment",
    status: "failed",
    error_type: "AssertionError",
    code: "ERR_ASSERTION",
  });
});

test("a missing create ID recovered by unique run labels still gets logs and removal after inspect failure", async (t) => {
  const run = entry("runProgressDeployment"),
    options = await deploymentFixture(t),
    calls = [],
    containerID = "e".repeat(64);
  await writeFile(
    join(options.directory, "harness-attempts.private.json"),
    JSON.stringify([
      { role: "client", project, run_id: runID, container_id: null },
    ]),
  );
  await assert.rejects(
    run("cleanup-harness", {
      ...options,
      docker: async (args) => {
        calls.push(args);
        if (args[0] === "ps") {
          for (const label of [
            `label=com.docker.compose.project=${project}`,
            `label=io.antnest.e2e-run-id=${runID}`,
            "label=com.docker.compose.service=progress-client",
          ])
            assert(args.includes(label));
          return containerID;
        }
        if (args[0] === "inspect") throw new Error("original inspect failed");
        if (args[0] === "logs" || args[0] === "rm") return "";
        throw new Error("unexpected cleanup command");
      },
    }),
  );
  assert(calls.some((args) => args[0] === "logs"));
  assert.deepEqual(
    calls.find((args) => args[0] === "rm"),
    ["rm", "-f", "-v", containerID],
  );
});
test("ambiguous recovery labels never authorize deleting either container", async (t) => {
  const run = entry("runProgressDeployment"),
    options = await deploymentFixture(t),
    calls = [];
  await writeFile(
    join(options.directory, "harness-attempts.private.json"),
    JSON.stringify([
      { role: "client", project, run_id: runID, container_id: null },
    ]),
  );
  await assert.rejects(
    run("cleanup-harness", {
      ...options,
      docker: async (args) => {
        calls.push(args);
        return "a".repeat(64) + "\n" + "b".repeat(64);
      },
    }),
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["ps"],
  );
});
test("actual CLI retains original command and storage failures without exposing either raw cause", async (t) => {
  const currentProject = `antnest-stage3-e2e-${process.pid}`;
  const directory = join(
    root,
    "artifacts/verification/acp-progress",
    currentProject,
  );
  await mkdir(join(root, "artifacts/verification/acp-progress"), {
    recursive: true,
  });
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "deployment-build-failure.private.txt"));
  const binary = await mkdtemp(join(tmpdir(), "antnest-progress-cli-"));
  t.after(() => rm(binary, { recursive: true, force: true }));
  const canary = "PRIVATE_PROGRESS_COMMAND_CANARY";
  await writeFile(
    join(binary, "docker"),
    `#!/bin/sh\nprintf '%s\\n' '${canary}' >&2\nexit 75\n`,
    { mode: 0o700 },
  );
  const result = spawnSync(process.execPath, [url.pathname, "build"], {
    env: {
      ...process.env,
      ...env,
      PATH: binary + ":" + process.env.PATH,
      COMPOSE_PROJECT_NAME: currentProject,
      ANTNEST_E2E_DEADLINE_MS: String(Date.now() + 10000),
    },
    encoding: "utf8",
    timeout: 12000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert(!result.stdout.includes(canary) && !result.stderr.includes(canary));
  const summary = JSON.parse(result.stderr);
  assert.equal(summary.error_type, "AggregateError");
  assert.deepEqual(
    summary.errors.map((item) => item.error_type),
    ["Error", "AssertionError"],
  );
});
