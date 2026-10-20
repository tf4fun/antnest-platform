import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildPermissionImages } from "./images.mjs";
import { requestPermissionRuntimeInspection } from "./runtime-inspection.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));

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

const started = "2026-10-17T04:10:00.123456789Z";
function networks(role) {
  return role === "model"
    ? ["acp-provider", "controller-provider"]
    : [
        "gateway-ingress",
        "observability",
        "acp-provider",
        "identity-clients",
        "edge",
      ];
}
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
    ...(role !== "model"
      ? [
          ...["traces", "deployment"].map((name) => ({
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
    Id: { model: "a", cleanup: "b", client: "c" }[role].repeat(64),
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
        "com.docker.compose.service": "permission-" + role,
        "io.antnest.e2e-run-id": runID,
      },
      Env:
        role !== "model"
          ? [
              `TEST_RUNTIME_IMAGE=${ref("antnest-runtime")}`,
              `COMPOSE_PROJECT_NAME=${project}`,
              `ANTNEST_E2E_RUN_ID=${runID}`,
              "ANTNEST_PERMISSION_EVIDENCE_DIR=/evidence/traces",
              `TEST_PERMISSION_RUN_ID=${runID}`,
              "TEST_BROWSER=false",
              "TEST_PERMISSION_CRASH=false",
              "ANTNEST_PERMISSION_RUNTIME_CHECKPOINT_DIR=/evidence/deployment",
            ]
          : [],
      Cmd: ["node", `/app/tests/e2e/acp-permissions/${role}.mjs`],
    },
    Mounts: mounts(role),
    HostConfig: {
      Privileged: false,
      PidMode: "",
      CapAdd: null,
      Devices: [],
      ExtraHosts:
        role === "model"
          ? []
          : [
              "identity-service:10.242.187.66",
              "agent-acp-service:10.242.187.5",
              "edge-gateway:10.242.187.130",
            ],
    },
    NetworkSettings: {
      Networks: Object.fromEntries(
        networks(role).map((name) => [
          project + "_" + name,
          { Aliases: role === "model" ? ["permission-model"] : null },
        ]),
      ),
    },
  };
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

async function setup(t, { env: selected = env, build = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "permission-deployment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture();
  const manifest = build
    ? await buildPermissionImages(f.docker, selected, () => {})
    : undefined;
  if (manifest)
    await writeFile(
      join(directory, "candidate-images.json"),
      JSON.stringify(manifest),
    );
  return { env: selected, directory, manifest, timeout: 3000 };
}
function runtime(agent, index) {
  return {
    Id: String(index).repeat(64),
    Image: id(13),
    State: { ...state(), StartedAt: started },
    Config: {
      Image: id(13),
      Labels: {
        "io.antnest.agent-id": agent,
        "io.antnest.managed": "runtime",
        "io.antnest.runtime-controller-scope": project,
        "io.antnest.runtime-generation": "2",
      },
      Env: [
        `ANTNEST_RUNTIME_IMAGE_REFERENCE=${ref("antnest-runtime")}`,
        `ANTNEST_RUNTIME_IMAGE_ID=${id(13)}`,
      ],
    },
  };
}
function harnessDocker(
  options,
  { fail, mutate, logs = "", cleanerExit = 0 } = {},
) {
  const calls = [],
    rows = new Map();
  const docker = async (args) => {
    calls.push([...args]);
    if (fail?.(args)) throw new Error("controlled Docker failure: " + args[0]);
    if (args[0] === "ps") {
      if (args.some((arg) => arg.startsWith("name="))) return "";
      const label = args.find((arg) =>
        arg.startsWith("label=com.docker.compose.service="),
      );
      if (label)
        return [...rows.values()]
          .filter(
            (row) =>
              "label=com.docker.compose.service=" +
                row.Config.Labels["com.docker.compose.service"] ===
              label,
          )
          .map((row) => row.Id)
          .join("\n");
      return [...rows.keys()].join("\n");
    }
    if (["run", "create"].includes(args[0])) {
      const role = args[args.indexOf("--name") + 1].split("-").at(-1);
      const row = harness(role);
      row.Mounts = mounts(role, options.directory);
      if (role === "model") row.State.StartedAt = started;
      row.Config.Env = row.Config.Env.map((value) =>
        value.startsWith("TEST_PERMISSION_CRASH=")
          ? `TEST_PERMISSION_CRASH=${options.env.ANTNEST_E2E_PERMISSION_CRASH ?? "false"}`
          : value.startsWith("TEST_BROWSER=")
            ? `TEST_BROWSER=${options.env.ANTNEST_E2E_BROWSER ?? "false"}`
            : value,
      );
      rows.set(row.Id, row);
      return row.Id;
    }
    if (args[0] === "inspect") {
      const attempts = JSON.parse(
        await readFile(
          join(options.directory, "harness-attempts.private.json"),
          "utf8",
        ),
      );
      for (const cid of args.slice(1))
        assert(
          attempts.some((row) => row.container_id === cid),
          "create identity recorded before inspect",
        );
      const actual = args.slice(1).map((cid) => rows.get(cid));
      mutate?.(actual, calls);
      return JSON.stringify(actual, null, 2);
    }
    if (args[0] === "logs") return logs;
    if (args[0] === "start") {
      const row = rows.get(args.at(-1));
      if (
        row.Config.Labels["com.docker.compose.service"] === "permission-cleanup"
      )
        assert(
          !rows.has("c".repeat(64)),
          "business client joined before independent cleanup",
        );
      row.State = { ...state(), StartedAt: started };
      return row.Id;
    }
    if (["kill", "stop"].includes(args[0])) {
      const row = rows.get(args.at(-1));
      row.State = {
        ...row.State,
        Running: false,
        Status: "exited",
        ExitCode: 137,
      };
      return row.Id;
    }
    if (args[0] === "wait") {
      const row = rows.get(args.at(-1));
      if (
        row.Config.Labels["com.docker.compose.service"] === "permission-cleanup"
      )
        row.State = {
          ...row.State,
          Running: false,
          Status: "exited",
          ExitCode: cleanerExit,
        };
      return String(row.State.ExitCode);
    }
    if (args[0] === "rm") {
      rows.delete(args.at(-1));
      return args.at(-1);
    }
    throw new Error("unexpected Docker operation: " + args[0]);
  };
  return { docker, calls, rows };
}

test("three Permission roles use the candidate image, exact private grants and isolated writable evidence", () => {
  const args = entry("permissionHarnessArguments")(env, {
    evidence: "/fixture/evidence",
  });
  assert.deepEqual(Object.keys(args).sort(), ["cleanup", "client", "model"]);
  for (const role of ["client", "cleanup", "model"]) {
    assert.equal(args[role][0], role === "model" ? "run" : "create");
    assert.deepEqual(values(args[role], "--user"), ["501:20"]);
    assert.deepEqual(
      values(args[role], "-v").sort(),
      mounts(role)
        .map((row) => `${row.Source}:${row.Destination}${row.RW ? "" : ":ro"}`)
        .sort(),
    );
    assert(args[role].includes(ref("agent-acp-service")));
    assert.equal(
      args[role].at(-1),
      `/app/tests/e2e/acp-permissions/${role}.mjs`,
    );
    assert.deepEqual(
      values(args[role], "--network").sort(),
      networks(role)
        .map((name) =>
          role === "model"
            ? `name=${project}_${name},alias=permission-model`
            : `${project}_${name}`,
        )
        .sort(),
    );
    if (role !== "model") {
      for (const value of [
        `TEST_PERMISSION_RUN_ID=${runID}`,
        "TEST_BROWSER=false",
        "TEST_PERMISSION_CRASH=false",
        "ANTNEST_PERMISSION_RUNTIME_CHECKPOINT_DIR=/evidence/deployment",
      ])
        assert(values(args[role], "-e").includes(value));
      for (const pin of [
        "identity-service:10.242.187.66",
        "agent-acp-service:10.242.187.5",
        "edge-gateway:10.242.187.130",
      ])
        assert(args[role].includes("--add-host=" + pin));
    }
  }
  const selected = entry("permissionHarnessArguments")(
    {
      ...env,
      ANTNEST_E2E_BROWSER: "true",
      ANTNEST_E2E_PERMISSION_CRASH: "true",
    },
    { evidence: "/fixture/evidence" },
  );
  assert(values(selected.client, "-e").includes("TEST_BROWSER=true"));
  assert(values(selected.client, "-e").includes("TEST_PERMISSION_CRASH=true"));
});
test("actual three-role inspection accepts only the exact image, mounts, networks, pins and ownership", () => {
  for (const role of ["client", "cleanup", "model"]) {
    const row = harness(role);
    const result = entry("inspectPermissionHarness")([row], env, role, id(2), {
      evidence: "/fixture/evidence",
    });
    assert.equal(result.container_id, row.Id);
    assert.equal(result.role, role);
  }
});
for (const [label, mutate] of [
  [
    "root",
    (row) => {
      row.Config.User = "0:0";
    },
  ],
  [
    "image substitution",
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
    "writable grant",
    (row) => {
      row.Mounts.find((m) => m.Destination === "/run/auth/agent-ui-acp").RW =
        true;
    },
  ],
  [
    "Docker socket",
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
    "extra network",
    (row) => {
      row.NetworkSettings.Networks.production = {};
    },
  ],
  [
    "missing listener pin",
    (row) => {
      row.HostConfig.ExtraHosts.pop();
    },
  ],
  [
    "foreign business run",
    (row) => {
      row.Config.Env = row.Config.Env.map((v) =>
        v.startsWith("TEST_PERMISSION_RUN_ID=")
          ? "TEST_PERMISSION_RUN_ID=foreign"
          : v,
      );
    },
  ],
])
  test("Permission client and cleanup reject " + label, () => {
    const inspect = entry("inspectPermissionHarness");
    for (const role of ["client", "cleanup"]) {
      const row = harness(role);
      mutate(row);
      assert.throws(() =>
        inspect([row], env, role, id(2), { evidence: "/fixture/evidence" }),
      );
    }
  });
test("model cannot acquire credentials or lose its provider alias", () => {
  const inspect = entry("inspectPermissionHarness");
  for (const mutate of [
    (row) => {
      row.Mounts.push(mounts("client").at(-1));
    },
    (row) => {
      row.NetworkSettings.Networks[project + "_acp-provider"].Aliases = [];
    },
  ]) {
    const row = harness("model");
    mutate(row);
    assert.throws(() =>
      inspect([row], env, "model", id(2), { evidence: "/fixture/evidence" }),
    );
  }
});
test("actual Runtime proof binds two agents, candidate identity and original StartedAt", async (t) => {
  const inspect = entry("inspectPermissionRuntimes"),
    options = await setup(t);
  const rows = [runtime("agent-a", 1), runtime("agent-b", 2)];
  const proof = inspect(rows, env, options.manifest, ["agent-a", "agent-b"]);
  assert.deepEqual(
    proof.map((row) => row.started_at),
    [started, started],
  );
  assert.deepEqual(
    proof.map((row) => row.container_id),
    rows.map((row) => row.Id),
  );
  assert(proof.every((row) => row.image_id === id(13) && row.generation === 2));
});
for (const [label, mutate] of [
  ["missing", (rows) => rows.pop()],
  [
    "duplicate container",
    (rows) => {
      rows[1].Id = rows[0].Id;
    },
  ],
  [
    "foreign Agent",
    (rows) => {
      rows[1].Config.Labels["io.antnest.agent-id"] = "foreign";
    },
  ],
  [
    "foreign scope",
    (rows) => {
      rows[1].Config.Labels["io.antnest.runtime-controller-scope"] = "foreign";
    },
  ],
  [
    "substituted image",
    (rows) => {
      rows[1].Image = id(99);
    },
  ],
  [
    "unhealthy",
    (rows) => {
      rows[1].State.Health.Status = "unhealthy";
    },
  ],
  [
    "missing StartedAt",
    (rows) => {
      delete rows[1].State.StartedAt;
    },
  ],
  [
    "unstarted",
    (rows) => {
      rows[1].State.StartedAt = "0001-01-01T00:00:00.000000000Z";
    },
  ],
  [
    "zero generation",
    (rows) => {
      rows[1].Config.Labels["io.antnest.runtime-generation"] = "0";
    },
  ],
])
  test("Runtime inspection rejects " + label, async (t) => {
    const inspect = entry("inspectPermissionRuntimes"),
      options = await setup(t);
    const rows = [runtime("agent-a", 1), runtime("agent-b", 2)];
    mutate(rows);
    assert.throws(() =>
      inspect(rows, env, options.manifest, ["agent-a", "agent-b"]),
    );
  });
test("host delegates partial image build and recorded cleanup to the owning image module", async (t) => {
  const run = entry("runPermissionDeployment"),
    options = await setup(t, { build: false }),
    f = fixture({ failBuild: 12 });
  await assert.rejects(
    run("build", { ...options, docker: f.docker }),
    /interrupted build/u,
  );
  const manifest = JSON.parse(
    await readFile(join(options.directory, "candidate-images.json"), "utf8"),
  );
  assert.equal(manifest.attempted.length, 12);
  await run("cleanup", { ...options, docker: f.docker });
  assert.equal(f.images.size, 0);
});
for (const valid of [true, false])
  test("host preserves actual stack before admission: " + valid, async (t) => {
    const run = entry("runPermissionDeployment"),
      options = await setup(t),
      rows = stack();
    if (!valid) rows[0].Image = id(99);
    const raw = JSON.stringify(rows, null, 2);
    const result = run("inspect-stack", {
      ...options,
      docker: async (args) =>
        args[0] === "ps" ? rows.map((row) => row.Id).join("\n") : raw,
    });
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
  });
test("host precreates model, independent cleanup and then client with durable original identities", async (t) => {
  const run = entry("runPermissionDeployment"),
    options = await setup(t),
    f = harnessDocker(options);
  const receipts = await run("create-harness", {
    ...options,
    docker: f.docker,
  });
  assert.deepEqual(
    receipts.map((row) => row.role),
    ["model", "cleanup", "client"],
  );
  assert.equal(f.rows.size, 3);
  for (const name of ["traces", "deployment"]) {
    assert.equal(
      (await stat(join(options.directory, name))).mode & 0o777,
      0o700,
    );
    assert.deepEqual(await readdir(join(options.directory, name)), []);
  }
});
test("any name collision prevents every create and ownership adoption", async (t) => {
  const run = entry("runPermissionDeployment"),
    options = await setup(t),
    calls = [];
  await assert.rejects(
    run("create-harness", {
      ...options,
      docker: async (args) => {
        calls.push(args);
        return args.at(-1).endsWith("cleanup$") ? "f".repeat(64) : "";
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
test("normal cleanup joins client before independent cleanup and retains model until all diagnostics finish", async (t) => {
  const run = entry("runPermissionDeployment"),
    options = await setup(t),
    f = harnessDocker(options, { logs: '{"status":"cleanup_passed"}\n' });
  await run("create-harness", { ...options, docker: f.docker });
  await f.docker(["start", "c".repeat(64)]);
  await run("cleanup-harness", { ...options, docker: f.docker });
  assert.equal(f.rows.size, 0);
  const removed = f.calls
    .filter((args) => args[0] === "rm")
    .map((args) => args.at(-1));
  assert.deepEqual(
    removed,
    ["c", "b", "a"].map((c) => c.repeat(64)),
  );
  assert(
    f.calls.some((args) => args[0] === "wait" && args[1] === "b".repeat(64)),
  );
  assert.match(
    await readFile(
      join(options.directory, "cleanup-cleanup.private.log"),
      "utf8",
    ),
    /cleanup_passed/u,
  );
});
for (const failed of ["inspect", "logs"])
  test(
    "known original client is removed and cleaner still runs after " +
      failed +
      " failure",
    async (t) => {
      const run = entry("runPermissionDeployment"),
        options = await setup(t);
      let active = false;
      const f = harnessDocker(options, {
        fail: (args) =>
          active && args[0] === failed && args[1] === "c".repeat(64),
      });
      await run("create-harness", { ...options, docker: f.docker });
      active = true;
      await assert.rejects(
        run("cleanup-harness", { ...options, docker: f.docker }),
      );
      assert.equal(f.rows.size, 0);
      assert(
        f.calls.some(
          (args) => args[0] === "start" && args[1] === "b".repeat(64),
        ),
      );
    },
  );
test("cleaner nonzero exit remains failure while all owned containers are removed", async (t) => {
  const run = entry("runPermissionDeployment"),
    options = await setup(t),
    f = harnessDocker(options, { cleanerExit: 1 });
  await run("create-harness", { ...options, docker: f.docker });
  await assert.rejects(
    run("cleanup-harness", { ...options, docker: f.docker }),
  );
  assert.equal(f.rows.size, 0);
  assert.equal(
    JSON.parse(
      await readFile(join(options.directory, "cleanup-result.json"), "utf8"),
    ).exit_code,
    1,
  );
});
test("changed cleaner ownership cannot authorize start or removal and other owned roles are still removed", async (t) => {
  const run = entry("runPermissionDeployment"),
    options = await setup(t),
    f = harnessDocker(options);
  await run("create-harness", { ...options, docker: f.docker });
  f.rows.get("b".repeat(64)).Config.Labels["io.antnest.e2e-run-id"] = "foreign";
  await assert.rejects(
    run("cleanup-harness", { ...options, docker: f.docker }),
  );
  assert.deepEqual([...f.rows.keys()], ["b".repeat(64)]);
  assert(
    !f.calls.some((args) => args[0] === "start" && args[1] === "b".repeat(64)),
  );
});

test("host publishes exact raw two-Runtime SHA only while original harness is running", async (t) => {
  const run = entry("runPermissionDeployment"),
    options = await setup(t),
    f = harnessDocker(options);
  await run("create-harness", { ...options, docker: f.docker });
  await f.docker(["start", "c".repeat(64)]);
  const rows = [runtime("agent-a", 1), runtime("agent-b", 2)],
    raw = JSON.stringify(rows, null, 2);
  const client = requestPermissionRuntimeInspection(["agent-a", "agent-b"], {
    env,
    directory: join(options.directory, "deployment"),
    timeout: 3000,
  });
  const docker = async (args) =>
    args[0] === "ps"
      ? rows.map((row) => row.Id).join("\n")
      : args[0] === "inspect" && args[1] === rows[0].Id
        ? raw
        : f.docker(args);
  const results = await Promise.allSettled([
    client,
    run("inspect-runtimes", { ...options, docker }),
  ]);
  for (const result of results)
    assert.equal(result.status, "fulfilled", result.reason?.stack);
  const receipt = results[0].value;
  assert.equal(
    receipt.raw_sha256,
    createHash("sha256")
      .update(raw + "\n")
      .digest("hex"),
  );
  assert.equal(
    await readFile(
      join(options.directory, "runtime-containers.private.json"),
      "utf8",
    ),
    raw + "\n",
  );
});
test("crash host recognizes an exact ready record, kills and joins original client with 137 and never emits ACK", async (t) => {
  const run = entry("runPermissionDeployment"),
    options = await setup(t, {
      env: { ...env, ANTNEST_E2E_PERMISSION_CRASH: "true" },
    }),
    f = harnessDocker(options, {
      logs: 'ordinary log\n{"status":"crash_ready"}\n',
    });
  await run("create-harness", { ...options, docker: f.docker });
  await f.docker(["start", "c".repeat(64)]);
  const result = await run("inspect-runtimes", {
    ...options,
    docker: f.docker,
  });
  assert.equal(result.status, "crash_control");
  assert.equal(result.exit_code, 137);
  assert.equal(f.calls.filter((args) => args[0] === "kill").length, 1);
  assert(
    f.calls.some((args) => args[0] === "wait" && args[1] === "c".repeat(64)),
  );
  assert.deepEqual(await readdir(join(options.directory, "deployment")), []);
  assert.equal(
    JSON.parse(
      await readFile(join(options.directory, "crash-result.json"), "utf8"),
    ).exit_code,
    137,
  );
  await run("cleanup-harness", { ...options, docker: f.docker });
  assert.equal(f.rows.size, 0);
});
for (const scenario of [
  "substring only",
  "model restart",
  "unexpected client exit",
])
  test("waiting rejects " + scenario + " without an ACK", async (t) => {
    const run = entry("runPermissionDeployment"),
      options = await setup(t, {
        env: { ...env, ANTNEST_E2E_PERMISSION_CRASH: "true" },
      });
    let checks = 0;
    const f = harnessDocker(options, {
      logs: 'prefix {"status":"crash_ready"} suffix\n',
      mutate: (rows) => {
        if (rows.length !== 3) return;
        if (scenario === "model restart")
          rows.find((row) => row.Id === "a".repeat(64)).State.StartedAt =
            "2026-10-17T04:11:00.123456789Z";
        if (scenario === "unexpected client exit" || ++checks === 2) {
          const row = rows.find((row) => row.Id === "c".repeat(64));
          row.State.Running = false;
          row.State.Status = "exited";
        }
      },
    });
    await run("create-harness", { ...options, docker: f.docker });
    await f.docker(["start", "c".repeat(64)]);
    await assert.rejects(
      run("inspect-runtimes", { ...options, docker: f.docker }),
    );
    assert(!f.calls.some((args) => args[0] === "kill"));
    assert.deepEqual(await readdir(join(options.directory, "deployment")), []);
  });

for (const changed of ["model restart", "model exit", "cleanup started"])
  test(
    "crash join rejects changed surviving harness: " + changed,
    async (t) => {
      const run = entry("runPermissionDeployment");
      const options = await setup(t, {
        env: { ...env, ANTNEST_E2E_PERMISSION_CRASH: "true" },
      });
      const f = harnessDocker(options, { logs: '{"status":"crash_ready"}\n' });
      await run("create-harness", { ...options, docker: f.docker });
      await f.docker(["start", "c".repeat(64)]);
      const docker = async (args) => {
        const result = await f.docker(args);
        if (args[0] === "wait" && args[1] === "c".repeat(64)) {
          const model = f.rows.get("a".repeat(64));
          if (changed === "model restart")
            model.State.StartedAt = "2026-10-17T04:11:00.123456789Z";
          if (changed === "model exit") {
            model.State.Running = false;
            model.State.Status = "exited";
          }
          if (changed === "cleanup started")
            f.rows.get("b".repeat(64)).State = {
              ...state(),
              StartedAt: started,
            };
        }
        return result;
      };
      await assert.rejects(run("inspect-runtimes", { ...options, docker }));
      assert.deepEqual(
        await readdir(join(options.directory, "deployment")),
        [],
      );
      assert(!(await readdir(options.directory)).includes("crash-result.json"));
    },
  );

test("actual CLI failure summary never prints private configuration", () => {
  const canary = "PRIVATE_PERMISSION_DEPLOYMENT_CANARY";
  const result = spawnSync(
    process.execPath,
    [url.pathname, "inspect-runtimes"],
    {
      env: { ...process.env, COMPOSE_PROJECT_NAME: canary },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert(!result.stderr.includes(canary));
  assert.deepEqual(JSON.parse(result.stderr), {
    stage: "permission-deployment",
    status: "failed",
    error_type: "AssertionError",
    code: "ERR_ASSERTION",
  });
});

test("a missing create ID recovered by unique run labels still gets logs and removal after inspect failure", async (t) => {
  const run = entry("runPermissionDeployment"),
    options = await setup(t),
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
            "label=com.docker.compose.service=permission-client",
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
  const run = entry("runPermissionDeployment"),
    options = await setup(t),
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
    "artifacts/verification/acp-permissions",
    currentProject,
  );
  await mkdir(join(root, "artifacts/verification/acp-permissions"), {
    recursive: true,
  });
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "deployment-build-failure.private.txt"));
  const binary = await mkdtemp(join(tmpdir(), "antnest-permission-cli-"));
  t.after(() => rm(binary, { recursive: true, force: true }));
  const canary = "PRIVATE_PERMISSION_COMMAND_CANARY";
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
