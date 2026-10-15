import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { inspectPlanRequestTrace } from "../acp-plan/requests.mjs";
import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";

const url = new URL("./private-acp-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function collect(...args) {
  assert.equal(typeof implementation.collectPrivateACPTrace, "function");
  return implementation.collectPrivateACPTrace(...args);
}
function fixture(t, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-private-acp-trace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = privateBoundaryFixture();
  const expected = { ...f.expected };
  delete expected.connectionSpanID;
  delete expected.connectionTrace;
  let attempt = 0,
    flushed = false;
  const calls = [];
  const request = async (address, options) => {
    assert(flushed, "flush actual CLIENT export before querying");
    assert(options.signal instanceof AbortSignal);
    const url = new URL(address);
    calls.push(url);
    if (url.pathname === `/api/traces/${f.connectionTrace.traceID}`) attempt++;
    const state = {
      connection: structuredClone(f.connectionTrace),
      traces: [structuredClone(f.trace)],
    };
    mutate(state, attempt);
    if (url.pathname === `/api/traces/${f.connectionTrace.traceID}`)
      return Response.json({ data: [state.connection] });
    if (url.pathname === "/api/v3/trace-summaries")
      return Response.json({
        summaries: state.traces.map((trace) => ({ traceId: trace.traceID })),
        ...(state.page ? { nextPageToken: "next" } : {}),
      });
    const trace = state.traces.find(
      (item) => url.pathname === `/api/traces/${item.traceID}`,
    );
    assert(trace, "unexpected raw request");
    return Response.json({ data: [trace] });
  };
  const options = {
    directory,
    inspect: inspectPlanRequestTrace,
    request,
    flush: async () => {
      flushed = true;
    },
    wait: async () => {},
    attempts: 6,
  };
  return {
    ...f,
    expected,
    directory,
    options,
    calls,
    get attempts() {
      return attempt;
    },
  };
}
const parse = (path) => JSON.parse(readFileSync(path, "utf8"));

test("private collector observes the actual upgrade span and archives stable raw before admission", async (t) => {
  const f = fixture(t);
  const before = JSON.stringify([f.connectionTrace, f.trace]);
  const result = await collect("http://jaeger", f.expected, f.options);
  assert.equal(f.attempts, 3);
  assert.equal(result.connection_span_id, f.connectionTrace.spans[1].spanID);
  assert.equal(result.trace_id, f.trace.traceID);
  assert.equal(result.no_execution, true);
  assert.equal(result.strict_trace, "passed");
  const manifest = parse(join(result.evidence_directory, "manifest.json"));
  assert.equal(manifest.status, "collected");
  assert.equal(manifest.queries.length, 9);
  for (const query of manifest.queries) {
    const path = join(result.evidence_directory, query.file);
    assert.equal(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      query.sha256,
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.equal(statSync(result.evidence_directory).mode & 0o777, 0o700);
  assert.deepEqual(
    parse(join(result.evidence_directory, "connection.json")),
    f.connectionTrace,
  );
  assert.deepEqual(
    parse(join(result.evidence_directory, "request.json")),
    f.trace,
  );
  assert.equal(JSON.stringify([f.connectionTrace, f.trace]), before);
  const search = f.calls.find(
    (url) => url.pathname === "/api/v3/trace-summaries",
  );
  assert.deepEqual(JSON.parse(search.searchParams.get("query.attributes")), {
    "rpc.method": f.expected.method,
    "antnest.agent.id": f.expected.agentId,
    "antnest.request.id": f.expected.requestId,
    "antnest.protocol.version": "v1",
    "antnest.session.id": f.expected.sessionId,
  });
});

test("private collection convergence includes changed diagnostics with unchanged span IDs", async (t) => {
  const f = fixture(t, (state, attempt) => {
    if (attempt > 1)
      state.connection.spans[1].warnings = ["late upgrade warning"];
  });
  const result = await collect("http://jaeger", f.expected, f.options);
  assert.equal(f.attempts, 4);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.warning_count, 1);
  assert.deepEqual(result.warnings, ["late upgrade warning"]);
});

test("private collection keeps request numeric/error-event diagnostics visible to final admission", async (t) => {
  const f = fixture(t, (state) => {
    state.traces[0].spans[0].logs = [
      { fields: [{ key: "event", value: "exception" }] },
    ];
  });
  const result = await collect("http://jaeger", f.expected, f.options);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.error_spans, 1);
  assert.equal(result.inspector_diagnostics.strict_trace, "passed");
});

for (const warning of [false, true])
  test(`private collection preserves owned read cancellation without inventing an error, warning=${warning}`, async (t) => {
    const f = fixture(t, (state) => {
      if (warning) state.connection.spans[1].warnings = ["original warning"];
    });
    const request = f.trace.spans.find((span) => span.spanID === "request");
    request.duration = 100;
    addCompletedRead(f.trace, request, "http", f.expected.agentId, {
      preserveRequest: true,
      runtimeOutcome: "success",
      clientOutcome: "cancelled",
    });
    const original = structuredClone(f.trace);
    const owned = inspectPlanRequestTrace(f.trace, {
      ...f.expected,
      connectionTrace: f.connectionTrace,
      connectionSpanID: f.connectionTrace.spans[1].spanID,
    });
    assert.equal(owned.neutral_diagnostics.length, 1);
    const result = await collect("http://jaeger", f.expected, f.options);
    assert.equal(result.error_spans, 0);
    assert.equal(result.warning_count, warning ? 1 : 0);
    assert.equal(result.strict_trace, warning ? "failed" : "passed");
    assert.equal(result.neutral_diagnostics.length, 1);
    const raw = parse(join(result.evidence_directory, "request.json"));
    assert.deepEqual(raw, original);
    const cancelled = raw.spans.filter((span) =>
      span.tags.some(
        ({ key, value }) => key === "antnest.outcome" && value === "cancelled",
      ),
    );
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].logs[0].fields[0].value, "antnest.cancelled");
  });

