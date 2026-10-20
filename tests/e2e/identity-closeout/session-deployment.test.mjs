import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as deployment from "./session-deployment.mjs";

const runID = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855";
const project = "antnest-stage3-e2e-1234";
const tag = "session-" + runID;
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
  ANTNEST_AGENT_ACP_POSTGRES_PASSWORD: "fixture-only-password",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318",
};
const location = {
  evidence: "/fixture/evidence",
  checkpoints: "/fixture/checkpoints",
};
const imageID = "sha256:" + "1".repeat(64);
const image = (ref, id = imageID) => ({
  Id: id,
  RepoTags: [ref],
  Config: { Labels: { "io.antnest.deployment-admission": project } },
});

test("Session candidates use all current service images and the release Runtime repository", () => {
  assert.equal(typeof deployment.sessionImagePlan, "function");
  const plan = deployment.sessionImagePlan(env);
  assert.deepEqual(
    plan.map((entry) => entry.name),
    names,
  );
  for (const entry of plan) {
    assert.equal(entry.ref, `antnest/${entry.name}:${tag}`);
    assert(
      entry.command.includes(`io.antnest.deployment-admission=${project}`),
    );
    assert(entry.command.includes(entry.ref));
    assert(!entry.command.includes("--target"));
  }
  assert(
    plan
      .find((p) => p.name === "temporal")
      .command.includes("scripts/temporal/Dockerfile"),
  );
  assert(
    plan
      .find((p) => p.name === "antnest-runtime")
      .command.includes("runtimes/antnest-runtime/Dockerfile"),
  );
});

test("only explicitly provided CI images bypass the current source build", () => {
  assert.equal(typeof deployment.sessionImagePlan, "function");
  const plan = deployment.sessionImagePlan({
    ...env,
    ANTNEST_CI_PROVIDED_IMAGES: "identity-service,antnest-runtime",
  });
  for (const entry of plan) {
    const provided = ["identity-service", "antnest-runtime"].includes(
      entry.name,
    );
    assert.equal(
      entry.command.includes(`IMAGE=antnest/${entry.name}:local`),
      provided,
    );
  }
});

for (const [name, change] of [
  ["foreign project", { COMPOSE_PROJECT_NAME: "production" }],
  ["foreign tag", { ANTNEST_ADMISSION_TAG: "local" }],
  ["missing run", { ANTNEST_E2E_RUN_ID: "" }],
  [
    "different Runtime",
    {
      ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF: "antnest/antnest-runtime:local",
    },
  ],
])
  test("Session candidate selection rejects " + name, () => {
    assert.equal(typeof deployment.sessionImagePlan, "function");
    assert.throws(() => deployment.sessionImagePlan({ ...env, ...change }));
  });

