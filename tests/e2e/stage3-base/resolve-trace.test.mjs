import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as admission from "./trace.mjs";
import { inspectReadonlyCreateReplay } from "../lifecycle-closeout/replay-admission.mjs";
import {
  collectFoundationLifecycle,
  collectReadonlyCreateReplay,
} from "../lifecycle-closeout/foundation-trace.mjs";
import {
  foundationAcceptedTraceExitCode,
  acceptedClockOnlyRestore,
} from "../lifecycle-closeout/foundation-evidence.mjs";
import {
  lifecycleResolutionFixture,
  replayResolutionFixture,
} from "./resolve-fixtures.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { unreviewedWarnings } from "../../support/strict-findings.mjs";
import {
  sourceID,
  triggerID,
  resolvePrefix as prefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

const inspect = (f) => {
  assert.equal(typeof admission.inspectLifecycleResolution, "function");
  return admission.inspectLifecycleResolution(
    f.trace,
    f.expected,
    ["PRIVATE"],
    f,
  );
};
const clockWarning =
  "clock skew adjustment disabled; not applying calculated delta of 500µs";

for (const kind of ["create", "enable", "disable", "rebuild", "delete"])
  for (const source of ["rpc", "cache", "shared"])
    test(`${kind} binds ${source} console admission while retaining the workflow business gates`, () => {
      const f = lifecycleResolutionFixture(kind, source);
      const before = JSON.stringify([...f.traces.values()]);
      assert.equal(inspect(f).source, source);
      assert.equal(inspect(f).profile, "console");
      assert.equal(admission.inspectLifecycle(f.trace, f.expected).kind, kind);
      assert.equal(JSON.stringify([...f.traces.values()]), before);
    });

for (const source of ["rpc", "cache", "shared"])
  test(`readonly replay retains its one read-only business transaction with ${source} admission`, () => {
    const f = replayResolutionFixture(source);
    assert.equal(inspect(f).source, source);
    assert.equal(
      inspectReadonlyCreateReplay(f.trace, f.expected).readonly_transaction,
      true,
    );
  });

for (const [name, change] of [
  [
    "wrong workspace profile",
    (f) => setTag(f.decision, prefix + "profile", "workspace"),
  ],
  [
    "missing decision",
    (f) => (f.trace.spans = f.trace.spans.filter((s) => s !== f.decision)),
  ],
  [
    "duplicate decision",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.decision),
        spanID: "other-decision",
      }),
  ],
  ["detached decision", (f) => (f.decision.references[0].spanID = "upstream")],
  ["late decision", (f) => (f.decision.duration = 50000)],
  ["foreign root", (f) => setTag(f.root, "http.route", "/other")],
  ["wrong Console forwarding", (f) => (f.upstream.processID = "admin-console")],
  [
    "nested Console forwarding",
    (f) => (f.upstream.references[0].spanID = "decision"),
  ],
  ["wrong trace", (f) => (f.expected.traceID = "f".repeat(32))],
  ["missing archive", (f) => f.archivedTraceIDs.delete(sourceID)],
  [
    "source SQL missing",
    (f) =>
      (f.traces.get(sourceID).spans = f.traces
        .get(sourceID)
        .spans.filter((s) => s.spanID !== "sql")),
  ],
  ["private trigger", (f) => (f.traces.get(triggerID).private = "PRIVATE")],
  [
    "unknown source diagnostic",
    (f) =>
      setTag(f.traces.get(sourceID).spans[0], prefix + "secret", "private"),
  ],
  [
    "unknown source parent",
    (f) =>
      (f.traces.get(sourceID).spans.at(-1).references[0].spanID = "missing"),
  ],
])
  test(`Lifecycle admission rejects ${name}`, () => {
    const f = lifecycleResolutionFixture("create", "shared");
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });
for (const id of ["resolve-client", "resolve-server", "sql"])
  test(`Lifecycle rejects actual Resolve ${id} failure despite HTTP 200`, () => {
    const f = lifecycleResolutionFixture("create", "shared");
    inspect(f);
    setTag(
      f.traces.get(sourceID).spans.find((s) => s.spanID === id),
      "error",
      true,
    );
    assert.throws(() => inspect(f), /failed actual Resolve/u);
  });

