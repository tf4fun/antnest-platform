import assert from "node:assert/strict";
import test from "node:test";
import { nativeTraceFixture } from "./private-trace.fixture.mjs";
import { tag } from "../observability/trace-tree.mjs";

const url = new URL("./private-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (f) => {
  assert.equal(typeof implementation.inspectPrivateNativeTrace, "function");
  return implementation.inspectPrivateNativeTrace(
    f.trace,
    f.expected,
    ["PRIVATE_NATIVE_CANARY"],
    f.requests,
  );
};

function cancelledHTTPResponse(options = {}) {
  const f = nativeTraceFixture({ http: true, ...options });
  const receipt = f.expected.httpConnection.requests.find(
    (item) => item.index === f.expected.httpRequestIndex,
  );
  receipt.bodyOutcome = "cancelled";
  receipt.events = [
    { kind: "cancel", monotonicMs: 1000 },
    { kind: "body_closed", monotonicMs: 1001 },
  ];
  f.set(f.client, "antnest.outcome", "cancelled");
  f.set(f.client, "antnest.http.body.outcome", "cancelled");
  return { ...f, httpReceipt: receipt };
}

for (const sameSpan of [false, true])
  for (const failed of [false, true])
    test(`HTTP response body close remains owned by its wire boundary: ${JSON.stringify({ sameSpan, failed })}`, () => {
      const f = cancelledHTTPResponse({ sameSpan, failed });
      const original = structuredClone([f.trace, f.expected]);
      const report = inspect(f);
      assert.equal(report.runs, 1);
      assert.equal(report.provider_requests, failed ? 0 : 1);
      assert.equal(report.runtime_information_reads, 2);
      assert(
        !report.neutral_diagnostics.some(
          (item) => item.span_id === f.client.spanID,
        ),
        "outer HTTP close cannot borrow Runtime diagnostics",
      );
      assert.deepEqual([f.trace, f.expected], original);
    });

