import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as turn } from "node:timers/promises";
import {
  fixture,
  privateHTTPFixture,
  privateHTTPRejectionFixture,
} from "./trace-fixtures.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";
import { addRuntimeEventRepresentations } from "../observability/runtime-information-timing-fixture.mjs";
import { verdict } from "../../support/ci-shard.mjs";
import { inspectPrivateCommandTrace } from "./trace.mjs";

const url = new URL("./collector.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function collect(...args) {
  assert.equal(typeof implementation.collectPrivateCommandTrace, "function");
  return implementation.collectPrivateCommandTrace(...args);
}
async function collectConsumer(...args) {
  assert.equal(
    typeof implementation.collectPrivateACPConsumerTrace,
    "function",
  );
  return implementation.collectPrivateACPConsumerTrace(...args);
}
const consumerReasons = () =>
  new Set([
    "consumer-rejection",
    "private-http-sse-close",
    "completed-initialize-mcp-read-disconnect",
    "completed-runtime-tool-http-disconnect",
  ]);
function consumerInspector(trace, bound, secrets, requests) {
  const result = inspectPrivateCommandTrace(trace, bound, secrets, requests);
  return {
    ...result,
    consumer: "native-inputs",
    owned_error_spans: (result.owned_error_spans ?? []).map((claim) => ({
      ...claim,
      reason:
        claim.reason === "command-rejection"
          ? "consumer-rejection"
          : claim.reason,
    })),
  };
}
const parse = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tags = (values) =>
  Object.entries(values).map(([key, value]) => ({ key, value }));

