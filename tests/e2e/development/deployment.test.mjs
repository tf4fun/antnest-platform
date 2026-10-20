import assert from "node:assert/strict";
import test from "node:test";
import {
  shellEntrypoint,
  shellComposeFiles,
} from "../../support/authenticated-shell-e2e.mjs";

test("Development recovery waits for the original Controller to be healthy before querying its Agent", async () => {
  const { resumeDevelopmentController } = await import("./deployment.mjs");
  const calls = [];
  let healthy = false;
  const result = await resumeDevelopmentController(
    { Id: "original-controller" },
    {
      start: async (id) => {
        assert.equal(id, "original-controller");
        calls.push("start");
      },
      inspectContainer: async () => {
        calls.push("inspect");
        const status = healthy ? "healthy" : "starting";
        healthy = true;
        return {
          Id: "original-controller",
          State: { Running: true, Health: { Status: status } },
        };
      },
      readAgent: async () => {
        assert.equal(
          calls.filter((row) => row === "inspect").length,
          2,
          "would receive startup HTTP 503",
        );
        calls.push("agent");
        return {
          failure_stage: "runtime_observation",
          failure_code: "runtime_execution_changed",
          executable_execution_revision: "",
        };
      },
      poll: async (check) => (await check()) || check(),
    },
  );
  assert.equal(result.controller.State.Health.Status, "healthy");
  assert.equal(result.agent.failure_code, "runtime_execution_changed");
  assert.deepEqual(calls, ["start", "inspect", "inspect", "agent"]);
});

test("Development recovery cannot accept a replacement Controller as the restarted original", async () => {
  const { resumeDevelopmentController } = await import("./deployment.mjs");
  await assert.rejects(
    resumeDevelopmentController(
      { Id: "original-controller" },
      {
        start: async () => {},
        inspectContainer: async () => ({
          Id: "replacement",
          State: { Running: true, Health: { Status: "healthy" } },
        }),
        readAgent: async () => assert.fail("queried after wrong Controller"),
        poll: (check) => check(),
      },
    ),
  );
});