for (const [label, mutate] of [
  ["different body receipt", (f) => (f.httpReceipt.bodyOutcome = "eof")],
  ["foreign wire request", (f) => (f.httpReceipt.requestID = "other")],
  [
    "unjoined transport",
    (f) => (f.expected.httpConnection.streamJoined = false),
  ],
  ["missing prompt receipt", (f) => delete f.expected.promptReceipt],
  ["HTTP client error", (f) => f.set(f.client, "otel.status_code", "ERROR")],
  [
    "HTTP client cancellation event",
    (f) => {
      f.client.logs = [
        {
          timestamp: f.client.startTime,
          fields: [{ key: "event", value: "antnest.cancelled" }],
        },
      ];
    },
  ],
  ...["model", "finish", "request", "provider"].map((name) => [
    `unowned ${name} cancellation`,
    (f) => f.set(f[name], "antnest.outcome", "cancelled"),
  ]),
  [
    "private client nested inside Run",
    (f) => {
      const extra = structuredClone(f.client);
      extra.spanID = "nested-private-client";
      extra.references = [
        { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: f.run.spanID },
      ];
      f.trace.spans.push(extra);
    },
  ],
])
  test(`HTTP response close cannot hide ${label}`, () => {
    const f = cancelledHTTPResponse();
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const profile of [
  { version: 1 },
  { version: 2 },
  { http: true },
  { http: true, sameSpan: true },
])
  for (const failed of [false, true])
    test(`private native execution proves model, actual finish, wire terminal and Runtime cleanup: ${JSON.stringify({ ...profile, failed })}`, () => {
      const f = nativeTraceFixture({ ...profile, failed });
      const raw = structuredClone(f.trace);
      const checked = inspect(f);
      assert.equal(checked.request_id, f.expected.requestId);
      assert.equal(checked.run_request_id, tag(f.run, "antnest.request.id"));
      assert.notEqual(checked.request_id, checked.run_request_id);
      assert.equal(checked.provider_requests, failed ? 0 : 1);
      assert.equal(checked.runs, 1);
      assert.equal(checked.local_failures, failed ? 1 : 0);
      assert.equal(checked.no_tool_execution, true);
      assert.equal(
        checked.runtime_information_reads,
        f.expected.protocolVersion === 1 ? 2 : 1,
      );
      assert.equal(
        checked.post_prompt_information_reads,
        f.expected.protocolVersion === 1 ? 1 : 0,
      );
      assert.equal(checked.gateway_ancestry, undefined);
      assert.equal(checked.transport_boundary, "private-acp");
      assert.deepEqual(
        checked.owned_error_spans.map((row) => row.span_id).sort(),
        failed
          ? [
              f.model.spanID,
              f.run.spanID,
              ...(f.expected.protocolVersion === 1 ? [f.request.spanID] : []),
            ].sort()
          : [],
      );
      assert.deepEqual(f.trace, raw);
    });

for (const profile of [{ version: 1 }, { version: 2 }, { http: true }])
  for (const failed of [false, true])
    test(`Run request identity is independent of its wire RPC: ${JSON.stringify({ ...profile, failed })}`, () => {
      const f = nativeTraceFixture({ ...profile, failed });
      const internalRequestID = "request_internal_run_intent";
      f.set(f.run, "antnest.request.id", internalRequestID);
      const result = inspect(f);
      assert.equal(result.request_id, f.expected.requestId);
      assert.equal(result.run_request_id, internalRequestID);
      assert.notEqual(result.run_request_id, result.request_id);
    });

for (const [label, mutate] of [
  [
    "missing wire receipt",
    (f) => {
      delete f.expected.promptReceipt;
    },
  ],
  [
    "wrong wire Session",
    (f) => {
      f.expected.promptReceipt.sessionId = "other";
    },
  ],
  [
    "wrong wire request",
    (f) => {
      f.expected.promptReceipt.requestId = "other";
    },
  ],
  ["missing Run request", (f) => f.set(f.run, "antnest.request.id", "")],
  ["nonstring Run request", (f) => f.set(f.run, "antnest.request.id", 42)],
  ["foreign Run Session", (f) => f.set(f.run, "antnest.session.id", "other")],
  [
    "unknown tool effect",
    (f) => f.set(f.run, "run.tool_effect_state", "unknown"),
  ],
  [
    "missing Runtime read",
    (f) => {
      f.trace.spans = f.trace.spans.filter(
        (span) => span !== f.information.read,
      );
    },
  ],
  [
    "failed Runtime close",
    (f) =>
      f.set(
        f.information.read,
        "antnest.mcp.connection.close.outcome",
        "failed",
      ),
  ],
  [
    "missing finish",
    (f) => {
      f.trace.spans = f.trace.spans.filter((span) => span !== f.finish);
    },
  ],
  [
    "abbreviated finish CTE",
    (f) =>
      f.set(
        f.finish,
        "db.query.text",
        "WITH finished AS (UPDATE runs SET state = $2 RETURNING id) SELECT id FROM finished",
      ),
  ],
  [
    "foreign finish",
    (f) => {
      f.finish.references[0].spanID = f.request.spanID;
    },
  ],
  [
    "model nested below durable finish",
    (f) => {
      f.model.references[0].spanID = f.finish.spanID;
    },
  ],
  [
    "finish nested below an unrelated operation",
    (f) => {
      const wrapper = f.add(
        "nested-finish",
        "run",
        "unrelated operation",
        undefined,
        20,
      );
      f.finish.references[0].spanID = wrapper.spanID;
    },
  ],
  [
    "foreign finish process",
    (f) => {
      f.trace.processes.foreign = structuredClone(
        f.trace.processes[f.run.processID],
      );
      f.trace.processes.foreign.tags.find((x) => x.key === "process.pid")
        .value++;
      f.finish.processID = "foreign";
    },
  ],
  [
    "duplicate finish",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.finish),
        spanID: "duplicate-finish",
      }),
  ],
  [
    "Tool execution",
    (f) => f.add("unexpected-tool", "run", "mcp.tools.call", undefined, 11000),
  ],
  [
    "management call inside Run",
    (f) => f.add("management", "run", "authorize", "identity-service", 11000),
  ],
  [
    "unowned warning event",
    (f) => {
      f.finish.logs = [
        {
          timestamp: f.finish.startTime,
          fields: [{ key: "level", value: "WARN" }],
        },
      ];
    },
  ],
  ["captured content", (f) => f.set(f.finish, "antnest.payload.json", "{}")],
  [
    "captured connection content",
    (f) =>
      f.set(f.expected.connectionTrace.spans[0], "antnest.payload.json", "{}"),
  ],
  [
    "captured content event",
    (f) => {
      f.finish.logs = [
        {
          timestamp: f.finish.startTime,
          fields: [{ key: "antnest.payload.json", value: "{}" }],
        },
      ];
    },
  ],
  [
    "private content",
    (f) => f.set(f.finish, "message", "PRIVATE_NATIVE_CANARY"),
  ],
])
  for (const failed of [false, true])
    test(`private native execution rejects ${label}; failed=${failed}`, () => {
      const f = nativeTraceFixture({ failed });
      mutate(f);
      assert.throws(() => inspect(f));
    });

