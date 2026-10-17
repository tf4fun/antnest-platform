import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { collectBridgeSessionOwnerEvidence } from "./bridge-session-owner-collect.mjs";
import { sessionOwnerFixture } from "./bridge-session-owner-fixtures.mjs";
import { moveSessionTrace } from "./bridge-session-cause-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

function fixture(t) {
  const f = sessionOwnerFixture();
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-session-owner-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  let round = 1;
  const archive = () =>
    join(
      directory,
      readdirSync(directory).find((name) => name.startsWith("session-owner-")),
    );
  const manifest = () =>
    JSON.parse(readFileSync(join(archive(), "manifest.json")));
  const hooks = {};
  const request = async (input, options) => {
    const url = new URL(input);
    const operation = url.searchParams.get("query.operationName");
    const call = { round, url: String(url), operation };
    calls.push(call);
    const changed = await hooks.response?.(call, options);
    if (changed) return changed;
    if (url.pathname === "/api/v3/trace-summaries") {
      const selected = [...f.collection.traces.values()].filter((trace) =>
        trace.spans.some((span) => span.operationName === operation),
      );
      return Response.json({
        summaries: selected.map((trace) => ({ traceId: trace.traceID })),
      });
    }
    const id = url.pathname.split("/").at(-1);
    const trace = f.collection.traces.get(id);
    return Response.json({ data: trace ? [trace] : [] });
  };
  const options = {
    directory,
    request,
    attempts: 6,
    wait: async () => {
      round++;
      await hooks.round?.(round);
    },
  };
  return {
    ...f,
    directory,
    calls,
    hooks,
    options,
    archive,
    manifest,
    collect: () =>
      collectBridgeSessionOwnerEvidence(
        "http://jaeger.invalid",
        f.context,
        [],
        options,
      ),
  };
}

test("Session owner collector archives the complete shared raw inventory before verifying causes", async (t) => {
  const f = fixture(t);
  const before = JSON.stringify([...f.collection.traces.values()]);
  const result = await f.collect();
  assert.equal(result.traces.length, 2);
  assert(
    result.traces.every(
      (row) => row.authorizationCauseVerified && row.strict_trace === "failed",
    ),
  );
  assert.equal(result.ownerClose.owners[0].observations.length, 2);
  assert.equal(result.ownerClose.classified_errors.length, 3);
  assert.deepEqual(
    new Set(result.rawTraceIDs),
    new Set(f.collection.traces.keys()),
  );
  assert.equal(result.diagnostics.error_spans, result.traces[0].error_spans);
  assert.equal(result.diagnostics.strict_trace, "failed");
  assert.equal(JSON.stringify([...f.collection.traces.values()]), before);
  const manifest = f.manifest();
  assert.equal(manifest.status, "verified");
  assert.equal(manifest.attempts.length, 3);
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.archive(), "observations.json"))),
    f.context,
  );
  for (const receipt of manifest.attempts)
    for (const [id, trace] of f.collection.traces)
      assert.deepEqual(
        JSON.parse(
          readFileSync(join(f.archive(), receipt.directory, id + ".json")),
        ),
        trace,
      );
  for (const query of manifest.queries) {
    assert.equal(query.body_complete, true);
    const path = join(f.archive(), query.file);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      query.sha256,
    );
  }
  const searches = f.calls.filter((call) => call.operation);
  assert.equal(searches.length, 9);
  assert.equal(
    new Set(
      searches.map((call) =>
        new URL(call.url).searchParams.get("query.startTimeMax"),
      ),
    ).size,
    1,
  );
});

for (const change of ["warning", "resource"])
  test(`same Trace IDs with a late ${change} restart complete snapshot convergence`, async (t) => {
    const f = fixture(t);
    f.hooks.round = (round) => {
      if (round === 3) {
        if (change === "warning")
          f.second.trace.warnings = ["late exporter warning"];
        else setTag(f.second.trace.processes.ui, "fixture.export.revision", 2);
      }
    };
    const result = await f.collect();
    assert.equal(f.manifest().attempts.length, 5);
    if (change === "warning")
      assert(result.diagnostics.warnings.includes("late exporter warning"));
  });

test("late duplicate DELETE cannot be hidden behind the first two complete snapshots", async (t) => {
  const f = fixture(t);
  f.hooks.round = (round) => {
    if (round === 3)
      f.closing.spans.push({
        ...structuredClone(f.deletion),
        spanID: "0".repeat(16),
      });
  };
  await assert.rejects(f.collect(), /Session owner evidence/u);
  assert.equal(f.manifest().attempts.length, 5);
  const last = f.manifest().attempts.at(-1);
  const raw = JSON.parse(
    readFileSync(
      join(f.archive(), last.directory, f.closing.traceID + ".json"),
    ),
  );
  assert.equal(
    raw.spans.filter((span) => span.operationName === "HTTP DELETE /v1/acp")
      .length,
    2,
  );
  assert.equal(f.manifest().status, "failed");
});

