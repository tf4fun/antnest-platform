import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as admission from "./foundation-trace.mjs";
import { crashResolutionFixture } from "./crash-resolution-fixtures.mjs";
import {
  sourceID,
  triggerID,
  resolvePrefix as prefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";

const inspect = (f) => {
  assert.equal(typeof admission.inspectCrashAdmissionTrace, "function");
  return admission.inspectCrashAdmissionTrace(
    f.trace,
    f.expected,
    ["PRIVATE"],
    f,
  );
};
for (const phase of ["before-create", "after-start"])
  for (const source of ["rpc", "cache", "shared"])
    test(`${phase} recovery proves ${source} Console admission without altering raw crash evidence`, () => {
      const f = crashResolutionFixture(phase, source);
      const raw = JSON.stringify([...f.traces.values()]);
      const result = inspect(f);
      assert.equal(result.gateway_resolution.source, source);
      assert.equal(result.gateway_resolution.profile, "console");
      assert.equal(result.topology_scope, "completed_recovery");
      assert.equal(result.attempts, 2);
      assert.equal(result.strict_trace, "failed");
      assert.equal(result.error_spans, phase === "before-create" ? 2 : 3);
      assert.equal(result.crash_diagnostics.missing_parents.length, 1);
      assert(
        result.crash_diagnostics.excluded_span_ids.includes(
          f.business("orphan").spanID,
        ),
      );
      assert.equal(JSON.stringify([...f.traces.values()]), raw);
    });

for (const [name, change] of [
  [
    "missing decision",
    (f) => f.trace.spans.splice(f.trace.spans.indexOf(f.decision), 1),
  ],
  ["wrong profile", (f) => setTag(f.decision, prefix + "profile", "workspace")],
  ["expired hit", (f) => setTag(f.decision, prefix + "snapshot_age_ms", 10000)],
  ["late admission", (f) => (f.decision.duration = 50000)],
  [
    "Gateway missing parent",
    (f) => (f.decision.references[0].spanID = "missing"),
  ],
  [
    "late Gateway forwarding",
    (f) => (f.upstream.references[0].spanID = f.decision.spanID),
  ],
  [
    "extra decision hidden under failed attempt",
    (f) => {
      const duplicate = structuredClone(f.decision);
      duplicate.spanID = "hidden-decision";
      duplicate.references[0].spanID = f.business("failed-attempt").spanID;
      f.trace.spans.push(duplicate);
    },
  ],
  [
    "unknown Resolve data in excluded span",
    (f) => setTag(f.business("orphan"), prefix + "secret", "hidden"),
  ],
  [
    "private data in excluded span",
    (f) => (f.business("orphan").private = "PRIVATE"),
  ],
])
  test(`crash admission rejects ${name}`, () => {
    const f = crashResolutionFixture();
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });

for (const [name, change] of [
  ["unarchived source", (f) => f.archivedTraceIDs.delete(sourceID)],
  ["absent owning SQL", (f) => f.origin.trace.spans.pop()],
  [
    "failed owning SQL",
    (f) => setTag(f.origin.trace.spans.at(-1), "error", true),
  ],
  [
    "source missing parent",
    (f) => (f.origin.trace.spans.at(-1).references[0].spanID = "missing"),
  ],
  ["wrong exact link", (f) => (f.decision.references.at(-1).spanID = "sql")],
  ["private trigger", (f) => (f.traces.get(triggerID).private = "PRIVATE")],
])
  test(`recovery projection cannot excuse ${name}`, () => {
    const f = crashResolutionFixture("after-start", "shared");
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });

test("raw current identity cannot be replaced by a different collection snapshot", () => {
  const f = crashResolutionFixture("before-create", "shared");
  f.traces.set(f.trace.traceID, structuredClone(f.trace));
  assert.throws(() => inspect(f), /snapshot/);
});
test("source diagnostics stay outside the crash's excluded spans and errors", () => {
  const f = crashResolutionFixture("after-start", "shared");
  const trigger = f.traces.get(triggerID);
  setTag(trigger.spans[0], "error", true);
  trigger.spans[0].warnings = ["source warning"];
  f.business("orphan").warnings = ["crashed process warning"];
  const result = inspect(f);
  assert.equal(result.error_spans, 4);
  assert.equal(result.resolve_source_error_spans, 1);
  assert.equal(result.crash_diagnostics.error_spans.length, 3);
  assert.equal(result.warning_count, 2);
  assert.equal(result.crash_diagnostics.warnings, 1);
  assert.equal(result.strict_trace, "failed");
});

function collection(t, phase = "before-create", source = "shared") {
  const f = crashResolutionFixture(phase, source);
  f.directory = mkdtempSync(join(temporaryStorageRoot(), "crash-resolution-"));
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  f.queries = [];
  f.request = async (url) => {
    const id = new URL(url).pathname.split("/").at(-1);
    f.queries.push(id);
    return Response.json({ data: [f.traces.get(id)] });
  };
  f.wait = async () => {};
  f.attempts = 5;
  return f;
}
const collect = (f) => {
  assert.equal(typeof admission.collectCrashAdmissionTrace, "function");
  return admission.collectCrashAdmissionTrace(
    "http://jaeger",
    f.expected,
    ["PRIVATE"],
    f,
  );
};
for (const phase of ["before-create", "after-start"])
  for (const source of ["rpc", "cache", "shared"])
    test(`${phase} ${source} collection converges while preserving the intentional raw orphan`, async (t) => {
      const f = collection(t, phase, source);
      const result = await collect(f);
      assert.equal(result.strict_trace, "failed");
      assert.equal(result.gateway_resolution.source, source);
      assert.equal(result.crash_diagnostics.missing_parents.length, 1);
      for (const [id, trace] of f.traces) {
        assert.equal(f.queries.filter((query) => query === id).length, 3);
        assert.deepEqual(
          JSON.parse(readFileSync(join(f.directory, id + ".json"))),
          JSON.parse(JSON.stringify(trace)),
        );
      }
    });

for (const target of ["current", "source"])
  test(`late ${target} diagnostics with unchanged span IDs reset crash closure convergence`, async (t) => {
    const f = collection(t);
    const request = f.request;
    const id = target === "current" ? f.trace.traceID : sourceID;
    let reads = 0;
    f.request = async (url) => {
      if (url.endsWith(id) && ++reads === 2)
        f.traces.get(id).spans.at(-1).warnings = ["late warning"];
      return request(url);
    };
    const result = await collect(f);
    assert.equal(reads, 4);
    assert.equal(result.warning_count, 1);
    assert.equal(result.strict_trace, "failed");
  });

test("a failed linked source leaves the full current and source snapshots archived", async (t) => {
  const f = collection(t);
  setTag(f.origin.trace.spans.at(-1), "error", true);
  await assert.rejects(collect(f), /Resolve RPC or SQL/);
  for (const [id, trace] of f.traces)
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.directory, id + ".json"))),
      JSON.parse(JSON.stringify(trace)),
    );
});
test("failed recovery publication still preserves its raw Resolve source closure", async (t) => {
  const f = collection(t, "after-start");
  setTag(f.business("sql-lifecycle.publish"), "db.operation.name", "SELECT");
  await assert.rejects(collect(f), /committed driver write missing/);
  for (const [id, trace] of f.traces)
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.directory, id + ".json"))),
      JSON.parse(JSON.stringify(trace)),
    );
});
test("crash collector cannot substitute a passing inspector or hide source ancestry", async (t) => {
  const f = collection(t);
  f.inspect = () => ({ strict_trace: "passed" });
  f.origin.trace.spans.at(-1).references[0].spanID = "missing";
  await assert.rejects(collect(f), /missing synchronous parent/);
});
for (const [name, response] of [
  [
    "backend error",
    () => Response.json({ data: [], errors: ["backend failed"] }),
  ],
  ["duplicate response", (f) => Response.json({ data: [f.trace, f.trace] })],
  [
    "wrong trace",
    (f) => Response.json({ data: [{ ...f.trace, traceID: "d".repeat(32) }] }),
  ],
  ["invalid JSON", () => new Response("{")],
  ["HTTP error", () => new Response("unavailable", { status: 503 })],
])
  test(`crash collector rejects ${name}`, async (t) => {
    const f = collection(t);
    f.request = async () => response(f);
    await assert.rejects(collect(f));
  });