for (const [label, mutate] of [
  ["missing CLIENT", (state) => state.connection.spans.shift()],
  ...[0, 1].map((index) => [
    `cancelled upgrade ${index === 0 ? "CLIENT" : "SERVER"}`,
    (state) =>
      state.connection.spans[index].tags.push({
        key: "antnest.outcome",
        value: "cancelled",
      }),
  ]),
  [
    "wrong upgrade parent",
    (state) => {
      state.connection.spans[1].references[0].spanID = "9".repeat(16);
    },
  ],
  [
    "failed upgrade source",
    (state) =>
      state.connection.spans[0].tags.push({
        key: "otel.status_code",
        value: 2,
      }),
  ],
  [
    "secret source",
    (state) =>
      state.connection.spans[0].tags.push({
        key: "private",
        value: "PRIVATE-COLLECTOR-CANARY",
      }),
  ],
  [
    "wrong request Link",
    (state) => {
      state.traces[0].spans[0].references[0].spanID = "9".repeat(16);
    },
  ],
  [
    "unread result page",
    (state) => {
      state.page = true;
    },
  ],
])
  test(`private collection retains raw failure evidence for ${label}`, async (t) => {
    const f = fixture(t, mutate);
    await assert.rejects(() =>
      collect("http://jaeger", f.expected, {
        ...f.options,
        secrets: ["PRIVATE-COLLECTOR-CANARY"],
        attempts: 3,
      }),
    );
    const archives = readdirSync(f.directory);
    assert.equal(archives.length, 1);
    const archive = join(f.directory, archives[0]);
    const manifest = parse(join(archive, "manifest.json"));
    assert.equal(manifest.status, "failed");
    assert(manifest.queries.length >= 1);
    assert(
      manifest.queries.every(
        (entry) => readFileSync(join(archive, entry.file)).length > 0,
      ),
    );
  });

test("private collector rejects missing/cached/aliased evidence before exporting or fetching", async (t) => {
  const f = fixture(t);
  const alias = join(f.directory, "alias");
  symlinkSync(join(f.directory, ".cache/missing"), alias);
  for (const directory of [
    undefined,
    "",
    join(f.directory, ".cache/evidence"),
    alias,
  ])
    await assert.rejects(() =>
      collect("http://jaeger", f.expected, {
        ...f.options,
        directory,
        flush: () => assert.fail("must validate durable output first"),
        request: () => assert.fail("must not fetch without durable output"),
      }),
    );
  assert.equal(f.calls.length, 0);
});

test("private collector preserves malformed backend response before rejecting it", async (t) => {
  const f = fixture(t);
  const body = "{malformed PRIVATE-RAW-CANARY";
  await assert.rejects(
    () =>
      collect("http://jaeger", f.expected, {
        ...f.options,
        attempts: 3,
        request: async () => new Response(body),
      }),
    (error) => !String(error).includes("PRIVATE-RAW-CANARY"),
  );
  const archive = join(f.directory, readdirSync(f.directory)[0]);
  const manifest = parse(join(archive, "manifest.json"));
  assert.equal(
    readFileSync(join(archive, manifest.queries[0].file), "utf8"),
    body,
  );
});

test("already aborted private collection makes no storage/export/network effects", async (t) => {
  const f = fixture(t),
    reason = new Error("fixture interruption");
  await assert.rejects(
    () =>
      collect("http://jaeger", f.expected, {
        ...f.options,
        signal: AbortSignal.abort(reason),
        flush: () => assert.fail("must not export after abort"),
      }),
    (error) => error === reason,
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

for (const interrupted of [false, true])
  test(`private collector retains bytes and status before body ${interrupted ? "abort" : "reset"}`, async (t) => {
    const f = fixture(t);
    const abort = new AbortController();
    const reason = new Error("fixture body interruption");
    const partial = '{"data":["PARTIAL-RAW-CANARY';
    await assert.rejects(
      () =>
        collect("http://jaeger", f.expected, {
          ...f.options,
          attempts: 3,
          signal: abort.signal,
          request: async () => {
            let chunks = 0;
            return new Response(
              new ReadableStream({
                pull(controller) {
                  if (chunks++ === 0) controller.enqueue(Buffer.from(partial));
                  else if (interrupted) abort.abort(reason);
                  else controller.error(new Error("fixture body reset"));
                },
              }),
              { status: 200 },
            );
          },
        }),
      (error) =>
        interrupted
          ? error === reason
          : !String(error).includes("PARTIAL-RAW-CANARY"),
    );
    const archive = join(f.directory, readdirSync(f.directory)[0]);
    const manifest = parse(join(archive, "manifest.json"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.queries.length, interrupted ? 1 : 3);
    for (const query of manifest.queries) {
      assert.equal(query.status, 200);
      assert.equal(query.body_complete, false);
      assert.equal(query.outcome, interrupted ? "aborted" : "failed");
      assert.equal(readFileSync(join(archive, query.file), "utf8"), partial);
      assert.equal(
        query.sha256,
        createHash("sha256").update(partial).digest("hex"),
      );
    }
  });
