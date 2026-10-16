import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
    } catch {}
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
    f.trace.spans[0].logs = [
      { timestamp: 3, fields: [{ key: "level", value: "WARN" }] },
    ];
    await assert.rejects(collect("http://jaeger", expected, options));
  });
