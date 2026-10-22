import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

const diagnosticDirectory = mkdtempSync(join(tmpdir(), "c4-flow-diagnostics-"));
after(() => rmSync(diagnosticDirectory, { recursive: true, force: true }));

const moduleURL = new URL("./c4-flow.mjs", import.meta.url);
const { runC4Flow, c4PublicResult } = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});
function fixture(failures = {}, { budgetMs = 60_000 } = {}) {
  const events = [],
    abort = new AbortController(),
    collectionSignals = [],
    diagnostics = createTraceDiagnostics({
      directory: diagnosticDirectory,
      signal: abort.signal,
      budgetMs,
    });
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
  let strictOutcome;
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
    async collect(row, actualConfig, actualReport, signal) {
      assert.equal(actualConfig, config);
      assert.equal(actualReport, report);
      assert(signal instanceof AbortSignal);
      assert.notEqual(signal, abort.signal);
      collectionSignals.push(signal);
      step("collect-" + row.kind);
      return { trace_id: row.traceID, kind: row.kind, strict_trace: "failed" };
    },
    async preserve(row) {
      step("preserve-" + row.kind);
    },
    async inspectTraces(actualReport, actualConfig) {
      assert.equal(actualReport, report);
      assert.equal(actualConfig, config);
      step("inspect-traces");
      assert.equal(report.traces.length, 3, "complete C4 Trace rows required");
      assert(
        report.traces.every((row) => row.topology === "passed"),
        "C4 Trace sources unavailable",
      );
      strictOutcome = {
        exit_code: 2,
        strict_trace: "failed",
        accepted: true,
        reviewed_error_spans: 2,
      };
      return strictOutcome;
    },
    async admit() {
      step("admit");
      step("body");
      return {
        exitCode: 0,
        rawExitCode: strictOutcome?.exit_code ?? null,
        strict_trace: strictOutcome?.strict_trace ?? "not_collected",
        owned_internal_error_count: strictOutcome?.reviewed_error_spans ?? 0,
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
    return runC4Flow({ report, signal: abort.signal, diagnostics }, actions);
  };
  return {
    report,
    config,
    events,
    abort,
    actions,
    diagnostics,
    collectionSignals,
    run,
  };
}
function diagnosticFailures(f, result) {
  const summary = result.trace_diagnostics;
  assert.equal(summary.role, "auxiliary");
  assert.equal(summary.status, "warning");
  assert.deepEqual(summary, f.diagnostics.summary());
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(diagnosticDirectory, summary.evidence), "utf8"),
    ),
    summary,
  );
  return summary.checks
    .filter((row) => row.failure_evidence)
    .map((row) =>
      readFileSync(join(diagnosticDirectory, row.failure_evidence), "utf8"),
    )
    .join("\n");
}
test("C4 joins browser, independently refreshes evidence, collects every row and cleans up before final success", async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(result, f.report);
  assert.equal(result.business_completed, true);
  assert.equal(result.status, "passed");
  assert.equal(result.exit_code, 0);
  assert.equal(result.admission.rawExitCode, 2);
  assert.equal(result.admission.strict_trace, "failed");
  assert.equal(result.cleanup, "verified");
  assert.deepEqual(result.c4Errors, []);
  assert.deepEqual(result.trace_diagnostics, f.diagnostics.summary());
  assert.equal(result.trace_diagnostics.role, "auxiliary");
  assert.equal(f.collectionSignals.length, 3);
  assert(
    f.collectionSignals.every((signal) => signal === f.collectionSignals[0]),
  );
  for (const [a, b] of [
    ["browser", "model"],
    ["model", "audits"],
    ["revocation", "flush"],
    ["flush", "collect-chat"],
    ["collect-offboarding", "inspect-traces"],
    ["inspect-traces", "admit"],
    ["admit", "body"],
    ["body", "cleanup"],
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
  "admit",
  "body",
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
      "inspect-traces",
      "logs",
      "cleanup",
    ])
      assert(f.events.includes(event), event);
    assert.equal(result.cleanup, "verified");
  });
}
for (const failed of [
  "collect-chat",
  "collect-revocation",
  "preserve-chat",
  "inventory",
  "inspect-traces",
]) {
  test(`C4 ${failed} failure remains auxiliary while body admission and cleanup complete`, async () => {
    const original = new Error("C4 diagnostic " + failed),
      failures = { [failed]: original };
    if (failed === "preserve-chat")
      failures["collect-chat"] = new Error("C4 original collection failure");
    const f = fixture(failures),
      result = await f.run();
    assert.equal(result.business_completed, true);
    assert.equal(result.status, "passed");
    assert.equal(result.exit_code, 0);
    assert.equal(result.admission.rawExitCode, null);
    assert.equal(result.cleanup, "verified");
    assert.deepEqual(result.c4Errors, []);
    assert.deepEqual(result.private_errors, []);
    for (const event of ["inspect-traces", "admit", "body", "cleanup"])
      assert(f.events.includes(event), event);
    if (failed !== "inventory") {
      assert(f.events.includes("collect-offboarding"));
      const kind = failed === "collect-revocation" ? "revocation" : "chat";
      if (failed !== "inspect-traces")
        assert.equal(
          result.traces.find((row) => row.kind === kind).topology,
          "failed",
        );
    }
    const raw = diagnosticFailures(f, result);
    for (const error of Object.values(failures))
      assert(raw.includes(error.message));
    assert.equal(f.events.at(-1), "checkpoint");
  });
}
test("C4 retains simultaneous hard errors while collection and archive failures remain private diagnostics", async () => {
  const failures = Object.fromEntries(
    [
      "browser",
      "model",
      "audits",
      "collect-chat",
      "preserve-chat",
      "inspect-traces",
      "admit",
      "logs",
      "cleanup",
      "checkpoint",
    ].map((name) => [name, new Error(name)]),
  );
  const f = fixture(failures),
    result = await f.run();
  for (const [name, error] of Object.entries(failures))
    assert.equal(
      result.c4Errors.includes(error),
      !["collect-chat", "preserve-chat", "inspect-traces"].includes(name),
      name,
    );
  const raw = diagnosticFailures(f, result);
  for (const name of ["collect-chat", "preserve-chat", "inspect-traces"])
    assert(raw.includes(failures[name].message));
  assert(f.events.includes("collect-offboarding"));
  assert(f.events.includes("admit"));
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
test("C4 collection-framework failure remains auxiliary and does not suppress body admission or cleanup", async () => {
  const f = fixture();
  f.actions.inventory = () => ({ invalid: true });
  const result = await f.run();
  assert.equal(result.exit_code, 0);
  assert.equal(result.status, "passed");
  assert.equal(result.admission.rawExitCode, null);
  assert.equal(result.cleanup, "verified");
  assert.deepEqual(result.c4Errors, []);
  assert(f.events.includes("admit") && f.events.includes("body"));
  assert(
    result.trace_diagnostics.checks.some(
      (row) => row.error_type === "TypeError",
    ),
  );
  assert(diagnosticFailures(f, result).includes("TypeError"));
  assert.equal(f.events.at(-1), "checkpoint");
});
for (const failed of ["browser", "body", "admit", "flush", "cleanup"]) {
  test(`C4 ${failed} still blocks after collection and strict diagnostics fail`, async () => {
    const original = new Error("C4 hard " + failed),
      collection = new Error("C4 collection unavailable"),
      strict = new Error("C4 strict inspection unavailable"),
      f = fixture({
        [failed]: original,
        "collect-chat": collection,
        "inspect-traces": strict,
      });
    const result = await f.run();
    assert(result.c4Errors.includes(original));
    assert(!result.c4Errors.includes(collection));
    assert(!result.c4Errors.includes(strict));
    assert.equal(result.status, "failed");
    assert.equal(result.exit_code, 1);
    assert.equal(result.cleanup, failed === "cleanup" ? "failed" : "verified");
    assert(f.events.includes("admit"));
    assert(f.events.includes("cleanup"));
    const raw = diagnosticFailures(f, result);
    assert(raw.includes(collection.message));
    assert(raw.includes(strict.message));
  });
}
test("C4 one shared diagnostic budget cancels and joins a held collector before body admission and cleanup", async () => {
  const f = fixture({}, { budgetMs: 20 }),
    entered = Promise.withResolvers(),
    cancelled = Promise.withResolvers(),
    release = Promise.withResolvers();
  let joined = false,
    returned = false;
  f.actions.collect = async (row, _config, _report, signal) => {
    f.events.push("collect-" + row.kind);
    entered.resolve(signal);
    assert(signal instanceof AbortSignal);
    try {
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      cancelled.resolve();
      await release.promise;
      signal.throwIfAborted();
    } finally {
      joined = true;
      f.events.push("collector-joined");
    }
  };
  f.actions.cleanup = async () => {
    assert(joined);
    f.events.push("cleanup");
  };
  const watchdog = setTimeout(
    () => f.abort.abort(new Error("diagnostic collector did not cancel")),
    1000,
  );
  const pending = f.run().then((result) => {
    returned = true;
    return result;
  });
  try {
    const signal = await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("C4 returned without starting the held collector");
      }),
    ]);
    assert(signal instanceof AbortSignal);
    assert.notEqual(signal, f.abort.signal);
    await Promise.race([
      cancelled.promise,
      pending.then(() => {
        throw new Error("C4 returned before its held collector cancelled");
      }),
    ]);
    assert.equal(f.abort.signal.aborted, false);
    assert.equal(returned, false);
    assert.equal(joined, false);
    assert.equal(f.report.status, "running");
    assert.equal(f.report.exit_code, undefined);
    assert.equal(f.report.cleanup, "pending");
    for (const event of ["admit", "body", "cleanup"])
      assert(!f.events.includes(event), event);
    release.resolve();
    const result = await pending;
    assert.equal(joined, true);
    assert.equal(result.status, "passed");
    assert.equal(result.exit_code, 0);
    assert.equal(result.admission.rawExitCode, null);
    assert.equal(result.cleanup, "verified");
    assert.deepEqual(result.c4Errors, []);
    assert(!f.events.includes("collect-revocation"));
    assert(!f.events.includes("collect-offboarding"));
    assert(!f.events.includes("inspect-traces"));
    assert(f.events.indexOf("collector-joined") < f.events.indexOf("admit"));
    assert(f.events.includes("body"));
    assert.deepEqual(
      result.trace_diagnostics.checks.map((row) => row.status),
      ["unavailable", "not_collected"],
    );
    assert(
      diagnosticFailures(f, result).includes(
        "Trace diagnostic budget exhausted",
      ),
    );
  } finally {
    clearTimeout(watchdog);
    release.resolve();
    if (!returned || !joined)
      f.abort.abort(new Error("held collector test cleanup"));
    await pending;
  }
});
test("C4 joins a late inspection after budget cancellation and keeps its raw verdict unknown", async () => {
  const f = fixture({}, { budgetMs: 20 }),
    entered = Promise.withResolvers(),
    cancelled = Promise.withResolvers(),
    release = Promise.withResolvers(),
    lateOutcome = {
      exit_code: 0,
      strict_trace: "passed",
      accepted: true,
      reviewed_error_spans: 0,
    };
  let joined = false,
    lateReturned = false,
    returned = false;
  f.actions.inspectTraces = async (report, config, signal) => {
    assert.equal(report, f.report);
    assert.equal(config, f.config);
    f.events.push("inspect-traces");
    entered.resolve(signal);
    assert(signal instanceof AbortSignal);
    try {
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      cancelled.resolve();
      await release.promise;
      lateReturned = true;
      return lateOutcome;
    } finally {
      joined = true;
      f.events.push("inspection-joined");
    }
  };
  f.actions.admit = async (report, config) => {
    assert.equal(report, f.report);
    assert.equal(config, f.config);
    assert(joined);
    f.events.push("admit", "body");
    return {
      exitCode: 0,
      rawExitCode: report.trace_outcome?.exit_code ?? null,
      strict_trace: report.trace_outcome?.strict_trace ?? "not_collected",
    };
  };
  f.actions.cleanup = async () => {
    assert(joined);
    f.events.push("cleanup");
  };
  const watchdog = setTimeout(
    () => f.abort.abort(new Error("diagnostic inspection did not cancel")),
    1000,
  );
  const pending = f.run().then((result) => {
    returned = true;
    return result;
  });
  try {
    const signal = await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("C4 returned without starting the held inspection");
      }),
    ]);
    assert(signal instanceof AbortSignal);
    assert.notEqual(signal, f.abort.signal);
    await Promise.race([
      cancelled.promise,
      pending.then(() => {
        throw new Error("C4 returned before its held inspection cancelled");
      }),
    ]);
    assert.equal(signal.aborted, true);
    assert.equal(f.abort.signal.aborted, false);
    assert.equal(joined, false);
    assert.equal(lateReturned, false);
    assert.equal(returned, false);
    assert.equal(f.report.status, "running");
    assert.equal(f.report.exit_code, undefined);
    assert.equal(f.report.cleanup, "pending");
    assert.equal(Object.hasOwn(f.report, "trace_outcome"), false);
    for (const event of ["admit", "body", "cleanup"])
      assert(!f.events.includes(event), event);
    release.resolve();
    const result = await pending;
    assert.equal(joined, true);
    assert.equal(lateReturned, true);
    assert.equal(result.status, "passed");
    assert.equal(result.exit_code, 0);
    assert.equal(Object.hasOwn(result, "trace_outcome"), false);
    assert.equal(result.admission.rawExitCode, null);
    assert.equal(result.admission.strict_trace, "not_collected");
    assert.equal(result.cleanup, "verified");
    assert.deepEqual(result.c4Errors, []);
    assert(f.events.indexOf("inspection-joined") < f.events.indexOf("admit"));
    assert(f.events.indexOf("body") < f.events.indexOf("cleanup"));
    assert.deepEqual(
      result.trace_diagnostics.checks.map((row) => row.status),
      ["passed", "unavailable"],
    );
    assert(
      diagnosticFailures(f, result).includes(
        "Trace diagnostic budget exhausted",
      ),
    );
  } finally {
    clearTimeout(watchdog);
    release.resolve();
    if (!returned || !joined)
      f.abort.abort(new Error("held inspection test cleanup"));
    await pending;
  }
});
test("C4 does not publish a successful verdict before actual cleanup joins", async () => {
  const f = fixture(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let returned = false;
  f.actions.cleanup = async () => {
    f.events.push("cleanup");
    entered.resolve();
    await release.promise;
  };
  const pending = f.run().then((result) => {
    returned = true;
    return result;
  });
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("C4 returned without joining actual cleanup");
      }),
    ]);
    assert.equal(returned, false);
    assert.equal(f.report.status, "running");
    assert.equal(f.report.exit_code, undefined);
    assert.equal(f.report.cleanup, "pending");
    release.resolve();
    const result = await pending;
    assert.equal(result.status, "passed");
    assert.equal(result.cleanup, "verified");
  } finally {
    release.resolve();
    await pending;
  }
});
test("C4 stops new collectors on parent cancellation, joins the active collector and independently cleans up", async () => {
  const f = fixture(),
    original = new Error("parent cancelled"),
    collector = new Error("active collector"),
    archive = new Error("archive");
  let joined = false;
  f.actions.collect = async (row, _config, _report, signal) => {
    assert(signal instanceof AbortSignal);
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
  assert(result.c4Errors.includes(original));
  assert(!result.c4Errors.includes(collector));
  assert(!result.c4Errors.includes(archive));
  assert(!f.events.includes("collect-revocation"));
  assert(!f.events.includes("inspect-traces"));
  assert(!f.events.includes("admit"));
  assert(f.events.includes("cleanup"));
  assert.equal(result.cleanup, "verified");
  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 1);
  const raw = diagnosticFailures(f, result);
  assert(raw.includes(collector.message));
  assert(raw.includes(archive.message));
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
  "inspectTraces",
  "admit",
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
test("C4 nonzero business admission remains a hard failure after strict diagnostics fail", async () => {
  const strict = new Error("unreviewed raw strict failure"),
    f = fixture({ "inspect-traces": strict });
  f.actions.admit = async () => ({
    exitCode: 2,
    rawExitCode: 2,
    strict_trace: "failed",
  });
  const result = await f.run();
  assert.equal(result.exit_code, 1);
  assert.equal(result.status, "failed");
  assert(result.c4Errors.length > 0);
  assert(!result.c4Errors.includes(strict));
  assert.equal(result.cleanup, "verified");
  assert(diagnosticFailures(f, result).includes(strict.message));
});
test("C4 unknown raw strict verdict stays null while independent business admission passes", async () => {
  const f = fixture({
    "inspect-traces": new Error("strict sources unavailable"),
  });
  const result = await f.run();
  assert.equal(result.exit_code, 0);
  assert.equal(result.status, "passed");
  assert.equal(result.admission.rawExitCode, null);
  assert.notEqual(result.admission.strict_trace, "passed");
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.deepEqual(result.c4Errors, []);
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
test("C4 auxiliary failures retain private originals without exposing messages or credentials in public results", async () => {
  const canary = "C4-PRIVATE-DIAGNOSTIC-CANARY",
    collection = new Error(canary, { cause: { credential: canary } }),
    archive = new Error("archive-" + canary),
    strict = new Error("strict-" + canary),
    f = fixture({
      "collect-chat": collection,
      "preserve-chat": archive,
      "inspect-traces": strict,
    });
  f.report.page_login = { rawBody: canary };
  f.report.model = { secret: canary };
  const result = await f.run(),
    visible = c4PublicResult(result);
  assert.equal(result.status, "passed");
  assert.equal(visible.exit_code, 0);
  assert.equal(visible.error_count, 0);
  assert.equal(visible.cleanup, "verified");
  assert(!JSON.stringify(visible).includes(canary));
  assert(!JSON.stringify(result.trace_diagnostics).includes(canary));
  assert.deepEqual(result.private_errors, []);
  const raw = diagnosticFailures(f, result);
  for (const error of [collection, archive, strict])
    assert(raw.includes(error.message));
  assert(raw.includes("credential"));
});