test("one-sided cleanup search failure preserves the other search and every original cause", async (t) => {
  const f = fixture(t);
  f.hooks.response = (call) =>
    call.operation === "HTTP DELETE /v1/acp"
      ? new Response("unavailable", { status: 503 })
      : undefined;
  await assert.rejects(f.collect(), /Session owner evidence/u);
  const manifest = f.manifest();
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.attempts.length, 1);
  assert(f.calls.some((call) => call.operation === "HTTP GET /status"));
  for (const expected of f.context.closures)
    for (const id of [
      expected.traceID,
      expected.denial.traceID,
      expected.cause.traceID,
    ])
      assert(
        f.calls.some(
          (call) => new URL(call.url).pathname === `/api/traces/${id}`,
        ),
      );
  const failed = manifest.queries.find((query) => query.status === 503);
  assert.equal(
    readFileSync(join(f.archive(), failed.file), "utf8"),
    "unavailable",
  );
});

test("missing independent health evidence cannot be supplied by an owner summary", async (t) => {
  const f = fixture(t);
  f.hooks.response = (call) =>
    call.operation === "HTTP GET /status"
      ? Response.json({ summaries: [] })
      : undefined;
  await assert.rejects(f.collect(), /Session owner evidence/u);
  assert.equal(f.manifest().status, "failed");
  assert.equal(f.manifest().attempts.length, 3);
});

test("first cause inspection failure leaves every original Session raw trace archived", async (t) => {
  const f = fixture(t);
  setTag(f.first.upstream, "http.transport.error.type", "unrelated-failure");
  await assert.rejects(f.collect(), /Session owner evidence/u);
  const manifest = f.manifest();
  assert.equal(manifest.attempts.length, 3);
  for (const [id, trace] of f.collection.traces)
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(f.archive(), manifest.attempts.at(-1).directory, id + ".json"),
        ),
      ),
      trace,
    );
});

test("unobserved initialization Link is archived but cannot establish another authenticated owner", async (t) => {
  const f = fixture(t);
  const foreign = structuredClone(f.first.trace);
  moveSessionTrace(foreign, "f".repeat(32), f.first.root.startTime);
  f.collection.traces.set(foreign.traceID, foreign);
  f.close.references[0].traceID = foreign.traceID;
  await assert.rejects(f.collect(), /Session owner evidence/u);
  const last = f.manifest().attempts.at(-1);
  assert(
    existsSync(join(f.archive(), last.directory, foreign.traceID + ".json")),
  );
  assert(
    f.calls.some(
      (call) => new URL(call.url).pathname === `/api/traces/${foreign.traceID}`,
    ),
  );
});

test("raw archive write failure cannot become an in-memory archived receipt", async (t) => {
  const f = fixture(t);
  let planted = false;
  f.hooks.response = () => {
    if (!planted) {
      planted = true;
      mkdirSync(
        join(f.archive(), "round-001", f.first.trace.traceID + ".json"),
        { recursive: true },
      );
    }
  };
  await assert.rejects(f.collect(), /Session owner evidence/u);
  assert.equal(f.manifest().status, "failed");
  assert.equal(f.manifest().attempts.length, 1);
});

test("cancellation preserves an incomplete body and joins response cancellation", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  f.options.signal = controller.signal;
  let sent = false,
    joined = false;
  f.hooks.response = () =>
    new Response(
      new ReadableStream({
        pull(stream) {
          if (!sent) {
            sent = true;
            stream.enqueue(new TextEncoder().encode('{"data":['));
            setImmediate(() => controller.abort());
          }
        },
        async cancel() {
          await delay(10);
          joined = true;
        },
      }),
    );
  await assert.rejects(f.collect());
  assert.equal(joined, true);
  const manifest = f.manifest();
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.queries.length, 1);
  assert.equal(manifest.queries[0].body_complete, false);
  assert.equal(
    readFileSync(join(f.archive(), manifest.queries[0].file), "utf8"),
    '{"data":[',
  );
});

test("cancellation while the final response settles cannot publish verified evidence", async (t) => {
  const acceptedAfterCancellation = [];
  for (let turns = 1; turns <= 16; turns++) {
    const f = fixture(t);
    const controller = new AbortController();
    f.options.signal = controller.signal;
    let statusAtCancellation;
    f.hooks.response = (call) => {
      if (
        call.round !== 3 ||
        new URL(call.url).pathname !== `/api/traces/${f.health.traceID}`
      )
        return;
      // Sweep cancellation across the real response/body/promise settlement
      // boundary. The public manifest distinguishes cancellation during work
      // from an ordinary cancellation after the collector already completed.
      let remaining = turns;
      const cancel = () => {
        if (--remaining > 0) queueMicrotask(cancel);
        else {
          statusAtCancellation = f.manifest().status;
          controller.abort();
        }
      };
      queueMicrotask(cancel);
      return Response.json({ data: [f.health] });
    };
    let passed = false;
    try {
      await f.collect();
      passed = true;
    } catch {}
    for (let settle = 0; !statusAtCancellation && settle < 32; settle++)
      await Promise.resolve();
    assert(
      statusAtCancellation,
      "final response cancellation was not exercised",
    );
    if (statusAtCancellation === "collecting") {
      if (passed) acceptedAfterCancellation.push(turns);
      else assert.equal(f.manifest().status, "failed");
    }
  }
  assert.deepEqual(acceptedAfterCancellation, []);
});