function dockerFixture({ existing, failBuild } = {}) {
  const calls = [],
    images = new Map(existing ? [[existing, image(existing)]] : []);
  let builds = 0;
  return {
    calls,
    images,
    async docker(args, long, options) {
      calls.push({ args, long, options });
      if (args[0] === "image" && args[1] === "ls")
        return images.get(args.at(-1))?.Id ?? "";
      if (args[0] === "build") {
        const ref = args[args.indexOf("-t") + 1];
        images.set(
          ref,
          image(ref, "sha256:" + String(++builds).padStart(64, "0")),
        );
        if (builds === failBuild) throw new Error("fixture build failed");
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

test("Session builds record independent image identities and omit build-time OTLP export", async () => {
  assert.equal(typeof deployment.buildSessionImages, "function");
  const f = dockerFixture(),
    saved = [];
  const result = await deployment.buildSessionImages(f.docker, env, (value) =>
    saved.push(structuredClone(value)),
  );
  assert.equal(result.images.length, 11);
  assert.equal(saved.at(-1).images.length, 11);
  for (const { args, options } of f.calls.filter(
    (c) => c.args[0] === "build",
  )) {
    assert(!Object.keys(options.env).some((name) => name.startsWith("OTEL_")));
    assert(args.includes(`io.antnest.deployment-admission=${project}`));
  }
});

test("a pre-existing candidate tag prevents every build and is never adopted for cleanup", async () => {
  assert.equal(typeof deployment.buildSessionImages, "function");
  const f = dockerFixture({ existing: `antnest/identity-service:${tag}` }),
    saved = [];
  await assert.rejects(
    deployment.buildSessionImages(f.docker, env, (value) => saved.push(value)),
  );
  assert.equal(saved.length, 0);
  assert(!f.calls.some((c) => c.args[0] === "build" || c.args[1] === "rm"));
});

test("interrupted builds retain attempted ownership so cleanup removes only their candidate tags", async () => {
  assert.equal(typeof deployment.buildSessionImages, "function");
  assert.equal(typeof deployment.cleanupSessionImages, "function");
  const f = dockerFixture({ failBuild: 3 });
  let record;
  await assert.rejects(
    deployment.buildSessionImages(
      f.docker,
      env,
      (value) => (record = structuredClone(value)),
    ),
  );
  assert.equal(record.attempted.length, 3);
  await deployment.cleanupSessionImages(f.docker, env, record);
  assert.equal(f.images.size, 0);
  assert.equal(f.calls.filter((c) => c.args[1] === "rm").length, 3);
  assert(
    !f.calls.some(
      (c) =>
        c.args.includes("--force") || c.args.some((a) => a.endsWith(":local")),
    ),
  );
});

test("cleanup refuses a tag whose actual ownership changed", async () => {
  assert.equal(typeof deployment.buildSessionImages, "function");
  const f = dockerFixture();
  const record = await deployment.buildSessionImages(f.docker, env, () => {});
  const ref = record.images[0].ref;
  f.images.get(ref).Config.Labels["io.antnest.deployment-admission"] =
    "foreign";
  await assert.rejects(deployment.cleanupSessionImages(f.docker, env, record));
  assert(f.images.has(ref));
  assert(!f.calls.some((c) => c.args[1] === "rm" && c.args.at(-1) === ref));
});

test("the Session client receives exactly two read-only workload grants and its real private networks", () => {
  assert.equal(typeof deployment.sessionHarnessArguments, "function");
  const { client, model } = deployment.sessionHarnessArguments(env, location);
  assert.equal(client[client.indexOf("--user") + 1], "501:20");
  const grants = client.filter((arg) => arg.includes(":/run/auth/"));
  assert.deepEqual(grants.sort(), [
    "/fixture/credentials/agent-ui/tokens/agent-acp-service:/run/auth/agent-ui-acp:ro",
    "/fixture/credentials/edge-gateway/tokens/identity-service:/run/auth/gateway-identity:ro",
  ]);
  for (const network of [
    "edge",
    "identity-clients",
    "gateway-ingress",
    "observability",
    "acp-provider",
    "agent-acp-database",
  ])
    assert(client.includes(`${project}_${network}`));
  assert(client.includes("--add-host=agent-acp-service:10.242.187.5"));
  assert(client.includes("--add-host=identity-service:10.242.187.66"));
  assert(client.includes("--add-host=edge-gateway:10.242.187.130"));
  assert(
    client.includes(
      `ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=antnest/antnest-runtime:${tag}`,
    ),
  );
  assert(client.includes(`antnest/agent-acp-service:${tag}`));
  assert(model.includes(`antnest/agent-acp-service:${tag}`));
  assert(
    !model.some(
      (arg) => arg.includes("/run/auth/") || arg.includes("/credentials"),
    ),
  );
  assert(
    !client.some((arg) => arg.includes("issuer") || arg.includes("/keys/")),
  );
});

test("the Session client mounts the real Bridge observer import tree read-only", async (t) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const temporary = await mkdtemp(
    join(tmpdir(), "antnest-session-source-mount-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const app = join(temporary, "app");
  await mkdir(app);
  const { client } = deployment.sessionHarnessArguments(env, location);
  for (let index = 0; index < client.length; index++) {
    if (client[index] !== "-v") continue;
    const [source, target, mode] = client[++index].split(":");
    if (!target.startsWith("/app/")) continue;
    assert.equal(mode, "ro", `${target} must remain read-only`);
    await cp(source, join(app, target.slice("/app/".length)), {
      recursive: true,
    });
  }
  // Reproduce the image's /app/node_modules, without letting source symlinks
  // resolve imports against the original checkout and hide a missing mount.
  await symlink(
    join(root, "services/agent-acp-service/node_modules"),
    join(app, "node_modules"),
    "dir",
  );
  const locks = await Promise.all(
    ["agent-acp-service", "agent-ui/web"].map(
      async (service) =>
        JSON.parse(
          await readFile(
            join(root, "services", service, "package-lock.json"),
            "utf8",
          ),
        ).packages["node_modules/zod"],
    ),
  );
  assert.equal(locks[0].version, locks[1].version);
  assert.equal(locks[0].integrity, locks[1].integrity);
  const imports = [
    "bridge-session-observer.mjs",
    "bridge-session-cause.mjs",
  ].map(
    (name) =>
      pathToFileURL(join(app, "tests/e2e/identity-closeout", name)).href,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await Promise.all(${JSON.stringify(imports)}.map(url => import(url)));`,
    ],
    { cwd: app, encoding: "utf8", timeout: 10000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});

function harnessRow(role) {
  return {
    Id: "a".repeat(64),
    Image: imageID,
    Config: {
      Image: `antnest/agent-acp-service:${tag}`,
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": `session-${role}`,
        "io.antnest.e2e-run-id": runID,
      },
    },
    State: {
      Status: role === "client" ? "created" : "running",
      Running: role !== "client",
      OOMKilled: false,
      Dead: false,
      Restarting: false,
      Paused: false,
      ExitCode: 0,
      Error: "",
    },
  };
}

function candidateInventory() {
  const images = names.map((name) => ({
    name,
    ref: `antnest/${name}:${tag}`,
    id: imageID,
  }));
  const record = {
    version: 1,
    project,
    run_id: runID,
    tag,
    attempted: images.map((r) => r.ref),
    images,
  };
  const rows = images
    .filter((r) => r.name !== "antnest-runtime")
    .map((entry) => ({
      ...harnessRow("model"),
      Config: {
        Image: entry.ref,
        Env:
          entry.name === "edge-gateway"
            ? ["ANTNEST_EDGE_RESOLVE_CACHE_TTL=10s"]
            : [],
        Labels: {
          "com.docker.compose.project": project,
          "com.docker.compose.service": entry.name,
          "io.antnest.deployment-admission": project,
        },
      },
      State: { ...harnessRow("model").State, Health: { Status: "healthy" } },
    }));
  const runtime = {
    ...harnessRow("model"),
    Config: {
      Image: imageID,
      Env: [
        `ANTNEST_RUNTIME_IMAGE_REFERENCE=antnest/antnest-runtime:${tag}`,
        `ANTNEST_RUNTIME_IMAGE_ID=${imageID}`,
      ],
      Labels: {
        "io.antnest.managed": "runtime",
        "io.antnest.runtime-controller-scope": project,
        "io.antnest.agent-id": "agent-1",
        "io.antnest.runtime-generation": "1",
      },
    },
    State: { ...harnessRow("model").State, Health: { Status: "healthy" } },
  };
  return { rows, record, runtime };
}

function ownerInventory() {
  const f = candidateInventory();
  const start = "2026-10-15T10:00:00.000000001Z";
  const jaeger = {
    ...harnessRow("model"),
    Config: {
      Image: "jaeger:fixture",
      Labels: {
        "com.docker.compose.service": "jaeger",
        "com.docker.compose.project": project,
      },
    },
  };
  f.rows.push(jaeger);
  for (const [index, row] of f.rows.entries()) {
    row.Id = (index + 1).toString(16).repeat(64);
    row.State.StartedAt = start;
  }
  f.baseline = Object.fromEntries(
    f.rows.map((row) => [
      row.Config.Labels["com.docker.compose.service"],
      {
        id: row.Id,
        started_at: row.State.StartedAt,
        at: 50,
      },
    ]),
  );
  f.baseline["identity-service"].id = "e".repeat(64);
  f.baseline["identity-service"].started_at = "2026-10-15T10:00:00.100000001Z";
  f.identity = {
    project,
    run_id: runID,
    step: 3,
    image_id: imageID,
    image_ref: `antnest/identity-service:${tag}`,
    after: {
      container_id: "e".repeat(64),
      started_at: "2026-10-15T10:00:00.100000001Z",
      running: true,
      token_ttl: "12h",
    },
  };
  f.request = {
    project,
    run_id: runID,
    agent_id: "agent-1",
    identity_container_id: "e".repeat(64),
  };
  f.time = 300;
  f.sample = {
    container_id: f.baseline["agent-acp-service"].id,
    listener: "control",
    method: "GET",
    path: "/status",
    started_at: 100,
    received_at: 200,
    status: 200,
    ready: true,
    body_complete: true,
    body_bytes: 18,
    body_sha256: "a".repeat(64),
    server_date: "Thu, 15 Oct 2026 10:00:00 GMT",
  };
  f.writes = [];
  f.options = {
    env,
    manifest: f.record,
    initial: f.rows,
    identity: f.identity,
    request: f.request,
    output: "/fixture/evidence",
    now: () => f.time,
    async clockProbe(options) {
      f.probe = options;
      return f.sample;
    },
    writeClock(...args) {
      f.writes.push(args);
    },
    async createLifecycle(options) {
      f.actual = options;
      return {
        baseline: f.baseline,
        async collect(collect, preparation = {}) {
          preparation.beforeDrain?.();
          f.drained = true;
          const evidence = {
            ...preparation.evidence,
            baseline: f.baseline,
            before: structuredClone(f.baseline),
            requested_at: 400,
            stopped_at: 500,
          };
          evidence.before["agent-acp-service"].at = 350;
          preparation.inspectDrain?.(evidence);
          return collect(evidence);
        },
      };
    },
  };
  return f;
}

test("Session owner drain binds independent candidates and original peers after the allowed Identity replacement", async () => {
  assert.equal(typeof deployment.createSessionOwnerLifecycle, "function");
  const f = ownerInventory();
  const owner = await deployment.createSessionOwnerLifecycle(f.options);
  assert.equal(owner.baseline, f.baseline);
  assert.equal(f.actual.artifactPrefix, "session");
  assert.equal(f.actual.agentID, "agent-1");
  assert.equal(f.actual.images.runtime, imageID);
  assert.equal(f.actual.images["agent-ui"], imageID);
  assert.equal(f.actual.images.jaeger, imageID);
  const args = f.actual.compose(["ps", "-q", "agent-ui"]);
  assert(args.includes(`label=com.docker.compose.project=${project}`));
  assert(args.includes("label=com.docker.compose.service=agent-ui"));
});

test("Session owner drain archives its ACP clock before stopping and carries the same receipt into collection", async () => {
  const f = ownerInventory();
  const owner = await deployment.createSessionOwnerLifecycle(f.options);
  assert.equal(f.probe?.container, f.baseline["agent-acp-service"].id);
  assert.equal(f.probe?.environment, env);
  assert.equal(f.probe?.now, f.options.now);
  assert.equal(f.actual.now, f.options.now);
  assert.equal(f.drained, undefined);
  assert.equal(f.writes.length, 1);
  const [directory, name, raw] = f.writes[0];
  assert.equal(directory, f.options.output);
  assert.equal(name, "session-acp-clock.private.json");
  assert.deepEqual(JSON.parse(raw), f.sample);
  const saved = structuredClone(f.sample);
  f.sample.received_at = -1;
  const collected = await owner.collect(async (receipt) => {
    assert.equal(f.drained, true);
    assert.deepEqual(receipt.acp_clock, saved);
    assert(
      receipt.acp_clock.received_at <= receipt.before["agent-acp-service"].at,
    );
    return "original-collection";
  });
  assert.equal(collected, "original-collection");
});

for (const [name, change] of [
  ["another ACP container", (f) => (f.sample.container_id = "f".repeat(64))],
  ["probe predates baseline", (f) => (f.sample.started_at = 49)],
  ["missing baseline clock", (f) => delete f.baseline["agent-acp-service"].at],
  ["future probe", (f) => (f.sample.received_at = 301)],
  ["incomplete body", (f) => (f.sample.body_complete = false)],
  ["failed probe", (f) => (f.sample.status = 503)],
  ["not ready", (f) => (f.sample.ready = false)],
  ["workspace listener", (f) => (f.sample.listener = "workspace")],
  ["missing Date", (f) => delete f.sample.server_date],
  ["response before request", (f) => (f.sample.received_at = 99)],
  [
    "private diagnostic",
    (f) => (f.sample.error = env.ANTNEST_AGENT_ACP_POSTGRES_PASSWORD),
  ],
])
  test(`Session refuses ${name} before any owner stop`, async () => {
    const f = ownerInventory();
    change(f);
    await assert.rejects(() =>
      deployment.createSessionOwnerLifecycle(f.options),
    );
    assert.equal(f.drained, undefined);
    assert.equal(f.writes.length, 0);
  });

test("Session cannot stop after its clock receipt fails to archive", async () => {
  const f = ownerInventory();
  const failure = new Error("clock archive unavailable");
  f.options.writeClock = () => {
    throw failure;
  };
  await assert.rejects(
    () => deployment.createSessionOwnerLifecycle(f.options),
    (error) => error === failure,
  );
  assert.equal(f.drained, undefined);
});

test("Session clock failure propagates before any owner stop", async () => {
  const f = ownerInventory();
  const failure = new Error("clock probe unavailable");
  f.options.clockProbe = async () => {
    throw failure;
  };
  await assert.rejects(
    () => deployment.createSessionOwnerLifecycle(f.options),
    (error) => error === failure,
  );
  assert.equal(f.drained, undefined);
  assert.equal(f.writes.length, 0);
});

test("Session cancellation prevents calibration and later owner stop", async () => {
  const f = ownerInventory();
  const abort = new AbortController();
  f.options.signal = abort.signal;
  const owner = await deployment.createSessionOwnerLifecycle(f.options);
  assert.equal(f.probe?.signal, abort.signal);
  abort.abort(new Error("cancelled before owner drain"));
  await assert.rejects(
    () => owner.collect(() => assert.fail("cancelled collection")),
    /cancelled before owner drain/u,
  );
  assert.equal(f.drained, undefined);
});

test("Session rejects a regressed host clock before owner stop", async () => {
  const f = ownerInventory();
  const owner = await deployment.createSessionOwnerLifecycle(f.options);
  f.time = 150;
  await assert.rejects(
    () => owner.collect(() => assert.fail("regressed host clock admitted")),
    /clock/u,
  );
  assert.equal(f.drained, undefined);
});

for (const [name, change] of [
  [
    "replaced UI",
    (f) => {
      f.baseline["agent-ui"].id = "f".repeat(64);
    },
  ],
  [
    "restarted UI",
    (f) => {
      f.baseline["agent-ui"].started_at = "2026-10-15T10:00:01Z";
    },
  ],
  [
    "restarted ACP",
    (f) => {
      f.baseline["agent-acp-service"].started_at = "2026-10-15T10:00:01Z";
    },
  ],
  [
    "wrong Identity generation",
    (f) => {
      f.baseline["identity-service"].id = "f".repeat(64);
    },
  ],
  [
    "unrestored Identity",
    (f) => {
      f.identity.step = 2;
    },
  ],
  [
    "same Identity container restarted after the restoration ACK",
    (f) => {
      f.baseline["identity-service"].started_at =
        "2026-10-15T10:00:01.100000001Z";
    },
  ],
  [
    "foreign request",
    (f) => {
      f.request.run_id = "00000000-0000-4000-8000-000000000000";
    },
  ],
])
  test(`Session owner drain rejects ${name} before stopping UI`, async () => {
    assert.equal(typeof deployment.createSessionOwnerLifecycle, "function");
    const f = ownerInventory();
    change(f);
    await assert.rejects(() =>
      deployment.createSessionOwnerLifecycle(f.options),
    );
  });

test("all ten actually deployed services must match independent candidate image IDs", () => {
  assert.equal(typeof deployment.inspectSessionImages, "function");
  const f = candidateInventory();
  const result = deployment.inspectSessionImages(f.rows, env, f.record);
  assert.equal(result.services.length, 10);
  assert(result.services.every((r) => r.image_id === imageID));
});

for (const settings of [
  [],
  ["ANTNEST_EDGE_RESOLVE_CACHE_TTL=30s"],
  ["ANTNEST_EDGE_RESOLVE_CACHE_TTL=0s"],
  ["ANTNEST_EDGE_RESOLVE_CACHE_TTL=10s", "ANTNEST_EDGE_RESOLVE_CACHE_TTL=30s"],
])
  test(`Session deployment rejects an unproved original cache budget: ${settings.join(",")}`, () => {
    const f = candidateInventory();
    f.rows.find(
      (row) =>
        row.Config.Labels["com.docker.compose.service"] === "edge-gateway",
    ).Config.Env = settings;
    assert.throws(
      () => deployment.inspectSessionImages(f.rows, env, f.record),
      /cache/u,
    );
  });

for (const [name, mutate] of [
  ["missing service", (f) => f.rows.pop()],
  ["duplicate service", (f) => f.rows.push(structuredClone(f.rows[0]))],
  [
    "stale deployed image",
    (f) => (f.rows[0].Image = "sha256:" + "f".repeat(64)),
  ],
  [
    "wrong deployed reference",
    (f) => (f.rows[0].Config.Image = "antnest/admin-console:local"),
  ],
  [
    "foreign deployment",
    (f) => (f.rows[0].Config.Labels["com.docker.compose.project"] = "foreign"),
  ],
  [
    "unhealthy deployment",
    (f) => (f.rows[0].State.Health.Status = "unhealthy"),
  ],
])
  test("Session actual image admission rejects " + name, () => {
    assert.equal(typeof deployment.inspectSessionImages, "function");
    const f = candidateInventory();
    mutate(f);
    assert.throws(() => deployment.inspectSessionImages(f.rows, env, f.record));
  });

test("the actual Agent Runtime uses the resolved release image and preserves its selected repository reference", () => {
  assert.equal(typeof deployment.inspectSessionRuntime, "function");
  const f = candidateInventory();
  const result = deployment.inspectSessionRuntime(
    [f.runtime],
    env,
    f.record,
    "agent-1",
  );
  assert.equal(result.image_id, imageID);
  assert.equal(result.image_ref, `antnest/antnest-runtime:${tag}`);
  assert.equal(result.agent_id, "agent-1");
  assert.equal(result.generation, 1);
});

for (const [name, mutate] of [
  ["wrong actual Runtime image", (r) => (r.Image = "sha256:" + "b".repeat(64))],
  [
    "wrong resolved Runtime image",
    (r) => (r.Config.Image = "sha256:" + "b".repeat(64)),
  ],
  [
    "foreign Runtime Agent",
    (r) => (r.Config.Labels["io.antnest.agent-id"] = "agent-2"),
  ],
  [
    "foreign Runtime scope",
    (r) => (r.Config.Labels["io.antnest.runtime-controller-scope"] = "foreign"),
  ],
  [
    "stale Runtime reference",
    (r) =>
      (r.Config.Env[0] =
        "ANTNEST_RUNTIME_IMAGE_REFERENCE=antnest/antnest-runtime:local"),
  ],
  ["duplicate Runtime reference", (r) => r.Config.Env.push(r.Config.Env[0])],
  [
    "missing Runtime generation",
    (r) => delete r.Config.Labels["io.antnest.runtime-generation"],
  ],
  ["stopped Runtime", (r) => (r.State.Running = false)],
])
  test("Session Runtime admission rejects " + name, () => {
    assert.equal(typeof deployment.inspectSessionRuntime, "function");
    const f = candidateInventory();
    mutate(f.runtime);
    assert.throws(() =>
      deployment.inspectSessionRuntime([f.runtime], env, f.record, "agent-1"),
    );
  });
test("Session harness inspection binds real model and client containers to the independently selected ACP image", () => {
  assert.equal(typeof deployment.inspectSessionHarness, "function");
  for (const role of ["client", "model"]) {
    const result = deployment.inspectSessionHarness(
      [harnessRow(role)],
      env,
      role,
      imageID,
    );
    assert.equal(result.image_id, imageID);
    assert.equal(result.role, role);
  }
});
for (const [name, mutate] of [
  ["stale image", (r) => (r.Image = "sha256:" + "b".repeat(64))],
  [
    "stale reference",
    (r) => (r.Config.Image = "antnest/agent-acp-service:local"),
  ],
  [
    "foreign project",
    (r) => (r.Config.Labels["com.docker.compose.project"] = "foreign"),
  ],
  [
    "foreign run",
    (r) => (r.Config.Labels["io.antnest.e2e-run-id"] = "foreign"),
  ],
  [
    "foreign role",
    (r) => (r.Config.Labels["com.docker.compose.service"] = "session-model"),
  ],
  ["already started client", (r) => (r.State.Running = true)],
])
  test("Session harness rejects " + name, () => {
    assert.equal(typeof deployment.inspectSessionHarness, "function");
    const row = harnessRow("client");
    mutate(row);
    assert.throws(() =>
      deployment.inspectSessionHarness([row], env, "client", imageID),
    );
  });