function httpFixture(t, { rejection = false, mutate = () => {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-command-collector-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = rejection ? privateHTTPRejectionFixture() : privateHTTPFixture();
  const raw = new Map([[f.trace.traceID, f.trace]]);
  for (const receipt of f.expected.httpConnection.requests) {
    receipt.events = [
      { kind: "headers", monotonicMs: 2 },
      {
        kind: receipt.bodyOutcome === "cancelled" ? "cancel" : "eof",
        monotonicMs: 3,
      },
      { kind: "body_closed", monotonicMs: 4 },
    ];
    if (receipt.traceID === f.trace.traceID) continue;
    if (receipt.rpcMethod === "initialize") {
      const init = privateHTTPFixture("request", { method: "initialize" });
      init.trace.traceID = receipt.traceID;
      for (const span of init.trace.spans) {
        span.traceID = receipt.traceID;
        for (const ref of span.references) ref.traceID = receipt.traceID;
      }
      init.set(init.request, "antnest.request.id", String(receipt.requestID));
      raw.set(receipt.traceID, init.trace);
    } else {
      const client = {
        ...structuredClone(f.client),
        traceID: receipt.traceID,
        operationName: `HTTP ${receipt.method} agent-acp-workspace`,
        tags: tags({
          "span.kind": "client",
          "http.request.method": receipt.method,
          "http.response.status_code": receipt.status,
          "http.response.body.size": receipt.bytes,
          "antnest.outcome": receipt.bodyOutcome,
          "antnest.http.body.outcome": receipt.bodyOutcome,
        }),
      };
      const receiver = {
        ...structuredClone(f.receiver),
        traceID: receipt.traceID,
        operationName: `HTTP ${receipt.method} /v1/acp`,
        references: [
          {
            refType: "CHILD_OF",
            traceID: receipt.traceID,
            spanID: client.spanID,
          },
        ],
        tags: tags({
          "span.kind": "server",
          "http.request.method": receipt.method,
          "http.route": "/v1/acp",
          "antnest.listener": "workspace",
          "http.response.status_code": receipt.status,
          ...(receipt.method === "GET"
            ? {
                "antnest.outcome": "disconnected",
                "error.type": "stream_interrupted",
                "otel.status_code": "ERROR",
                error: true,
              }
            : {}),
        }),
      };
      const readiness = {
        ...structuredClone(receiver),
        spanID: "8".repeat(16),
        operationName: "postgres.ready",
        references: [
          {
            refType: "CHILD_OF",
            traceID: receipt.traceID,
            spanID: receiver.spanID,
          },
        ],
        tags: tags({ "span.kind": "internal", "db.system.name": "postgresql" }),
      };
      const sql = {
        ...structuredClone(readiness),
        spanID: "9".repeat(16),
        operationName: "SELECT",
        references: [
          {
            refType: "CHILD_OF",
            traceID: receipt.traceID,
            spanID: readiness.spanID,
          },
        ],
        tags: tags({
          "span.kind": "client",
          "db.system.name": "postgresql",
          "db.namespace": "antnest_agent_acp",
          "db.operation.name": "SELECT",
          "db.query.text": "SELECT 1",
        }),
      };
      raw.set(receipt.traceID, {
        traceID: receipt.traceID,
        processes: structuredClone(f.trace.processes),
        spans: [client, receiver, readiness, sql],
      });
    }
  }
  let rounds = 0,
    flushed = false;
  const request = async (address, options) => {
    assert(flushed);
    assert(options.signal instanceof AbortSignal);
    const id = new URL(address).pathname.split("/").at(-1);
    if (id === f.trace.traceID) rounds++;
    const state = new Map(
      [...raw].map(([key, value]) => [key, structuredClone(value)]),
    );
    mutate(state, rounds);
    return state.has(id)
      ? Response.json({ data: [state.get(id)] })
      : new Response("", { status: 404 });
  };
  return {
    ...f,
    raw,
    directory,
    get rounds() {
      return rounds;
    },
    options: {
      directory,
      request,
      flush: async () => {
        flushed = true;
      },
      wait: async () => {},
      attempts: 5,
      secrets: ["PRIVATE-COMMAND-CANARY"],
    },
  };
}

function wsConsumerFixture(t, { mutate = () => {} } = {}) {
  const f = privateBoundaryFixture(fixture("command"));
  const directory = mkdtempSync(join(tmpdir(), "antnest-source-hook-ws-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const expected = { ...f.expected };
  delete expected.connectionTrace;
  delete expected.connectionSpanID;
  let rounds = 0;
  return {
    ...f,
    expected,
    directory,
    raw: new Map([
      [f.trace.traceID, f.trace],
      [f.connectionTrace.traceID, f.connectionTrace],
    ]),
    get rounds() {
      return rounds;
    },
    options: {
      directory,
      flush: async () => {},
      wait: async () => {},
      attempts: 6,
      request: async (address) => {
        const path = new URL(address).pathname;
        if (path === `/api/traces/${f.connectionTrace.traceID}`) rounds++;
        const state = new Map([
          [f.trace.traceID, structuredClone(f.trace)],
          [f.connectionTrace.traceID, structuredClone(f.connectionTrace)],
        ]);
        mutate(state, rounds);
        if (path === "/api/v3/trace-summaries")
          return Response.json({ summaries: [{ traceId: f.trace.traceID }] });
        const trace = state.get(path.split("/").at(-1));
        return trace
          ? Response.json({ data: [trace] })
          : new Response("", { status: 404 });
      },
    },
  };
}

const canonicalSources = (sources) =>
  JSON.stringify(
    sources
      .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
      .map((source) => ({
        ...source,
        spans: source.spans.toSorted((a, b) =>
          a.spanID.localeCompare(b.spanID),
        ),
      })),
  );

function assertCompleteReceipt(result, f, attempts) {
  const receipt = result.complete_source_receipt;
  assert(receipt, "complete source receipt required");
  assert.equal(receipt.version, 1);
  assert.equal(receipt.transport, f.expected.transport);
  assert.equal(receipt.stable_samples, 3);
  assert.deepEqual(receipt.source_trace_ids, [...f.raw.keys()].sort());
  assert.deepEqual(
    receipt.samples.map((sample) => sample.attempt),
    attempts,
  );
  const manifest = parse(join(result.evidence_directory, "manifest.json"));
  const files = [];
  for (const sample of receipt.samples) {
    assert.equal(sample.snapshot_sha256, receipt.samples[0].snapshot_sha256);
    assert.equal(sample.source_snapshot_sha256, receipt.source_snapshot_sha256);
    assert.deepEqual(sample.source_trace_ids, receipt.source_trace_ids);
    assert.deepEqual(
      sample.queries,
      manifest.queries.filter((query) => query.attempt === sample.attempt),
    );
    assert.equal(
      sample.queries.length,
      f.expected.transport === "http" ? 4 : 3,
    );
    const sources = new Map();
    for (const query of sample.queries) {
      files.push(query.file);
      const bytes = readFileSync(join(result.evidence_directory, query.file));
      assert.equal(hash(bytes), query.sha256);
      assert.equal(bytes.length, query.bytes);
      assert.equal(query.status, 200);
      assert.equal(query.body_complete, true);
      assert.equal(query.outcome, "complete");
      for (const trace of JSON.parse(bytes).data ?? [])
        sources.set(trace.traceID, trace);
    }
    assert.deepEqual([...sources.keys()].sort(), receipt.source_trace_ids);
    assert.equal(
      hash(canonicalSources([...sources.values()])),
      sample.source_snapshot_sha256,
    );
    if (f.expected.transport === "websocket") {
      const snapshot = JSON.stringify({
        candidates: [f.trace.traceID],
        sources: JSON.parse(canonicalSources([...sources.values()])),
      });
      assert.equal(hash(snapshot), sample.snapshot_sha256);
    }
  }
  assert.equal(new Set(files).size, files.length);
}

for (const [transport, makeFixture] of [
  ["http", httpFixture],
  ["websocket", wsConsumerFixture],
]) {
  test(`complete-source ${transport} hook sees all validated sources and reports in three actual samples`, async (t) => {
    const f = makeFixture(t);
    const calls = [];
    const result = await collectConsumer(
      "http://jaeger",
      f.expected,
      f.options,
      {
        ownedReasons: consumerReasons(),
        inspect: consumerInspector,
        inspectCompleteSources: (context) => {
          assert.equal(context.expected.method, f.expected.method);
          assert.deepEqual(
            context.sources.map((source) => source.traceID).sort(),
            [...f.raw.keys()].sort(),
          );
          assert.equal(context.reports.length, transport === "http" ? 4 : 1);
          if (transport === "http")
            assert.deepEqual(
              context.reports.map((report) => report.trace_id).sort(),
              [...f.raw.keys()].sort(),
            );
          calls.push(context);
        },
      },
    );
    assert.equal(calls.length, 3);
    assert.equal(f.rounds, 3);
    assertCompleteReceipt(result, f, [1, 2, 3]);
    assert.equal(
      result.strict_trace,
      transport === "http" ? "failed" : "passed",
    );
    assert.deepEqual(
      parse(join(result.evidence_directory, "result.json")),
      JSON.parse(JSON.stringify(result)),
    );
  });

  for (const kind of [
    "throw once",
    "return replacement",
    "change source",
    "remove source",
    "change report",
    "remove report",
    "change claim",
    "change expected",
    "external source",
    "external report",
  ])
    test(`complete-source ${transport} ${kind} fails immediately and cannot be retried clean`, async (t) => {
      const f = makeFixture(t);
      let calls = 0,
        retainedTrace,
        retainedReport;
      await assert.rejects(
        collectConsumer("http://jaeger", f.expected, f.options, {
          ownedReasons: consumerReasons(),
          inspect: (...args) => {
            retainedTrace = args[0];
            retainedReport = consumerInspector(...args);
            return retainedReport;
          },
          inspectCompleteSources: ({ sources, reports, expected }) => {
            calls++;
            if (calls > 1) return;
            if (kind === "throw once") throw new Error("PRIVATE-HOOK-CANARY");
            if (kind === "return replacement")
              return { strict_trace: "passed" };
            if (kind === "change source")
              sources.at(-1).spans[0].operationName = "rewritten";
            if (kind === "remove source") sources.pop();
            if (kind === "change report") reports[0].strict_trace = "rewritten";
            if (kind === "remove report") reports.pop();
            if (kind === "change claim")
              reports[0].owned_error_spans.push({ span_id: "invented" });
            if (kind === "change expected") expected.method = "invented";
            if (kind === "external source")
              retainedTrace.spans[0].operationName = "rewritten";
            if (kind === "external report")
              retainedReport.owned_error_spans.push({ span_id: "invented" });
          },
        }),
        (error) => {
          assert(!String(error).includes("PRIVATE-HOOK-CANARY"));
          assert.equal(error.cause, undefined);
          return true;
        },
      );
      assert.equal(calls, 1);
      assert.equal(f.rounds, 1);
      const archive = join(f.directory, readdirSync(f.directory)[0]);
      const manifest = parse(join(archive, "manifest.json"));
      assert.equal(manifest.status, "failed");
      assert(!readdirSync(archive).includes("result.json"));
      if (kind === "throw once")
        assert(
          readFileSync(
            join(archive, "complete-source-failure.private.txt"),
            "utf8",
          ).includes("PRIVATE-HOOK-CANARY"),
        );
      for (const query of manifest.queries)
        assert.equal(
          hash(readFileSync(join(archive, query.file))),
          query.sha256,
        );
    });

  test(`complete-source ${transport} refusal sees an auxiliary/connection warning before later clean samples`, async (t) => {
    const f = makeFixture(t, {
      mutate: (state, round) => {
        if (round !== 1) return;
        const related = [...state.values()].find(
          (source) =>
            source.traceID !== f.trace.traceID &&
            (transport === "websocket" || source.traceID === "b".repeat(32)),
        );
        related.spans[1].warnings = ["original related-source warning"];
      },
    });
    let calls = 0;
    await assert.rejects(
      collectConsumer("http://jaeger", f.expected, f.options, {
        ownedReasons: consumerReasons(),
        inspect: consumerInspector,
        inspectCompleteSources: ({ sources }) => {
          calls++;
          assert(
            sources.some(
              (source) =>
                source.traceID !== f.trace.traceID &&
                source.spans.some((span) => span.warnings?.length),
            ),
          );
          throw new Error("related source refused");
        },
      }),
    );
    assert.equal(calls, 1);
    assert.equal(f.rounds, 1);
  });

  test(`complete-source ${transport} receipt retains the last three full changed samples`, async (t) => {
    const f = makeFixture(t, {
      mutate: (state, round) => {
        if (round > 1)
          [...state.values()].find(
            (source) => source.traceID !== f.trace.traceID,
          ).spans[1].warnings = ["late original warning"];
      },
    });
    let calls = 0;
    const result = await collectConsumer(
      "http://jaeger",
      f.expected,
      f.options,
      {
        ownedReasons: consumerReasons(),
        inspect: consumerInspector,
        inspectCompleteSources: () => {
          calls++;
        },
      },
    );
    assert.equal(calls, 4);
    assert.equal(f.rounds, 4);
    assert.equal(result.warning_count, 1);
    assert.equal(result.strict_trace, "failed");
    assertCompleteReceipt(result, f, [2, 3, 4]);
  });

  test(`complete-source ${transport} cannot splice validated samples across a missing main Trace`, async (t) => {
    const f = makeFixture(t, {
      mutate: (state, round) => {
        if (round === 2) state.delete(f.trace.traceID);
      },
    });
    let calls = 0;
    const result = await collectConsumer(
      "http://jaeger",
      f.expected,
      { ...f.options, attempts: 6 },
      {
        ownedReasons: consumerReasons(),
        inspect: consumerInspector,
        inspectCompleteSources: () => {
          calls++;
        },
      },
    );
    assert.equal(f.rounds, 5);
    assert.equal(calls, 4);
    assertCompleteReceipt(result, f, [3, 4, 5]);
  });

  test(`complete-source ${transport} cancellation after the callback cannot publish a receipt`, async (t) => {
    const f = makeFixture(t);
    const controller = new AbortController();
    const reason = new Error("collection canceled after callback");
    let calls = 0;
    await assert.rejects(
      collectConsumer(
        "http://jaeger",
        f.expected,
        { ...f.options, signal: controller.signal },
        {
          ownedReasons: consumerReasons(),
          inspect: consumerInspector,
          inspectCompleteSources: ({ signal }) => {
            calls++;
            assert.equal(signal, controller.signal);
            controller.abort(reason);
          },
        },
      ),
      (error) => error === reason,
    );
    assert.equal(f.rounds, 1);
    assert.equal(calls, 1);
    const archive = join(f.directory, readdirSync(f.directory)[0]);
    assert.equal(parse(join(archive, "manifest.json")).status, "failed");
    assert(!readdirSync(archive).includes("result.json"));
  });

  test(`complete-source ${transport} raw archive changes invalidate the final receipt`, async (t) => {
    const f = makeFixture(t);
    let calls = 0;
    await assert.rejects(
      collectConsumer("http://jaeger", f.expected, f.options, {
        ownedReasons: consumerReasons(),
        inspect: consumerInspector,
        inspectCompleteSources: () => {
          if (++calls !== 1) return;
          const archive = join(f.directory, readdirSync(f.directory)[0]);
          const query = parse(join(archive, "manifest.json")).queries[0];
          const file = join(archive, query.file);
          writeFileSync(
            file,
            Buffer.concat([readFileSync(file), Buffer.from(" ")]),
          );
        },
      }),
    );
    const archive = join(f.directory, readdirSync(f.directory)[0]);
    assert.equal(parse(join(archive, "manifest.json")).status, "failed");
    assert(!readdirSync(archive).includes("result.json"));
  });

  for (const target of ["raw", "expected"])
    test(`complete-source ${transport} owning ${target} rewrite fails before the hook without retry`, async (t) => {
      const f = makeFixture(t);
      let calls = 0,
        owningCalls = 0;
      await assert.rejects(
        collectConsumer("http://jaeger", f.expected, f.options, {
          ownedReasons: consumerReasons(),
          inspect: (...args) => {
            const result = consumerInspector(...args);
            if (++owningCalls === 1) {
              if (target === "raw")
                args[0].spans[0].operationName = "rewritten";
              else args[1].method = "rewritten";
            }
            return result;
          },
          inspectCompleteSources: () => {
            calls++;
          },
        }),
      );
      assert.equal(calls, 0);
      assert.equal(owningCalls, 1);
      assert.equal(f.rounds, 1);
    });

  for (const container of [Map, Set, Date])
    test(`complete-source ${transport} rejects non-JSON ${container.name} reports before the readonly hook`, async (t) => {
      const f = makeFixture(t);
      let calls = 0;
      await assert.rejects(
        collectConsumer("http://jaeger", f.expected, f.options, {
          ownedReasons: consumerReasons(),
          inspect: (...args) => ({
            ...consumerInspector(...args),
            extra: new container(),
          }),
          inspectCompleteSources: () => {
            calls++;
          },
        }),
      );
      assert.equal(calls, 0);
      assert.equal(f.rounds, 1);
    });

  for (const target of ["raw", "timing"])
    test(`complete-source ${transport} delayed ${target} mutation cannot change checked snapshots`, async (t) => {
      const f = makeFixture(t);
      let calls = 0,
        retainedTrace,
        retainedReport,
        checkedTiming,
        checkedOffsets,
        mutated = false;
      const result = await collectConsumer(
        "http://jaeger",
        f.expected,
        f.options,
        {
          ownedReasons: consumerReasons(),
          inspect: (...args) => {
            retainedTrace = args[0];
            retainedReport = consumerInspector(...args);
            retainedReport.time_observations ??= [];
            checkedTiming = structuredClone(retainedReport.time_observations);
            checkedOffsets = structuredClone(retainedReport.timing);
            return retainedReport;
          },
          inspectCompleteSources: () => {
            if (++calls !== 3) return;
            queueMicrotask(() =>
              queueMicrotask(() =>
                queueMicrotask(() => {
                  if (target === "raw")
                    retainedTrace.spans[0].warnings = [
                      "delayed rewritten warning",
                    ];
                  else {
                    retainedReport.time_observations.push({ invented: true });
                    const field = Object.keys(retainedReport.timing)[0];
                    assert(field);
                    retainedReport.timing[field] += 1000;
                  }
                  mutated = true;
                }),
              ),
            );
          },
        },
      );
      assert.equal(mutated, true);
      assert.equal(f.rounds, 3);
      assert.equal(calls, 3);
      assert.equal(result.warning_count, 0);
      assert(!result.time_observations.some((item) => item.invented));
      assert.deepEqual(result.timing, checkedOffsets);
      assert.deepEqual(
        result.time_observations.slice(0, checkedTiming.length),
        checkedTiming,
      );
      assertCompleteReceipt(result, f, [1, 2, 3]);
      const saved = parse(join(result.evidence_directory, "result.json"));
      assert.deepEqual(saved, JSON.parse(JSON.stringify(result)));
    });
}

test("complete-source HTTP delayed report mutation cannot reassign an admitted rejection", async (t) => {
  const f = httpFixture(t, { rejection: true });
  let calls = 0,
    retainedClaim,
    checkedClaim,
    mutated = false;
  const result = await collectConsumer("http://jaeger", f.expected, f.options, {
    ownedReasons: consumerReasons(),
    inspect: (...args) => {
      const report = consumerInspector(...args);
      retainedClaim = report.owned_error_spans.find(
        (claim) => claim.reason === "consumer-rejection",
      );
      assert(retainedClaim);
      checkedClaim = structuredClone(retainedClaim);
      return report;
    },
    inspectCompleteSources: () => {
      if (++calls !== 3) return;
      queueMicrotask(() =>
        queueMicrotask(() =>
          queueMicrotask(() => {
            retainedClaim.reason = "private-http-sse-close";
            mutated = true;
          }),
        ),
      );
    },
  });
  assert.equal(mutated, true);
  assert.equal(f.rounds, 3);
  assert.deepEqual(
    result.owned_error_spans.find(
      (claim) =>
        claim.trace_id === checkedClaim.trace_id &&
        claim.span_id === checkedClaim.span_id,
    ),
    checkedClaim,
  );
  assertCompleteReceipt(result, f, [1, 2, 3]);
});

for (const rejection of [false, true])
  test(`generic HTTP collection uses the owner only for the main request and retains raw inventory; rejection=${rejection}`, async (t) => {
    const f = httpFixture(t, { rejection });
    const calls = [];
    const reasons = consumerReasons();
    const flush = f.options.flush;
    const result = await collectConsumer(
      "http://jaeger",
      f.expected,
      {
        ...f.options,
        flush: async () => {
          await flush();
          reasons.clear();
        },
      },
      {
        ownedReasons: reasons,
        inspect: async (...args) => {
          calls.push(args[1].method);
          assert.deepEqual(args[2], f.options.secrets);
          const checked = consumerInspector(...args);
          return {
            ...checked,
            error_spans: 0,
            strict_trace: "passed",
            raw_error_inventory: [],
            diagnostic_inventory_verified: false,
          };
        },
      },
    );
    assert.equal(result.consumer, "native-inputs");
    assert.deepEqual(calls, Array(3).fill(f.expected.method));
    assert.equal(result.error_spans, rejection ? 3 : 1);
    assert.equal(result.owned_error_spans.length, result.error_spans);
    assert.equal(result.raw_error_inventory.length, result.error_spans);
    assert.equal(result.diagnostic_inventory_verified, true);
    assert.equal(result.strict_trace, "failed");
    assert.equal(result.http_auxiliary.length, 3);
    assert.equal(
      parse(join(result.evidence_directory, "manifest.json")).status,
      "collected",
    );
  });

for (const invalid of [
  "throw",
  "unallowed reason",
  "unclaimed error",
  "duplicate claim",
  "borrow auxiliary",
  "mutate raw",
])
  test(`generic HTTP owner cannot admit ${invalid}`, async (t) => {
    const f = httpFixture(t, { rejection: true });
    let called = 0;
    await assert.rejects(
      collectConsumer("http://jaeger", f.expected, f.options, {
        ownedReasons: consumerReasons(),
        inspect: (...args) => {
          called++;
          const checked = consumerInspector(...args);
          if (invalid === "throw") throw new Error("owner refused");
          if (invalid === "unallowed reason")
            checked.owned_error_spans[0].reason = "foreign";
          if (invalid === "unclaimed error") checked.owned_error_spans.pop();
          if (invalid === "duplicate claim")
            checked.owned_error_spans.push({ ...checked.owned_error_spans[0] });
          if (invalid === "borrow auxiliary")
            checked.owned_error_spans.push({
              trace_id: "b".repeat(32),
              span_id: f.receiver.spanID,
              reason: "private-http-sse-close",
            });
          if (invalid === "mutate raw")
            args[0].spans[0].operationName = "rewritten";
          return checked;
        },
      }),
    );
    assert(called > 0, "main owner was never evaluated");
    const [archive] = readdirSync(f.directory);
    assert.equal(
      parse(join(f.directory, archive, "manifest.json")).status,
      "failed",
    );
  });

for (const invalid of [
  "initialize",
  "foreign process",
  "missing GET",
  "hidden DELETE work",
])
  test(`generic HTTP owner cannot replace fixed auxiliary validation: ${invalid}`, async (t) => {
    const f = httpFixture(t, {
      mutate: (state) => {
        if (invalid === "initialize")
          state
            .get("a".repeat(32))
            .spans.find((span) => span.spanID === "request").logs = [
            { timestamp: 3, fields: [{ key: "level", value: "WARN" }] },
          ];
        if (invalid === "foreign process")
          state
            .get("a".repeat(32))
            .processes["agent-acp-service"].tags.find(
              (item) => item.key === "process.pid",
            ).value++;
        if (invalid === "missing GET") state.delete("b".repeat(32));
        if (invalid === "hidden DELETE work")
          state
            .get("d".repeat(32))
            .spans[1].tags.push(...tags({ "rpc.method": "session/new" }));
      },
    });
    const calls = [];
    let sourceCalls = 0;
    await assert.rejects(
      collectConsumer("http://jaeger", f.expected, f.options, {
        ownedReasons: consumerReasons(),
        inspect: (...args) => {
          calls.push(args[1].method);
          return consumerInspector(...args);
        },
        inspectCompleteSources: () => {
          sourceCalls++;
        },
      }),
    );
    assert(
      !calls.includes("initialize"),
      "auxiliary initialize reached consumer callback",
    );
    assert.equal(sourceCalls, 0);
    const [archive] = readdirSync(f.directory);
    const manifest = parse(join(f.directory, archive, "manifest.json"));
    assert.equal(manifest.status, "failed");
    for (const query of manifest.queries)
      assert.equal(
        hash(readFileSync(join(f.directory, archive, query.file))),
        query.sha256,
      );
  });

test("Commands options cannot replace its owning inspector or reasons", async (t) => {
  const f = httpFixture(t, {
    mutate: (state) => {
      state.get(f.trace.traceID).spans[0].logs = [
        { timestamp: 3, fields: [{ key: "level", value: "WARN" }] },
      ];
    },
  });
  let called = false;
  await assert.rejects(
    collect("http://jaeger", f.expected, {
      ...f.options,
      inspect: () => {
        called = true;
        return {};
      },
      ownedReasons: new Set(["anything"]),
    }),
  );
  assert.equal(called, false);
});

for (const rejection of [false, true])
  test(`HTTP collection retains complete auxiliary inventory and raw diagnostics; rejection=${rejection}`, async (t) => {
    const f = httpFixture(t, { rejection });
    const original = structuredClone([...f.raw]);
    const result = await collect("http://jaeger", f.expected, f.options);
    assert.equal(f.rounds, 3);
    assert.equal(result.trace_id, f.trace.traceID);
    assert.equal(result.http_auxiliary.length, 3);
    assert.equal(result.error_spans, rejection ? 3 : 1);
    assert.equal(result.raw_error_inventory.length, result.error_spans);
    assert.equal(result.owned_error_spans.length, result.error_spans);
    assert.equal(result.strict_trace, "failed");
    assert.equal(
      implementation.privateCommandStrictOutcome([result]).accepted,
      true,
    );
    const completion = implementation.privateCommandStrictOutcome([result]);
    assert.equal(completion.exit_code, 2);
    const output = {
      status: "business_passed",
      scenarios: 3,
      ...completion,
      traces: [result],
    };
    assert.equal(
      verdict(completion.exit_code, JSON.stringify(output), true),
      "warning",
    );
    assert.equal(
      verdict(completion.exit_code, JSON.stringify(output), false),
      "failed",
    );
    const incomplete = { ...output };
    delete incomplete.scenarios;
    assert.equal(
      verdict(completion.exit_code, JSON.stringify(incomplete), true),
      "failed",
    );
    const manifest = parse(join(result.evidence_directory, "manifest.json"));
    assert.equal(manifest.status, "collected");
    assert.equal(manifest.queries.length, 12);
    for (const query of manifest.queries) {
      const path = join(result.evidence_directory, query.file);
      assert.equal(query.body_complete, true);
      assert.equal(hash(readFileSync(path)), query.sha256);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    assert.equal(statSync(result.evidence_directory).mode & 0o777, 0o700);
    assert.deepEqual([...f.raw], original);
    for (const mutate of [
      (r) => r.error_spans++,
      (r) => r.raw_error_inventory.pop(),
      (r) => r.owned_error_spans.pop(),
      (r) => r.owned_error_spans.push({ ...r.owned_error_spans[0] }),
      (r) => (r.owned_error_spans[0].span_id = "missing"),
      (r) => {
        r.warnings = ["unknown warning"];
        r.warning_count = 1;
      },
      (r) => {
        r.strict_trace = "passed";
      },
    ]) {
      const changed = structuredClone(result);
      mutate(changed);
      assert.equal(
        implementation.privateCommandStrictOutcome([changed]).accepted,
        false,
      );
      assert.equal(
        implementation.privateCommandStrictOutcome([changed]).exit_code,
        1,
      );
    }
  });

for (const observation of ["neutral cancellation", "Rust event timestamp"])
  test(`HTTP collection preserves original main and auxiliary ${observation} records`, async (t) => {
    const f = httpFixture(t);
    const expectedNeutral = [];
    const expectedTiming = [];
    for (const trace of [f.trace, f.raw.get("a".repeat(32))]) {
      const request = trace.spans.find((span) => span.spanID === "request");
      request.duration = 100;
      const read = addCompletedRead(
        trace,
        request,
        "http",
        f.expected.agentId,
        { preserveRequest: true },
      );
      for (const [span, event, reason] of [
        [
          read.client,
          read.client.logs[0],
          "completed-runtime-information-read-cleanup",
        ],
        [
          read.server,
          read.completion,
          "completed-initialize-mcp-read-disconnect",
        ],
      ])
        expectedNeutral.push({
          trace_id: trace.traceID,
          span_id: span.spanID,
          event_index: span.logs.indexOf(event),
          event_timestamp_us: event.timestamp,
          reason,
        });
      if (observation === "Rust event timestamp")
        expectedTiming.push(
          ...addRuntimeEventRepresentations(trace, read.read, read.executor),
        );
    }
    const original = structuredClone([...f.raw]);
    const result = await collect("http://jaeger", f.expected, f.options);
    if (observation === "neutral cancellation")
      assert.deepEqual(result.neutral_diagnostics, expectedNeutral);
    else assert.deepEqual(result.time_observations, expectedTiming);
    assert.deepEqual([...f.raw], original);
    assert.deepEqual(
      parse(join(result.evidence_directory, "result.json")),
      JSON.parse(JSON.stringify(result)),
    );
    assert.equal(result.error_spans, 3);
    assert.equal(result.strict_trace, "failed");
    assert.equal(
      implementation.privateCommandStrictOutcome([result]).exit_code,
      2,
    );
  });

for (const invalid of ["two microseconds", "non-Rust resource"])
  test(`auxiliary timing collection still rejects ${invalid}`, async (t) => {
    const f = httpFixture(t);
    const trace = f.raw.get("a".repeat(32));
    const request = trace.spans.find((span) => span.spanID === "request");
    request.duration = 100;
    const read = addCompletedRead(trace, request, "http", f.expected.agentId, {
      preserveRequest: true,
    });
    addRuntimeEventRepresentations(trace, read.read, read.executor);
    if (invalid === "two microseconds") read.executor.logs[0].timestamp++;
    else
      trace.processes[read.executor.processID].tags.find(
        (field) => field.key === "telemetry.sdk.language",
      ).value = "go";
    const original = structuredClone([...f.raw]);
    await assert.rejects(
      collect("http://jaeger", f.expected, f.options),
      /private command HTTP trace collection failed/,
    );
    assert.deepEqual([...f.raw], original);
  });

test("HTTP convergence includes late auxiliary warnings with unchanged span IDs", async (t) => {
  const f = httpFixture(t, {
    mutate: (state, round) => {
      if (round > 1)
        state.get("b".repeat(32)).spans[1].warnings = [
          "clock skew adjustment disabled; not applying calculated delta of -12µs",
        ];
    },
  });
  const result = await collect("http://jaeger", f.expected, f.options);
  assert.equal(f.rounds, 4);
  assert.equal(result.warning_count, 1);
  assert.equal(result.strict_trace, "failed");
  assert.equal(
    implementation.privateCommandStrictOutcome([result]).accepted,
    true,
  );
  assert.equal(
    implementation.privateCommandStrictOutcome([result]).exit_code,
    2,
  );
});

for (const [label, mutate] of [
  ...["b", "d"].flatMap((id) => [
    [
      `${id === "b" ? "GET" : "DELETE"} hidden business subtree`,
      (state) => {
        const trace = state.get(id.repeat(32));
        const business = structuredClone(trace.spans[2]);
        business.spanID = "6".repeat(16);
        business.operationName = "acp.session.fork";
        const write = structuredClone(trace.spans[3]);
        write.spanID = "7".repeat(16);
        write.operationName = "INSERT";
        write.references[0].spanID = business.spanID;
        write.tags.find((item) => item.key === "db.operation.name").value =
          "INSERT";
        write.tags.find((item) => item.key === "db.query.text").value =
          "INSERT INTO sessions DEFAULT VALUES";
        trace.spans.push(business, write);
      },
    ],
    [
      `${id === "b" ? "GET" : "DELETE"} hidden receiver RPC metadata`,
      (state) =>
        state.get(id.repeat(32)).spans[1].tags.push(
          ...tags({
            "rpc.service": "acp",
            "rpc.method": "session/new",
            "antnest.request.id": "unexpected-business-request",
          }),
        ),
    ],
  ]),
  [
    "GET readiness write",
    (state) => {
      const sql = state.get("b".repeat(32)).spans[3];
      sql.operationName = "INSERT";
      sql.tags.find((item) => item.key === "db.operation.name").value =
        "INSERT";
      sql.tags.find((item) => item.key === "db.query.text").value =
        "INSERT INTO sessions DEFAULT VALUES";
    },
  ],
  [
    "GET missing readiness SQL",
    (state) => state.get("b".repeat(32)).spans.pop(),
  ],
  [
    "GET detached readiness SQL",
    (state) => {
      const trace = state.get("b".repeat(32));
      trace.spans[3].references[0].spanID = trace.spans[1].spanID;
    },
  ],
  [
    "GET readiness SQL from another process",
    (state) => {
      const trace = state.get("b".repeat(32));
      trace.processes.foreign = structuredClone(
        trace.processes[trace.spans[3].processID],
      );
      trace.processes.foreign.tags.find((item) => item.key === "process.pid")
        .value++;
      trace.spans[3].processID = "foreign";
    },
  ],
  [
    "initialize wrong ACP process",
    (state) => {
      state
        .get("a".repeat(32))
        .processes["agent-acp-service"].tags.find(
          (item) => item.key === "process.pid",
        ).value++;
    },
  ],
  ["missing GET raw", (state) => state.delete("b".repeat(32))],
  [
    "GET extra exception",
    (state) =>
      state.get("b".repeat(32)).spans[1].tags.push({
        key: "exception.type",
        value: "UnexpectedError",
      }),
  ],
  [
    "GET duplicate HTTP status",
    (state) =>
      state
        .get("b".repeat(32))
        .spans[1].tags.push({ key: "http.response.status_code", value: 503 }),
  ],
  [
    "GET false parent",
    (state) =>
      (state.get("b".repeat(32)).spans[1].references[0].spanID = "missing"),
  ],
  [
    "GET wrong ACP process",
    (state) =>
      state
        .get("b".repeat(32))
        .processes["agent-acp-service"].tags.find(
          (x) => x.key === "process.pid",
        ).value++,
  ],
  [
    "GET unclaimed warning event",
    (state) => {
      state.get("b".repeat(32)).spans[0].logs = [
        { timestamp: 1, fields: [{ key: "level", value: "WARN" }] },
      ];
    },
  ],
  [
    "DELETE refusal",
    (state) =>
      (state
        .get("d".repeat(32))
        .spans[1].tags.find(
          (x) => x.key === "http.response.status_code",
        ).value = 503),
  ],
  [
    "auxiliary content leak",
    (state) =>
      state.get("b".repeat(32)).spans[1].tags.push({
        key: "unexpected",
        value: "PRIVATE-COMMAND-CANARY",
      }),
  ],
])
  test(`HTTP collector preserves failed raw: ${label}`, async (t) => {
    const f = httpFixture(t, { mutate });
    await assert.rejects(
      collect("http://jaeger", f.expected, { ...f.options, attempts: 3 }),
    );
    const [archive] = readdirSync(f.directory);
    const manifest = parse(join(f.directory, archive, "manifest.json"));
    assert.equal(manifest.status, "failed");
    assert(manifest.queries.length > 0);
    for (const query of manifest.queries)
      assert.equal(
        hash(readFileSync(join(f.directory, archive, query.file))),
        query.sha256,
      );
  });

test("HTTP collector rejects a live connection before querying", async (t) => {
  const f = httpFixture(t);
  f.expected.httpConnection.streamJoined = false;
  await assert.rejects(collect("http://jaeger", f.expected, f.options));
  assert.equal(f.rounds, 0);
});

test("HTTP cancellation during final response settlement cannot publish collected evidence", async (t) => {
  const acceptedAfterCancellation = [];
  for (let turns = 1; turns <= 16; turns++) {
    const f = httpFixture(t),
      controller = new AbortController();
    const manifest = () =>
      parse(join(f.directory, readdirSync(f.directory)[0], "manifest.json"));
    let statusAtCancellation;
    const request = async (address, options) => {
      const response = await f.options.request(address, options);
      if (
        f.rounds === 3 &&
        new URL(address).pathname.endsWith("d".repeat(32))
      ) {
        let remaining = turns;
        const cancel = () => {
          if (--remaining > 0) queueMicrotask(cancel);
          else {
            statusAtCancellation = manifest().status;
            controller.abort(new Error("stop final collection"));
          }
        };
        queueMicrotask(cancel);
      }
      return response;
    };
    let passed = false;
    try {
      await collect("http://jaeger", f.expected, {
        ...f.options,
        signal: controller.signal,
        request,
      });
      passed = true;
    } catch {
      // Cancellation may reject; verify its manifest and settlement below.
    }
    for (let settle = 0; !statusAtCancellation && settle < 32; settle++)
      await Promise.resolve();
    assert(
      statusAtCancellation,
      "final response cancellation was not exercised",
    );
    if (statusAtCancellation === "collecting") {
      if (passed) acceptedAfterCancellation.push(turns);
      else assert.equal(manifest().status, "failed");
    }
  }
  assert.deepEqual(acceptedAfterCancellation, []);
});

test("HTTP raw response cancellation waits for body cleanup and keeps the partial bytes", async (t) => {
  const f = httpFixture(t),
    controller = new AbortController();
  let release,
    cancelStarted,
    settled = false;
  const cancelled = new Promise((resolve) => {
    cancelStarted = resolve;
  });
  const releaseGate = new Promise((resolve) => {
    release = resolve;
  });
  const partial = Buffer.from('{"data":[');
  let pulls = 0;
  const pending = collect("http://jaeger", f.expected, {
    ...f.options,
    signal: controller.signal,
    request: async () =>
      new Response(
        new ReadableStream({
          pull(stream) {
            if (pulls++ === 0) stream.enqueue(partial);
            else controller.abort(new Error("stop collecting"));
          },
          async cancel() {
            cancelStarted();
            await releaseGate;
          },
        }),
      ),
  });
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await cancelled;
    await turn();
    assert.equal(settled, false);
  } finally {
    release();
  }
  await assert.rejects(pending, /stop collecting/);
  const [archive] = readdirSync(f.directory);
  const manifest = parse(join(f.directory, archive, "manifest.json"));
  const query = manifest.queries[0];
  assert.equal(query.body_complete, false);
  assert.equal(query.outcome, "aborted");
  assert.deepEqual(
    readFileSync(join(f.directory, archive, query.file)),
    partial,
  );
});

for (const version of [1, 2])
  test(`private WS ${version} uses actual raw upgrade and strict command diagnostics`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "antnest-command-ws-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const f = privateBoundaryFixture(fixture("command"), { version });
    const expected = { ...f.expected };
    delete expected.connectionTrace;
    delete expected.connectionSpanID;
    const request = async (address) => {
      const path = new URL(address).pathname;
      if (path === "/api/v3/trace-summaries")
        return Response.json({ summaries: [{ traceId: f.trace.traceID }] });
      return Response.json({
        data: [
          path.endsWith(f.connectionTrace.traceID)
            ? f.connectionTrace
            : f.trace,
        ],
      });
    };
    const options = {
      directory,
      request,
      flush: async () => {},
      wait: async () => {},
      attempts: 3,
    };
    const result = await collect("http://jaeger", expected, options);
    assert.equal(result.strict_trace, "passed");
    assert.equal(
      implementation.privateCommandStrictOutcome([result]).accepted,
      true,
    );
    assert.equal(
      implementation.privateCommandStrictOutcome([result]).exit_code,
      0,
    );
    let ownerCalls = 0;
    const generic = await collectConsumer("http://jaeger", expected, options, {
      ownedReasons: consumerReasons(),
      inspect: async (...args) => {
        ownerCalls++;
        return consumerInspector(...args);
      },
    });
    assert.equal(ownerCalls, 3);
    assert.equal(generic.consumer, "native-inputs");
    assert.equal(generic.error_spans, 0);
    assert.equal(generic.strict_trace, "passed");
    await assert.rejects(
      collectConsumer("http://jaeger", expected, options, {
        ownedReasons: consumerReasons(),
        inspect: () => {
          throw new Error("WS owner refused");
        },
      }),
    );
    f.trace.spans[0].logs = [
      { timestamp: 3, fields: [{ key: "level", value: "WARN" }] },
    ];
    await assert.rejects(collect("http://jaeger", expected, options));
  });