for (const [label, mutate] of [
  [
    "foreign model receipt",
    (f) => {
      f.requests[0].model_span_id = f.model.spanID;
    },
  ],
  [
    "foreign model phase",
    (f) => {
      f.requests[0].phase = "other";
    },
  ],
  [
    "foreign model Trace",
    (f) => {
      f.requests[0].trace_id = "other";
    },
  ],
  ["extra Provider", (f) => f.requests.push({ ...f.requests[0] })],
  [
    "missing reply transaction",
    (f) => {
      f.trace.spans = f.trace.spans.filter(
        (span) => !["transaction", "insert"].includes(span.spanID),
      );
    },
  ],
  ["failed Provider HTTP", (f) => f.set(f.provider, "http.status_code", 503)],
  [
    "contradictory Provider HTTP status",
    (f) => f.set(f.provider, "http.response.status_code", 503),
  ],
  [
    "missing actual Provider HTTP status",
    (f) => {
      f.provider.tags = f.provider.tags.filter(
        ({ key }) => key !== "http.status_code",
      );
    },
  ],
  [
    "unaccounted model transport",
    (f) =>
      f.add("extra-http", "model", "HTTP GET unexpected", undefined, 15, {
        "span.kind": "client",
        "http.request.method": "GET",
      }),
  ],
  [
    "foreign streamed persistence namespace",
    (f) => f.set(f.insert, "db.namespace", "another_service"),
  ],
  [
    "database-tagged HTTP transport",
    (f) => f.set(f.insert, "http.request.method", "GET"),
  ],
  [
    "unowned model persistence",
    (f) => {
      f.insert.references[0].spanID = f.model.spanID;
    },
  ],
  [
    "uncommitted streamed reply transaction",
    (f) => f.set(f.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  [
    "unexpected streamed reply SQL operation",
    (f) => f.set(f.insert, "db.operation.name", "DELETE"),
  ],
  [
    "non-SQL operation disguised as persistence",
    (f) => {
      f.insert.operationName = "unrelated client work";
    },
  ],
  [
    "allowed SQL text with a different driver command",
    (f) => f.set(f.insert, "db.query.text", "BEGIN"),
  ],
  [
    "unrelated INSERT disguised as reply persistence",
    (f) =>
      f.set(
        f.insert,
        "db.query.text",
        "INSERT INTO learning_tasks VALUES ($1)",
      ),
  ],
  [
    "unrelated SELECT disguised as output read",
    (f) => f.set(f.outputRead, "db.query.text", "SELECT * FROM learning_tasks"),
  ],
  [
    "foreign streamed output Agent",
    (f) => f.set(f.output, "antnest.agent.id", "other-agent"),
  ],
  [
    "foreign streamed output Session",
    (f) => f.set(f.output, "antnest.session.id", "other-session"),
  ],
  [
    "wrong streamed output phase",
    (f) => f.set(f.output, "antnest.operation.phase", "write"),
  ],
  [
    "write disguised as output read",
    (f) => {
      f.outputRead.operationName = "UPDATE";
      f.set(f.outputRead, "db.operation.name", "UPDATE");
      f.set(
        f.outputRead,
        "db.query.text",
        "UPDATE acp_sessions SET title = $1",
      );
    },
  ],
  [
    "negative Provider duration",
    (f) => {
      f.provider.duration = -1;
    },
  ],
  [
    "nonfinite Provider duration",
    (f) => {
      f.provider.duration = Infinity;
    },
  ],
  [
    "nonfinite Provider start",
    (f) => {
      f.provider.startTime = NaN;
    },
  ],
  [
    "Provider starts before model",
    (f) => {
      f.provider.startTime = f.model.startTime - 1;
    },
  ],
  [
    "Provider finishes 1ms after model",
    (f) => {
      f.provider.duration =
        f.model.startTime + f.model.duration - f.provider.startTime + 1000;
    },
  ],
])
  test(`private native success rejects ${label}`, () => {
    const f = nativeTraceFixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const difference of [1, 999])
  test(`Provider endpoint retains same-Node ${difference}us observation`, () => {
    const f = nativeTraceFixture();
    f.provider.duration =
      f.model.startTime + f.model.duration - f.provider.startTime + difference;
    const result = inspect(f);
    assert.equal(
      result.time_observations.find(
        (row) => row.boundary === "provider-joined-by-model",
      ).raw_difference_us,
      difference,
    );
  });

for (const [label, mutate] of [
  [
    "different process",
    (f) => {
      f.trace.processes.foreign = structuredClone(
        f.trace.processes[f.model.processID],
      );
      f.trace.processes.foreign.tags.find((row) => row.key === "process.pid")
        .value++;
      f.provider.processID = "foreign";
    },
  ],
  [
    "nonintegral start",
    (f) => {
      f.provider.startTime += 0.5;
    },
  ],
])
  test(`Provider endpoint cannot defer ${label}`, () => {
    const f = nativeTraceFixture();
    mutate(f);
    f.provider.duration =
      f.model.startTime + f.model.duration - f.provider.startTime + 1;
    assert.throws(() => inspect(f));
  });

for (const [label, mutate] of [
  [
    "retryable wire failure",
    (f) => {
      f.expected.promptReceipt.error.retryable = true;
    },
  ],
  [
    "wrong wire model code",
    (f) => {
      f.expected.promptReceipt.error.code = "unknown";
    },
  ],
  [
    "wrong wire RPC code",
    (f) => {
      f.expected.promptReceipt.error.rpcCode = -32020;
    },
  ],
  [
    "unexpected Provider HTTP",
    (f) =>
      f.add(
        "unexpected-model-http",
        "model",
        "HTTP POST model",
        undefined,
        11000,
        { "span.kind": "client" },
      ),
  ],
  [
    "model foreign origin",
    (f) => f.set(f.model, "antnest.error.origin_span_id", "foreign"),
  ],
  [
    "extra model exception",
    (f) => f.set(f.model, "exception.type", "OtherError"),
  ],
  [
    "model duplicate field",
    (f) => f.model.tags.push({ key: "error.type", value: "ModelError" }),
  ],
  [
    "wrong model error event",
    (f) => {
      f.model.logs[0].fields.find((x) => x.key === "antnest.error.code").value =
        "other";
    },
  ],
  [
    "unowned Run error code",
    (f) => f.set(f.run, "antnest.error.code", "model_unsupported_content"),
  ],
  [
    "unowned Run error event",
    (f) => {
      f.run.logs = structuredClone(f.model.logs);
    },
  ],
  [
    "unowned RPC origin",
    (f) => f.set(f.request, "antnest.error.origin_span_id", f.model.spanID),
  ],
])
  test(`private native model mismatch rejects ${label}`, () => {
    const f = nativeTraceFixture({ failed: true });
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const [label, mutate] of [
  [
    "no admitted message",
    (f) => {
      f.expected.promptReceipt.result = {};
    },
  ],
  [
    "no terminal",
    (f) => {
      f.expected.promptReceipt.terminals = [];
    },
  ],
  [
    "duplicate terminal",
    (f) =>
      f.expected.promptReceipt.terminals.push(
        structuredClone(f.expected.promptReceipt.terminals[0]),
      ),
  ],
  [
    "foreign terminal Session",
    (f) => {
      f.expected.promptReceipt.terminals[0].sessionId = "other";
    },
  ],
  [
    "success terminal after failure",
    (f) => {
      f.expected.promptReceipt.terminals[0].update.stopReason = "end_turn";
    },
  ],
  [
    "borrowed v1 RPC error",
    (f) => f.set(f.request, "rpc.response.status_code", -32022),
  ],
])
  test(`v2 model mismatch rejects ${label}`, () => {
    const f = nativeTraceFixture({ failed: true, version: 2 });
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const span of ["insert", "transaction", "output", "outputRead"])
  for (const [field, value] of [
    ["duration", -1],
    ["duration", Infinity],
    ["startTime", NaN],
  ])
    test(`streamed persistence rejects invalid ${span} ${field} ${value}`, () => {
      const f = nativeTraceFixture();
      f[span][field] = value;
      assert.throws(() => inspect(f));
    });

for (const difference of [1, 999, 1000])
  test(`actual Node runtime resource preserves the strict sub-ms boundary: ${difference}us`, () => {
    const f = nativeTraceFixture();
    const process = f.trace.processes[f.model.processID];
    process.tags = process.tags.filter(
      ({ key }) => !key.startsWith("telemetry.sdk."),
    );
    process.tags.push({ key: "process.runtime.name", value: "nodejs" });
    f.model.duration = f.finish.startTime - f.model.startTime + difference;
    if (difference === 1000) return assert.throws(() => inspect(f));
    const raw = structuredClone(f.trace);
    const result = inspect(f);
    assert.equal(result.model_to_finish_gap_us, -difference);
    assert.deepEqual(f.trace, raw);
  });

for (const runtime of [undefined, "python"])
  test(`missing or conflicting Node runtime resource is rejected: ${runtime}`, () => {
    const f = nativeTraceFixture();
    const process = f.trace.processes[f.model.processID];
    if (runtime === undefined)
      process.tags = process.tags.filter(
        ({ key }) => !key.startsWith("telemetry.sdk."),
      );
    else process.tags.push({ key: "process.runtime.name", value: runtime });
    f.model.duration = f.finish.startTime - f.model.startTime + 1;
    assert.throws(() => inspect(f));
  });

for (const difference of [1, 999, 1000])
  test(`model-to-finish original same-Node difference ${difference}us`, () => {
    const f = nativeTraceFixture();
    f.model.duration = f.finish.startTime - f.model.startTime + difference;
    if (difference === 1000) return assert.throws(() => inspect(f));
    const result = inspect(f);
    assert.equal(result.model_finish_order, "failed");
    assert.equal(result.model_to_finish_gap_us, -difference);
    assert.equal(
      result.time_observations.find(
        (row) => row.boundary === "model-before-durable-finish",
      ).raw_difference_us,
      difference,
    );
    assert.equal(tag(f.model, "model.name"), "native-model");
  });