function collection(t, replay = false) {
  const f = replay
    ? replayResolutionFixture("shared")
    : lifecycleResolutionFixture("create", "shared");
  f.directory = mkdtempSync(
    join(temporaryStorageRoot(), "lifecycle-resolution-"),
  );
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  f.queries = [];
  f.request = async (url) => {
    const id = new URL(url).pathname.split("/").at(-1);
    f.queries.push(id);
    return Response.json({ data: [f.traces.get(id)] });
  };
  f.wait = async () => {};
  f.attempts = 4;
  f.inspect = replay ? inspectReadonlyCreateReplay : admission.inspectLifecycle;
  return f;
}
const collect = (f) => {
  assert.equal(typeof admission.collectLifecycleAdmissionTrace, "function");
  return admission.collectLifecycleAdmissionTrace(
    "http://jaeger",
    f.expected,
    ["PRIVATE"],
    f,
  );
};

test("Lifecycle collector archives and converges the full closure, preserving source warnings", async (t) => {
  const f = collection(t);
  f.traces.get(triggerID).warnings = ["unreviewed source warning"];
  const result = await collect(f);
  assert.equal(result.kind, "create");
  assert.equal(result.gateway_resolution.source, "shared");
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.resolve_source_error_spans, 0);
  assert.equal(result.warning_count, 1);
  assert.deepEqual(unreviewedWarnings(JSON.stringify(result)), [
    "unreviewed source warning",
  ]);
  for (const [id, trace] of f.traces) {
    assert.equal(f.queries.filter((value) => value === id).length, 3);
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.directory, `${id}.json`), "utf8")),
      trace,
    );
  }
});

test("source caller errors remain strict failures and are never clock-only waivers", async (t) => {
  const f = collection(t);
  setTag(f.traces.get(triggerID).spans[0], "error", true);
  f.traces.get(triggerID).warnings = [clockWarning];
  const result = await collect(f);
  assert.equal(result.resolve_source_error_spans, 1);
  assert.equal(result.error_spans, 1);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.inspector_diagnostics.strict_trace, "passed");
  assert.equal(admission.clockWarningsOnly([result]), false);
  assert.equal(
    acceptedClockOnlyRestore([{ ...result, topology: "passed" }]),
    false,
  );
});

test("Lifecycle collector awaits its owning inspector and keeps its strict failure", async (t) => {
  const f = collection(t);
  const owning = f.inspect;
  let completed = 0;
  f.inspect = async (...args) => {
    await Promise.resolve();
    completed++;
    return {
      ...owning(...args),
      strict_trace: "failed",
      warnings: ["business-only finding"],
      warning_count: 1,
    };
  };
  const result = await collect(f);
  assert.equal(completed, 3);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.inspector_diagnostics.warning_count, 1);
  assert(
    unreviewedWarnings(JSON.stringify(result)).includes(
      "business-only finding",
    ),
  );
});

for (const [name, change] of [
  [
    "missing owner authorization",
    (f) =>
      (f.trace.spans = f.trace.spans.filter(
        (s) => s.spanID !== "business-rpc-admit_agent",
      )),
  ],
  [
    "uncommitted business write",
    (f) =>
      setTag(
        f.business("transaction-admit_agent"),
        "antnest.transaction.outcome",
        "rolled_back",
      ),
  ],
  ["wrong business Agent", (f) => (f.expected.agentId = "other")],
])
  test(`cache admission cannot replace ${name}`, async (t) => {
    const f = collection(t);
    await collect(f);
    change(f);
    await assert.rejects(collect(f));
  });

test("Foundation entrypoint retains the actual operation and source evidence", async (t) => {
  assert.equal(typeof admission.collectLifecycleAdmissionTrace, "function");
  const f = collection(t);
  f.inspect = () => assert.fail("caller cannot replace the business gate");
  const result = await collectFoundationLifecycle(
    { jaeger: "http://jaeger", evidence: f.directory },
    {
      kind: "create",
      traceID: f.expected.traceID,
      requestID: f.expected.requestId,
      agentID: f.expected.agentId,
    },
    ["PRIVATE"],
    undefined,
    f,
  );
  assert.equal(result.kind, "create");
  assert.equal(result.gateway_resolution.source, "shared");
});

test("Foundation readonly replay entrypoint retains SQL gates and Resolve sources", async (t) => {
  assert.equal(typeof admission.collectLifecycleAdmissionTrace, "function");
  const f = collection(t, true);
  f.inspect = () => assert.fail("caller cannot replace the replay gate");
  const config = { jaeger: "http://jaeger", evidence: f.directory };
  const result = await collectReadonlyCreateReplay(
    config,
    f.expected,
    ["PRIVATE"],
    undefined,
    f,
  );
  assert.equal(result.readonly_transaction, true);
  assert.equal(result.gateway_resolution.source, "shared");
  setTag(f.business("begin"), "db.query.text", "begin");
  await assert.rejects(
    collectReadonlyCreateReplay(config, f.expected, ["PRIVATE"], undefined, f),
    /read only/u,
  );
});