const entrypoint = (f, signal) => {
  assert.equal(typeof admission.collectCrashAdmissionTrace, "function");
  return admission.collectFoundationLifecycle(
    { jaeger: "http://jaeger", evidence: f.directory },
    {
      kind: "rebuild",
      requestID: f.expected.requestId,
      agentID: f.expected.agentId,
      traceID: f.trace.traceID,
      crashRecovery: f.expected.crashRecovery,
    },
    ["PRIVATE"],
    signal,
    f,
  );
};
test("Foundation crash entrypoint selects the owning collector and archives actual sources", async (t) => {
  const f = collection(t, "after-start");
  f.inspect = () => assert.fail("cannot replace owning crash gate");
  const result = await entrypoint(f);
  assert.equal(result.gateway_resolution.source, "shared");
  for (const [id, trace] of f.traces)
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.directory, "traces", id + ".json"))),
      JSON.parse(JSON.stringify(trace)),
    );
});
for (const stage of ["request", "body"])
  test(`Foundation crash cancellation joins active ${stage} with the actual run signal`, async (t) => {
    const f = collection(t),
      abort = new AbortController(),
      decoy = new AbortController();
    let entered;
    const active = new Promise((resolve) => (entered = resolve));
    let joined = false,
      receivedReason;
    const reason = new Error("cancel crash collection");
    f.signal = decoy.signal;
    f.request = async (_url, options) => {
      const blocked = () =>
        new Promise((_, reject) => {
          options.signal.addEventListener(
            "abort",
            () =>
              queueMicrotask(() => {
                joined = true;
                receivedReason = options.signal.reason;
                reject(receivedReason);
              }),
            { once: true },
          );
          entered();
        });
      return stage === "request" ? blocked() : { status: 200, text: blocked };
    };
    const pending = entrypoint(f, abort.signal);
    await active;
    abort.abort(reason);
    decoy.abort(new Error("unrelated options signal"));
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(joined, true);
    assert.equal(receivedReason, reason);
  });
