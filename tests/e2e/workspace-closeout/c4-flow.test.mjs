import assert from "node:assert/strict";
import test from "node:test";

const moduleURL = new URL("./c4-flow.mjs", import.meta.url);
const { runC4Flow, c4PublicResult } = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});
function fixture(failures = {}) {
  const events = [],
    abort = new AbortController();
  const report = {
    status: "running",
    checks: [],
    sessions: {},
    traces: [],
    cleanup: "pending",
    evidence: "private-evidence",
  };
  const config = { project: "test-project" },
    member = {};
  const step = (name) => {
    events.push(name);
    if (failures[name]) throw failures[name];
  };
  const actions = {
    async configure(allocated) {
      allocated(config);
      step("configure");
      return config;
    },
    async deploy() {
      step("deploy");
    },
    async setup() {
      step("setup");
      return member;
    },
    async browser() {
      step("browser");
      report.checks.push("browser-check");
    },
    async refreshModel() {
      step("model");
      report.model = { requests: [], pending: [], errors: [] };
    },
    async refreshAudits() {
      step("audits");
    },
    async refreshRevocation() {
      step("revocation");
    },
    async flush() {
      step("flush");
    },
    inventory() {
      step("inventory");
      return ["chat", "revocation", "offboarding"].map((kind) => ({
        kind,
        traceID: kind,
      }));
    },
    async collect(row) {
      step("collect-" + row.kind);
      return { trace_id: row.traceID, kind: row.kind, strict_trace: "failed" };
    },
    async preserve(row) {
      step("preserve-" + row.kind);
    },
    async admit() {
      step("admit");
      return {
        exitCode: 0,
        rawExitCode: 2,
        strict_trace: "failed",
        owned_internal_error_count: 2,
      };
    },
    async logs() {
      step("logs");
    },
    async cleanup() {
      step("cleanup");
    },
    async checkpoint() {
      step("checkpoint");
    },
  };
  const run = () => {
    assert.equal(typeof runC4Flow, "function");
    return runC4Flow({ report, signal: abort.signal }, actions);
  };
  return { report, config, events, abort, actions, run };
}
test("C4 joins browser, independently refreshes evidence, collects every row and cleans up before final success", async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(result, f.report);
  assert.equal(result.business_completed, true);
  assert.equal(result.status, "passed");
  assert.equal(result.exit_code, 0);
  assert.equal(result.admission.rawExitCode, 2);
  assert.equal(result.cleanup, "verified");
  assert.deepEqual(result.c4Errors, []);
  for (const [a, b] of [
    ["browser", "model"],
    ["model", "audits"],
    ["revocation", "flush"],
    ["flush", "collect-chat"],
    ["collect-offboarding", "admit"],
    ["admit", "cleanup"],
  ])
    assert(f.events.indexOf(a) < f.events.indexOf(b));
  assert.equal(f.events.at(-1), "checkpoint");
});
for (const failed of [
  "browser",
  "model",
  "audits",
  "revocation",
  "flush",
  "collect-chat",
  "collect-revocation",
  "admit",
]) {
  test(`C4 retains ${failed} failure and still collects independent evidence and cleans up`, async () => {
    const original = new Error(failed),
      f = fixture({ [failed]: original });
    const result = await f.run();
    assert(result.c4Errors.includes(original));
    assert.equal(result.status, "failed");
    assert.equal(result.exit_code, 1);
    for (const event of [
      "model",
      "audits",
      "revocation",
      "flush",
      "collect-chat",
      "collect-revocation",
      "collect-offboarding",
      "logs",
      "cleanup",
    ])
      assert(f.events.includes(event), event);
    assert.equal(result.cleanup, "verified");
  });
}
test("C4 retains simultaneous business, capture, collection, archive, log, cleanup and final-write errors", async () => {
  const failures = Object.fromEntries(
    [
      "browser",
      "model",
      "audits",
      "collect-chat",
      "preserve-chat",
      "logs",
      "cleanup",
      "checkpoint",
    ].map((name) => [name, new Error(name)]),
  );
  const f = fixture(failures),
    result = await f.run();
  for (const error of Object.values(failures))
    assert(result.c4Errors.includes(error));
  assert(f.events.includes("collect-offboarding"));
  assert.equal(result.cleanup, "failed");
  assert.equal(result.exit_code, 1);
});
for (const failed of ["configure", "deploy", "setup"]) {
  test(`C4 cleans the allocated project after ${failed} failure`, async () => {
    const original = new Error(failed),
      f = fixture({ [failed]: original });
    const result = await f.run();
    assert(result.c4Errors.includes(original));
    assert(!f.events.includes("browser"));
    assert(f.events.includes("logs"));
    assert(f.events.includes("cleanup"));
    assert.equal(result.exit_code, 1);
  });
}
test("C4 cleanup failure cannot replace the first business error", async () => {
  const business = new Error("business"),
    cleanup = new Error("cleanup");
  const f = fixture({ browser: business, cleanup }),
    result = await f.run();
  assert.equal(result.c4Errors[0], business);
  assert(result.c4Errors.includes(cleanup));
});
test("C4 joins cleanup and records an unexpected collection-framework failure", async () => {
  const f = fixture();
  f.actions.inventory = () => ({ invalid: true });
  const result = await f.run();
  assert.equal(result.exit_code, 1);
  assert.equal(result.cleanup, "verified");
  assert.equal(result.c4Errors.length, 1);
  assert(result.c4Errors[0] instanceof TypeError);
  assert(f.events.includes("logs"));
  assert.equal(f.events.at(-1), "checkpoint");
});
test("C4 stops new collectors on parent cancellation, joins the active collector and independently cleans up", async () => {
  const f = fixture(),
    original = new Error("parent cancelled"),
    collector = new Error("active collector"),
    archive = new Error("archive");
  let joined = false;
  f.actions.collect = async (row) => {
    f.events.push("collect-" + row.kind);
    f.abort.abort(original);
    await Promise.resolve();
    joined = true;
    throw collector;
  };
  f.actions.preserve = async () => {
    throw archive;
  };
  f.actions.cleanup = async () => {
    assert(joined);
    f.events.push("cleanup");
  };
  const result = await f.run();
  assert.deepEqual(
    result.c4Errors.filter((e) => [original, collector, archive].includes(e))
      .length,
    3,
  );
  assert(!f.events.includes("collect-revocation"));
  assert(f.events.includes("cleanup"));
  assert.equal(result.exit_code, 1);
});
test("C4 retains cancellation during final checkpoint after successful cleanup", async () => {
  const f = fixture(),
    original = new Error("late cancellation");
  f.actions.checkpoint = async () => {
    if (f.events.includes("cleanup")) f.abort.abort(original);
  };
  const result = await f.run();
  assert(result.c4Errors.includes(original));
  assert.equal(result.exit_code, 1);
});
test("C4 persists the failed verdict if cancellation arrives during the final successful write", async () => {
  const f = fixture(),
    original = new Error("cancelled while persisting verdict"),
    snapshots = [];
  f.actions.checkpoint = async (report) => {
    snapshots.push(structuredClone(report));
    if (f.events.includes("cleanup") && !f.abort.signal.aborted)
      f.abort.abort(original);
  };
  const result = await f.run();
  assert.equal(result.exit_code, 1);
  assert.equal(snapshots.at(-1).exit_code, 1);
  assert.equal(snapshots.at(-1).status, "failed");
  assert(
    snapshots
      .at(-1)
      .private_errors.some((error) => error.includes(original.message)),
  );
});
for (const stage of [
  "configure",
  "setup",
  "refreshModel",
  "refreshAudits",
  "refreshRevocation",
  "flush",
  "inventory",
])
  test(`C4 joins ${stage} when cancelled and starts no later business or evidence step`, async () => {
    const f = fixture(),
      original = new Error("cancelled during " + stage),
      action = f.actions[stage];
    let joined = false;
    f.actions[stage] = async (...args) => {
      const result = await action(...args);
      f.abort.abort(original);
      await Promise.resolve();
      joined = true;
      f.events.push("cancelled-step-joined");
      return result;
    };
    f.actions.cleanup = async () => {
      assert(joined);
      f.events.push("cleanup");
    };
    const result = await f.run();
    assert.deepEqual(
      f.events.slice(f.events.indexOf("cancelled-step-joined") + 1),
      ["logs", "cleanup", "checkpoint"],
    );
    assert(result.c4Errors.includes(original));
    assert.equal(result.exit_code, 1);
  });
test("C4 cannot accept an unreviewed raw strict failure", async () => {
  const f = fixture();
  f.actions.admit = async () => ({
    exitCode: 2,
    rawExitCode: 2,
    strict_trace: "failed",
  });
  const result = await f.run();
  assert.equal(result.exit_code, 2);
  assert.equal(result.status, "strict_findings");
});
test("C4 public output excludes original receipts, body diagnostics and credentials", async () => {
  const f = fixture({ browser: new Error("C4-PRIVATE-FLOW-CANARY") });
  f.report.page_login = { rawBody: "C4-PRIVATE-FLOW-CANARY" };
  f.report.model = { secret: "C4-PRIVATE-FLOW-CANARY" };
  const result = await f.run();
  assert.equal(typeof c4PublicResult, "function");
  const visible = c4PublicResult(result);
  assert(!JSON.stringify(visible).includes("C4-PRIVATE-FLOW-CANARY"));
  assert.equal(visible.exit_code, 1);
  assert.equal(visible.error_count, 1);
  assert.equal(visible.cleanup, "verified");
  assert(
    result.private_errors.some((error) =>
      error.includes("C4-PRIVATE-FLOW-CANARY"),
    ),
  );
});