test("late source warnings restart Lifecycle full-closure convergence", async (t) => {
  const f = collection(t);
  const request = f.request;
  f.request = async (url, options) => {
    if (
      url.endsWith(triggerID) &&
      f.queries.filter((id) => id === triggerID).length === 1
    )
      f.traces.get(triggerID).warnings = ["late source warning"];
    return request(url, options);
  };
  const result = await collect(f);
  assert.equal(result.strict_trace, "failed");
  assert(result.warnings.includes("late source warning"));
  assert.equal(f.queries.filter((id) => id === f.trace.traceID).length, 4);
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.directory, `${triggerID}.json`), "utf8"))
      .warnings,
    ["late source warning"],
  );
});

test("Foundation cancellation joins the active Jaeger request", async (t) => {
  const f = collection(t);
  const abort = new AbortController();
  const entered = Promise.withResolvers();
  let joined = false;
  const reason = new Error("cancel Lifecycle collection");
  f.request = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        async () => {
          await Promise.resolve();
          joined = true;
          reject(signal.reason);
        },
        { once: true },
      );
      entered.resolve();
    });
  const pending = collectFoundationLifecycle(
    { jaeger: "http://jaeger", evidence: f.directory },
    {
      kind: "create",
      traceID: f.expected.traceID,
      requestID: f.expected.requestId,
      agentID: f.expected.agentId,
    },
    [],
    abort.signal,
    f,
  );
  await entered.promise;
  abort.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(joined, true);
});

test("Lifecycle requires an owning inspector instead of cache-only success", async (t) => {
  const f = collection(t);
  delete f.inspect;
  await assert.rejects(collect(f), /owning Lifecycle inspector/u);
});

test("shared source errors cannot enter the narrow restart diagnostic waivers", () => {
  const fenced = {
    kind: "rebuild",
    fenced_restart_cancellation: true,
    strict_trace: "failed",
    restart_error_spans: 2,
    platform_probe_errors: 0,
    warnings: [clockWarning],
  };
  assert.equal(admission.reviewedFencedRestartOnly([fenced]), true);
  assert.equal(
    admission.reviewedFencedRestartOnly([
      { ...fenced, resolve_source_error_spans: 1 },
    ]),
    false,
  );
  const graceful = {
    kind: "rebuild",
    topology: "passed",
    strict_trace: "failed",
    restart_error_spans: 3,
    platform_probe_errors: 0,
    warnings: [],
    workflow_spans: [
      { end_reason: "worker_shutdown" },
      { end_reason: "workflow_return" },
    ],
  };
  assert.equal(foundationAcceptedTraceExitCode([graceful]), 0);
  assert.equal(
    foundationAcceptedTraceExitCode([
      { ...graceful, resolve_source_error_spans: 1 },
    ]),
    2,
  );
});

test("clock-only acceptance cannot hide raw current errors classified by another business gate", () => {
  const result = {
    strict_trace: "failed",
    warning_count: 1,
    warnings: [clockWarning],
    error_spans: 1,
    platform_probe_errors: 0,
    restart_error_spans: 0,
    resolve_source_error_spans: 0,
  };
  assert.equal(admission.clockWarningsOnly([result]), false);
  assert.equal(
    acceptedClockOnlyRestore([{ ...result, topology: "passed" }]),
    false,
  );
});

test("fenced restart exception cannot hide additional current errors", () => {
  const result = {
    kind: "rebuild",
    fenced_restart_cancellation: true,
    strict_trace: "failed",
    restart_error_spans: 2,
    error_spans: 2,
    platform_probe_errors: 0,
    warnings: [],
    resolve_source_error_spans: 0,
  };
  assert.equal(admission.reviewedFencedRestartOnly([result]), true);
  assert.equal(
    admission.reviewedFencedRestartOnly([{ ...result, error_spans: 3 }]),
    false,
  );
});

test("graceful restart exception cannot hide additional current errors", () => {
  const result = {
    kind: "rebuild",
    topology: "passed",
    strict_trace: "failed",
    restart_error_spans: 3,
    error_spans: 3,
    platform_probe_errors: 0,
    warnings: [],
    workflow_spans: [
      { end_reason: "worker_shutdown" },
      { end_reason: "workflow_return" },
    ],
    resolve_source_error_spans: 0,
  };
  assert.equal(foundationAcceptedTraceExitCode([result]), 0);
  assert.equal(
    foundationAcceptedTraceExitCode([{ ...result, error_spans: 4 }]),
    2,
  );
});
