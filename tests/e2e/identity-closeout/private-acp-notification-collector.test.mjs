import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { notificationTraceFixture } from "./private-acp-notification.fixture.mjs";
import * as implementation from "./private-acp-trace.mjs";

const parse = (path) => JSON.parse(readFileSync(path, "utf8"));
function collector() {
  assert.equal(
    typeof implementation.collectPrivateACPNotificationTrace,
    "function",
  );
  return implementation.collectPrivateACPNotificationTrace;
}
async function fixture(t, version = 1, mutate = () => {}) {
  const f = await notificationTraceFixture(t, version);
  const directory = mkdtempSync(
    join(tmpdir(), "antnest-notification-collector-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let attempt = 0,
    flushed = false;
  const calls = [];
  const options = {
    directory,
    attempts: 6,
    wait: async () => {},
    flush: async () => {
      flushed = true;
    },
    inspect: async (trace, expected) => {
      assert.equal(expected.method, "session/cancel");
      assert.equal(expected.requestId, undefined);
      return { trace_id: trace.traceID, strict_trace: "passed" };
    },
    request: async (address, options) => {
      assert(flushed);
      assert(options.signal instanceof AbortSignal);
      const url = new URL(address);
      calls.push(url);
      const connectionURL = `/api/traces/${f.connection.traceID}`;
      if (url.pathname === connectionURL) attempt++;
      const state = {
        connection: structuredClone(f.connection),
        traces: [structuredClone(f.trace)],
      };
      mutate(state, attempt);
      if (url.pathname === connectionURL)
        return Response.json({ data: [state.connection] });
      if (url.pathname === "/api/v3/trace-summaries")
        return Response.json({
          summaries: state.traces.map((trace) => ({ traceId: trace.traceID })),
          ...(state.page ? { nextPageToken: "next" } : {}),
        });
      const trace = state.traces.find(
        (item) => url.pathname === `/api/traces/${item.traceID}`,
      );
      assert(trace);
      return Response.json({ data: [trace] });
    },
  };
  return {
    ...f,
    directory,
    options,
    calls,
    get attempts() {
      return attempt;
    },
  };
}
function failedArchive(f) {
  const entries = readdirSync(f.directory);
  assert.equal(entries.length, 1);
  const directory = join(f.directory, entries[0]);
  const manifest = parse(join(directory, "manifest.json"));
  assert.equal(manifest.status, "failed");
  return { directory, manifest };
}

for (const version of [1, 2])
  test(`v${version}: notification collector preserves three complete stable original sources`, async (t) => {
    const collect = collector();
    const f = await fixture(t, version);
    let hooks = 0;
    f.options.inspectCompleteSources = ({ expected, sources, reports }) => {
      hooks++;
      assert(Object.isFrozen(expected));
      assert(Object.isFrozen(sources[0].spans[0]));
      assert.equal(expected.requestId, undefined);
      assert.equal(reports[0].trace_id, f.trace.traceID);
    };
    const result = await collect("http://jaeger", f.receipt, f.options);
    assert.equal(f.attempts, 3);
    assert.equal(hooks, 3);
    assert.equal(result.trace_id, f.trace.traceID);
    assert.equal(result.notification_index, f.receipt.index);
    assert.equal(result.strict_trace, "passed");
    const archive = result.evidence_directory;
    const manifest = parse(join(archive, "manifest.json"));
    assert.equal(manifest.notification_trace_id, f.trace.traceID);
    assert.equal(manifest.request_trace_id, undefined);
    assert.deepEqual(parse(join(archive, "notification.json")), f.trace);
    assert.deepEqual(parse(join(archive, "connection.json")), f.connection);
    assert.equal(manifest.queries.length, 9);
    assert.equal(result.complete_source_receipt.stable_samples, 3);
    assert.equal(result.complete_source_receipt.samples.length, 3);
    assert.equal(statSync(archive).mode & 0o777, 0o700);
    for (const query of manifest.queries) {
      const path = join(archive, query.file),
        bytes = readFileSync(path);
      assert.equal(bytes.length, query.bytes);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        query.sha256,
      );
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    const search = f.calls.find(
      (url) => url.pathname === "/api/v3/trace-summaries",
    );
    assert.deepEqual(JSON.parse(search.searchParams.get("query.attributes")), {
      "rpc.method": "session/cancel",
      "antnest.agent.id": f.receipt.agentId,
      "antnest.session.id": f.receipt.sessionId,
      "antnest.protocol.version": `v${version}`,
    });
  });

test("notification convergence includes changed warnings and retains raw ERROR", async (t) => {
  const collect = collector();
  const f = await fixture(t, 1, (state, attempt) => {
    if (attempt > 1)
      state.connection.spans[1].warnings = ["late original warning"];
    state.traces[0].spans[0].tags.push({ key: "otel.status_code", value: 2 });
  });
  const result = await collect("http://jaeger", f.receipt, f.options);
  assert.equal(f.attempts, 4);
  assert.equal(result.warning_count, 1);
  assert.equal(result.error_spans, 1);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.inspector_diagnostics.strict_trace, "passed");
  assert.deepEqual(
    result.complete_source_receipt.samples.map((sample) => sample.attempt),
    [2, 3, 4],
  );
});

for (const [label, mutate] of [
  [
    "duplicate candidates",
    (state) => state.traces.push(structuredClone(state.traces[0])),
  ],
  [
    "unread page",
    (state) => {
      state.page = true;
    },
  ],
  [
    "SERVER masquerading as notification",
    (state) => {
      state.traces[0].spans[0].tags.find(
        ({ key }) => key === "span.kind",
      ).value = "server";
    },
  ],
  [
    "wrong Link",
    (state) => {
      state.traces[0].spans[0].references[0].spanID = "9".repeat(16);
    },
  ],
])
  test(`notification collector rejects ${label} and retains failed raw`, async (t) => {
    const collect = collector();
    const f = await fixture(t, 1, mutate);
    f.options.attempts = 3;
    await assert.rejects(collect("http://jaeger", f.receipt, f.options));
    const { directory, manifest } = failedArchive(f);
    assert.equal(manifest.attempts.length, 3);
    assert(manifest.attempts.every((attempt) => attempt.status === "failed"));
    assert(manifest.queries.length >= 6);
    for (const query of manifest.queries)
      assert(readFileSync(join(directory, query.file)).length > 0);
  });

test("intermediate 404 resets stability while preserving the exact failed response", async (t) => {
  const collect = collector(),
    f = await fixture(t);
  const request = f.options.request;
  let connectionCalls = 0;
  f.options.request = async (address, options) => {
    if (
      new URL(address).pathname === `/api/traces/${f.connection.traceID}` &&
      ++connectionCalls === 2
    )
      return new Response("original missing trace", { status: 404 });
    return request(address, options);
  };
  const result = await collect("http://jaeger", f.receipt, f.options);
  const manifest = parse(join(result.evidence_directory, "manifest.json"));
  assert.equal(connectionCalls, 5);
  assert.deepEqual(
    result.complete_source_receipt.samples.map((sample) => sample.attempt),
    [3, 4, 5],
  );
  const failed = manifest.queries.find((query) => query.status === 404);
  assert.equal(
    readFileSync(join(result.evidence_directory, failed.file), "utf8"),
    "original missing trace",
  );
});

test("interrupted response retains partial original bytes and ends collection", async (t) => {
  const collect = collector(),
    f = await fixture(t),
    abort = new AbortController();
  const partial = Buffer.from('{"data":["original partial');
  let cancelled = false,
    sent = false;
  f.options.signal = abort.signal;
  f.options.request = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (sent) {
            abort.abort(new Error("fixture abort"));
            return;
          }
          sent = true;
          controller.enqueue(partial);
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  await assert.rejects(
    collect("http://jaeger", f.receipt, f.options),
    /fixture abort/,
  );
  assert(cancelled);
  const { directory, manifest } = failedArchive(f);
  assert.equal(manifest.queries.length, 1);
  assert.equal(manifest.queries[0].body_complete, false);
  assert.deepEqual(
    readFileSync(join(directory, manifest.queries[0].file)),
    partial,
  );
});

test("complete source refusal is fatal and later clean samples cannot mask it", async (t) => {
  const collect = collector(),
    f = await fixture(t, 1, (state, attempt) => {
      if (attempt === 2)
        state.connection.spans[1].warnings = ["PRIVATE ORIGINAL WARNING"];
    });
  f.options.inspectCompleteSources = ({ sources }) => {
    assert(
      !sources.some((source) =>
        source.spans.some((span) => span.warnings?.length),
      ),
      "PRIVATE POLICY REJECTION",
    );
  };
  await assert.rejects(
    collect("http://jaeger", f.receipt, f.options),
    (error) => !error.message.includes("PRIVATE"),
  );
  assert.equal(f.attempts, 2);
  const { directory } = failedArchive(f);
  assert.match(
    readFileSync(
      join(directory, "complete-source-failure.private.txt"),
      "utf8",
    ),
    /PRIVATE POLICY REJECTION/,
  );
});

for (const delayed of [false, true])
  test(`owning inspector cannot mutate source evidence, delayed=${delayed}`, async (t) => {
    const collect = collector(),
      f = await fixture(t);
    let retained;
    f.options.inspect = async (trace) => {
      retained = trace;
      if (!delayed) trace.spans[0].operationName = "mutated";
      return { trace_id: trace.traceID };
    };
    if (delayed)
      f.options.inspectCompleteSources = async () => {
        await Promise.resolve();
        retained.spans[0].operationName = "mutated";
      };
    await assert.rejects(collect("http://jaeger", f.receipt, f.options));
    assert.equal(f.attempts, 1);
    const { directory } = failedArchive(f);
    assert(
      readFileSync(join(directory, "complete-source-failure.private.txt"))
        .length > 0,
    );
  });

test("retained owning reports cannot change a returned checked result", async (t) => {
  const collect = collector(),
    f = await fixture(t),
    reports = [];
  f.options.inspect = async (trace) => {
    const result = {
      trace_id: trace.traceID,
      strict_trace: "passed",
      owner: { checked: true },
    };
    reports.push(result);
    return result;
  };
  const result = await collect("http://jaeger", f.receipt, f.options);
  for (const report of reports) report.owner.checked = false;
  assert.equal(result.owner.checked, true);
});

test("receipt invalidation during owning inspection prevents collection", async (t) => {
  const collect = collector(),
    f = await fixture(t);
  f.options.inspect = async (trace) => {
    await assert.rejects(f.client.notify("cancel", { sessionId: "late" }));
    return { trace_id: trace.traceID };
  };
  await assert.rejects(collect("http://jaeger", f.receipt, f.options));
  assert.equal(f.attempts, 1);
  failedArchive(f);
});

test("notification collection rejects forged receipts before queries", async (t) => {
  const collect = collector(),
    f = await fixture(t);
  await assert.rejects(collect("http://jaeger", { ...f.receipt }, f.options));
  assert.equal(f.calls.length, 0);
});

test("notification collection requires a report for the selected original Trace", async (t) => {
  const collect = collector(),
    f = await fixture(t);
  f.options.inspect = async () => ({ trace_id: "9".repeat(32) });
  f.options.attempts = 3;
  await assert.rejects(collect("http://jaeger", f.receipt, f.options));
  failedArchive(f);
});