test("Development enters the existing fresh-candidate builder", () => {
  assert.deepEqual(shellEntrypoint("development"), [
    "node",
    "tests/e2e/development/run.mjs",
  ]);
  assert.deepEqual(
    shellComposeFiles("development"),
    shellComposeFiles("workspace-browser"),
  );
});
test("Development keeps the candidate stack and selects its own provider and private ingress", async () => {
  const { developmentConfiguration } = await import("./deployment.mjs");
  const environment = {
    ANTNEST_E2E_CANDIDATE_TAG: "shell-1234abcd",
    ANTNEST_E2E_RUNTIME_IMAGE: "antnest/antnest-runtime:shell-1234abcd",
  };
  let selected, allocated;
  const base = {
    project: "antnest-lifecycle-1234abcd",
    env: { ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "false" },
    compose: (args) => ["compose", "-f", "candidate.yaml", ...args],
  };
  const config = await developmentConfiguration(
    undefined,
    (value) => {
      allocated = value;
    },
    {
      environment,
      async configuration(_signal, before, options) {
        selected = options.environment;
        before(base.project);
        return base;
      },
    },
  );
  assert.equal(selected, environment);
  assert.equal(allocated, base.project);
  assert.equal(config.env.ANTNEST_DEVELOPMENT_OTLP_HOST_PORT, "0");
  assert.equal(config.env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT, "false");
  assert.deepEqual(config.compose(["up", "-d", "--no-build"]), [
    "compose",
    "-f",
    "candidate.yaml",
    "-f",
    "tests/e2e/development/compose.yaml",
    "up",
    "-d",
    "--no-build",
  ]);
  await assert.rejects(
    developmentConfiguration(
      undefined,
      () => assert.fail("allocated without candidate"),
      { environment: {} },
    ),
  );
});
test("Development private drivers use the actual loopback publications", async () => {
  const { developmentPrivateAccess } = await import("./deployment.mjs");
  const calls = [];
  const config = {
    credentials: "/owned/credentials",
    compose: (args) => ["compose", ...args],
  };
  const result = await developmentPrivateAccess(config, async (args) => {
    calls.push(args);
    return `127.0.0.1:${52000 + calls.length}`;
  });
  assert.deepEqual(result, {
    credentials: config.credentials,
    acp: "http://127.0.0.1:52001",
    identity: "http://127.0.0.1:52002",
    otlp: "http://127.0.0.1:52003/v1/traces",
  });
  assert.deepEqual(
    calls.map((args) => args.slice(-2)),
    [
      ["diagnostic-relay", "58081"],
      ["diagnostic-relay", "58082"],
      ["development-client-telemetry", "4318"],
    ],
  );
  for (const invalid of [
    "0.0.0.0:52001",
    "127.0.0.1:0",
    "127.0.0.1:70000",
    "127.0.0.1:52001\n127.0.0.1:52002",
  ])
    await assert.rejects(developmentPrivateAccess(config, async () => invalid));
});
function fixture(change = {}) {
  const calls = [],
    report = {},
    abort = new AbortController();
  const config = { project: "owned" };
  const actions = Object.fromEntries(
    ["deploy", "browser", "drivers", "logs", "cleanup"].map((name) => [
      name,
      async () => {
        calls.push(name);
      },
    ]),
  );
  Object.assign(
    actions,
    {
      configure: async () => {
        calls.push("configure");
        return config;
      },
      admit: async () => {
        calls.push("admit");
        return { passed: true };
      },
      save: async (value) => {
        calls.push("save:" + value.status);
      },
    },
    change,
  );
  return { calls, report, abort, config, actions };
}
test("Development admits only after every deployed step and owned cleanup", async () => {
  const { runDevelopmentFlow } = await import("./deployment.mjs");
  const f = fixture();
  await runDevelopmentFlow(
    { report: f.report, signal: f.abort.signal },
    f.actions,
  );
  assert.equal(f.report.status, "passed");
  assert.equal(f.report.cleanup, "verified");
  assert.deepEqual(f.calls, [
    "configure",
    "deploy",
    "browser",
    "drivers",
    "admit",
    "logs",
    "cleanup",
    "save:passed",
  ]);
});
test("Development preserves business and cleanup failures independently", async () => {
  const { runDevelopmentFlow } = await import("./deployment.mjs");
  const original = new Error("original browser"),
    cleanup = new Error("original cleanup");
  const f = fixture({
    browser: async () => {
      throw original;
    },
    cleanup: async () => {
      throw cleanup;
    },
  });
  await runDevelopmentFlow(
    { report: f.report, signal: f.abort.signal },
    f.actions,
  );
  assert.equal(f.report.status, "failed");
  assert.deepEqual(f.report.developmentErrors, [original, cleanup]);
  assert(!f.calls.includes("drivers"));
  assert(f.calls.includes("logs"));
});
test("Development cleans a partially allocated deployment", async () => {
  const { runDevelopmentFlow } = await import("./deployment.mjs");
  const original = new Error("configuration failed");
  let cleaned;
  const f = fixture({
    configure: async (allocated) => {
      allocated({ project: "partial" });
      throw original;
    },
    cleanup: async (config) => {
      cleaned = config.project;
    },
  });
  await runDevelopmentFlow({ report: f.report }, f.actions);
  assert.equal(cleaned, "partial");
  assert.equal(f.report.status, "failed");
  assert.equal(f.report.developmentErrors[0], original);
});
test("Development cancellation joins the current step and skips later work", async () => {
  const { runDevelopmentFlow } = await import("./deployment.mjs");
  const original = new Error("stop requested");
  const f = fixture();
  f.actions.browser = async () => {
    f.abort.abort(original);
    f.calls.push("browser joined");
  };
  await runDevelopmentFlow(
    { report: f.report, signal: f.abort.signal },
    f.actions,
  );
  assert(!f.calls.includes("drivers"));
  assert(f.calls.includes("cleanup"));
  assert.equal(f.report.developmentErrors[0], original);
  assert.equal(f.report.status, "failed");
});
test("Development cancellation during final evidence rewrites the terminal result as failed", async () => {
  const { runDevelopmentFlow } = await import("./deployment.mjs");
  const f = fixture(),
    statuses = [],
    original = new Error("archive cancelled");
  f.actions.save = async (value) => {
    statuses.push(value.status);
    f.abort.abort(original);
  };
  await runDevelopmentFlow(
    { report: f.report, signal: f.abort.signal },
    f.actions,
  );
  assert.deepEqual(statuses, ["passed", "failed"]);
  assert.equal(f.report.status, "failed");
  assert.equal(f.report.developmentErrors[0], original);
});
