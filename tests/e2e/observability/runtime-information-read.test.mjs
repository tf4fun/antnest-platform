import assert from "node:assert/strict";
import test from "node:test";
import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";
import { completedInitializeRead } from "../edge-gateway/resolve-cache-outage-diagnostics.mjs";
import { addRuntimeEventRepresentations } from "./runtime-information-timing-fixture.mjs";
import { addFailedV1RunResponse } from "./failed-run-response-fixture.mjs";

const url = new URL("./runtime-information-read.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture(options) {
  const traceID = "a".repeat(32);
  const root = {
    traceID,
    spanID: "1".repeat(16),
    processID: "acp",
    operationName: "root",
    startTime: 1000,
    duration: 100,
    references: [],
    tags: [],
    logs: [],
  };
  const trace = { traceID, processes: {}, spans: [root], warnings: [] };
  const result = {
    trace,
    ...addCompletedRead(trace, root, "http", "agent_test", options),
  };
  // Keep forged causal gaps above the separately deferred SDK sub-ms precision.
  for (const span of trace.spans) {
    span.startTime = root.startTime + (span.startTime - root.startTime) * 1000;
    span.duration *= 1000;
    for (const event of span.logs)
      event.timestamp =
        root.startTime + (event.timestamp - root.startTime) * 1000;
  }
  return result;
}
const inspect = (f, options) => {
  assert.equal(typeof implementation.inspectRuntimeInformationRead, "function");
  return implementation.inspectRuntimeInformationRead(f.trace, f.read, options);
};
const set = (span, key, value) => {
  span.tags = span.tags.filter((f) => f.key !== key);
  span.tags.push({ key, value });
};
const eventSet = (event, key, value) => {
  event.fields = event.fields.filter((f) => f.key !== key);
  event.fields.push({ key, value });
};

for (const [runtimeOutcome, clientOutcome] of [
  ["canceled", "cancelled"],
  ["success", "cancelled"],
  ["success", "success"],
])
  test(
    "read proof binds original parsed result and owned close with " +
      runtimeOutcome +
      "/" +
      clientOutcome,
    () => {
      const f = fixture({ runtimeOutcome, clientOutcome }),
        before = structuredClone(f.trace);
      const proof = inspect(f);
      assert.equal(proof.read, f.read);
      assert.equal(proof.request, f.root);
      assert.equal(proof.resource.server, f.server);
      assert.equal(proof.resource.client, f.client);
      assert.equal(proof.resource.operation, f.operation);
      assert.equal(proof.clients.length, 2);
      assert.equal(proof.spans.length, 8);
      assert.equal(proof.events.discoveryReady, f.discoveryReady);
      assert.equal(proof.events.readStarted, f.readStarted);
      assert.equal(proof.events.validated, f.validated);
      assert.equal(proof.events.closeStarted, f.closeStarted);
      assert.equal(proof.events.closeCompleted, f.closeCompleted);
      assert.deepEqual(proof.timeObservations, []);
      assert.deepEqual(f.trace, before);
    },
  );

function closePendingDiscovery(f) {
  const client = f.handshake.client;
  set(client, "antnest.operation.phase", "http.send_or_read");
  set(client, "antnest.outcome", "cancelled");
  set(client, "antnest.cancellation.type", "AbortError");
  client.logs = [
    {
      timestamp: f.closeStarted.timestamp + 2000,
      fields: [
        { key: "event", value: "antnest.cancelled" },
        { key: "antnest.cancellation.type", value: "AbortError" },
        { key: "antnest.cancellation.phase", value: "http.send_or_read" },
      ],
    },
  ];
  client.duration = client.logs[0].timestamp + 1000 - client.startTime;
  return f;
}

for (const [runtimeOutcome, clientOutcome] of [
  ["canceled", "cancelled"],
  ["success", "cancelled"],
  ["success", "success"],
])
  test(`owned read close joins pending discovery with resource ${runtimeOutcome}/${clientOutcome}`, () => {
    const f = fixture({ runtimeOutcome, clientOutcome });
    const baseline = inspect(f);
    closePendingDiscovery(f);
    const before = structuredClone(f.trace);
    const proof = inspect(f);
    assert.equal(proof.discovery.client, f.handshake.client);
    assert.equal(proof.discovery.server, f.handshake.server);
    assert.equal(
      proof.neutralDiagnostics.length,
      baseline.neutralDiagnostics.length + 1,
    );
    assert.deepEqual(
      proof.neutralDiagnostics.find(
        (item) => item.span_id === f.handshake.client.spanID,
      ),
      {
        trace_id: f.trace.traceID,
        span_id: f.handshake.client.spanID,
        event_index: 0,
        event_timestamp_us: f.handshake.client.logs[0].timestamp,
        reason: "completed-runtime-information-read-cleanup",
      },
    );
    assert.deepEqual(proof.timeObservations, []);
    assert.deepEqual(f.trace, before);
  });

for (const [name, mutate] of [
  [
    "missing parsed discovery receipt",
    (f) => {
      f.read.logs = f.read.logs.filter((event) => event !== f.discoveryReady);
    },
  ],
  [
    "unvalidated resource",
    (f) => set(f.read, "antnest.mcp.resource_read.outcome", "failed"),
  ],
  [
    "caller cancellation",
    (f) => set(f.read, "antnest.mcp.caller_cancelled", true),
  ],
  [
    "failed close",
    (f) => set(f.read, "antnest.mcp.connection.close.outcome", "failed"),
  ],
  [
    "cancellation before close",
    (f) => {
      f.handshake.client.logs[0].timestamp = f.closeStarted.timestamp - 2000;
    },
  ],
  [
    "cancellation after close",
    (f) => {
      const client = f.handshake.client;
      client.logs[0].timestamp = f.closeCompleted.timestamp + 2000;
      client.duration = client.logs[0].timestamp - client.startTime;
    },
  ],
  [
    "foreign read parent",
    (f) => {
      f.handshake.client.references[0].spanID = f.root.spanID;
    },
  ],
  [
    "foreign ACP process",
    (f) => {
      f.trace.processes.foreign = structuredClone(f.trace.processes.acp);
      f.handshake.client.processID = "foreign";
    },
  ],
  [
    "foreign Runtime execution",
    (f) => set(f.handshake.server, "antnest.runtime.execution.id", "other"),
  ],
  [
    "duplicate cancellation",
    (f) =>
      f.handshake.client.logs.push(structuredClone(f.handshake.client.logs[0])),
  ],
  [
    "non-AbortError cancellation",
    (f) => set(f.handshake.client, "antnest.cancellation.type", "TimeoutError"),
  ],
  [
    "HTTP failure",
    (f) => set(f.handshake.client, "http.response.status_code", 503),
  ],
  [
    "unmatched response bytes",
    (f) => set(f.handshake.client, "http.response.body.size", 1),
  ],
  ["additional error", (f) => set(f.handshake.client, "error", true)],
  [
    "additional error event field",
    (f) => eventSet(f.handshake.client.logs[0], "error.type", "other"),
  ],
  [
    "Runtime discovery cancellation",
    (f) => set(f.handshake.server, "http.transport.outcome", "canceled"),
  ],
])
  test("pending discovery close rejects " + name, () => {
    const f = closePendingDiscovery(fixture());
    mutate(f);
    const before = structuredClone(f.trace);
    assert.throws(() => inspect(f));
    assert.deepEqual(f.trace, before);
  });

test("parsed SSE discovery permits resource dispatch before its HTTP EOF", () => {
  const f = fixture();
  f.handshake.client.duration =
    f.client.startTime + 5000 - f.handshake.client.startTime;
  const before = structuredClone(f.trace);
  const proof = inspect(f);
  assert.equal(proof.events.discoveryReady, f.discoveryReady);
  assert(
    f.handshake.client.startTime + f.handshake.client.duration >
      f.client.startTime,
  );
  assert.deepEqual(proof.timeObservations, []);
  assert.deepEqual(f.trace, before);
});

for (const ordering of ["reversed", "event-name"])
  test(
    "read proof preserves backend " +
      ordering +
      " event inventory while checking original timestamps",
    () => {
      const f = fixture();
      if (ordering === "reversed") f.read.logs.reverse();
      else
        f.read.logs.sort((left, right) =>
          left.fields
            .find((row) => row.key === "event")
            .value.localeCompare(
              right.fields.find((row) => row.key === "event").value,
            ),
        );
      const before = structuredClone(f.trace);
      const proof = inspect(f);
      assert.equal(proof.events.discoveryReady, f.discoveryReady);
      assert.equal(proof.events.readStarted, f.readStarted);
      assert.equal(proof.events.closeCompleted, f.closeCompleted);
      assert.deepEqual(f.trace, before);
    },
  );

const runtimeSpans = {
  "discovery HTTP": (f) => f.handshake.server,
  "discovery operation": (f) => f.handshake.operation,
  "resource HTTP": (f) => f.server,
  "resource operation": (f) => f.operation,
  executor: (f) => f.executor,
};
for (const [name, select] of Object.entries(runtimeSpans)) {
  test(`records each original ${name} event at the Jaeger end representation boundary`, () => {
    const f = fixture();
    const expected = addRuntimeEventRepresentations(f.trace, f.read, select(f));
    const before = structuredClone(f.trace);
    assert.deepEqual(inspect(f).timeObservations, expected);
    assert.deepEqual(f.trace, before);
  });
  for (const where of ["after", "before"])
    test(`rejects ${name} event ${where} its Jaeger representation interval`, () => {
      const f = fixture(),
        span = select(f);
      span.logs[0].timestamp =
        where === "after"
          ? span.startTime + span.duration + 2
          : span.startTime - 1;
      assert.throws(() => inspect(f));
    });
}
for (const [name, mutate] of [
  [
    "fractional start",
    (span) => {
      span.startTime += 0.5;
    },
  ],
  [
    "fractional duration",
    (span) => {
      span.duration += 0.5;
    },
  ],
  [
    "fractional event",
    (span) => {
      span.logs[0].timestamp += 0.5;
    },
  ],
  [
    "unsafe timestamp",
    (span) => {
      span.logs[0].timestamp = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "failed diagnostic",
    (span) => eventSet(span.logs[0], "http.status_code", 503),
  ],
])
  test("Runtime event representation does not excuse " + name, () => {
    const f = fixture();
    addRuntimeEventRepresentations(f.trace, f.read, f.operation);
    mutate(f.operation);
    assert.throws(() => inspect(f));
  });
for (const next of ["HTTP completion", "HTTP cancellation"])
  test(
    "Runtime representation cannot put operation completion after " + next,
    () => {
      const f = fixture();
      addRuntimeEventRepresentations(f.trace, f.read, f.operation);
      const event = next === "HTTP completion" ? f.completion : f.cancelled;
      event.timestamp = f.operation.startTime + f.operation.duration;
      assert.throws(() => inspect(f));
    },
  );
for (const field of ["telemetry.sdk.language", "telemetry.sdk.name"])
  for (const value of [undefined, "foreign"])
    test(`Runtime representation rejects ${field}=${value}`, () => {
      const f = fixture();
      addRuntimeEventRepresentations(f.trace, f.read, f.operation);
      const process = f.trace.processes[f.operation.processID];
      process.tags = process.tags.filter((row) => row.key !== field);
      if (value !== undefined) process.tags.push({ key: field, value });
      assert.throws(() => inspect(f));
    });
test("Runtime representation cannot put executor completion after operation completion", () => {
  const f = fixture();
  const finish = f.executor.startTime + f.executor.duration;
  f.operation.duration = finish - f.operation.startTime;
  f.operation.logs[0].timestamp = finish;
  addRuntimeEventRepresentations(f.trace, f.read, f.executor);
  assert.throws(() => inspect(f));
});
test("Runtime representation cannot put cancellation after HTTP completion", () => {
  const f = fixture();
  addRuntimeEventRepresentations(f.trace, f.read, f.server);
  f.completion.timestamp = f.server.startTime + f.server.duration;
  assert.throws(() => inspect(f));
});

function displaced(kind, difference) {
  const f = fixture();
  const finish = (span) => span.startTime + span.duration;
  if (kind === "read-joined-by-request")
    f.read.duration = finish(f.root) + difference - f.read.startTime;
  else if (kind === "client-joined-by-read") {
    f.closeCompleted.timestamp = finish(f.read);
    f.client.duration = finish(f.read) + difference - f.client.startTime;
  } else if (kind === "client-joined-at-close")
    f.client.duration =
      f.closeCompleted.timestamp + difference - f.client.startTime;
  else if (kind === "client-cancel-after-close-start")
    f.client.logs[0].timestamp = f.closeStarted.timestamp - difference;
  else if (kind === "client-cancel-before-close-complete") {
    f.client.logs[0].timestamp = f.closeCompleted.timestamp + difference;
    f.client.duration = f.client.logs[0].timestamp - f.client.startTime;
  } else if (kind === "discovery-client-before-ready")
    f.discoveryReady.timestamp = f.handshake.client.startTime - difference;
  else if (kind === "dispatch-before-resource-client")
    f.readStarted.timestamp = f.client.startTime + difference;
  else throw new Error("unknown timing fixture");
  return f;
}

const timingKinds = [
  "read-joined-by-request",
  "client-joined-by-read",
  "client-joined-at-close",
  "client-cancel-after-close-start",
  "client-cancel-before-close-complete",
  "discovery-client-before-ready",
  "dispatch-before-resource-client",
];
for (const kind of timingKinds) {
  for (const difference of [1, 999])
    test(`records original same-node ${kind} difference ${difference}us`, () => {
      const f = displaced(kind, difference),
        before = structuredClone(f.trace);
      const proof = inspect(f);
      const record = proof.timeObservations.find(
        (row) => row.boundary === kind,
      );
      assert(record, "missing original endpoint observation");
      assert.equal(record.raw_difference_us, difference);
      assert.equal(record.raw_left_us - record.raw_right_us, difference);
      assert.equal(record.trace_id, f.trace.traceID);
      assert.equal(record.reason, "deferred-same-node-sdk-sub-ms-endpoint");
      assert.deepEqual(f.trace, before);
    });
  test(`rejects ${kind} at exactly one millisecond`, () => {
    assert.throws(() => inspect(displaced(kind, 1000)));
  });
}

for (const field of ["host.name", "process.pid", "service.instance.id"])
  test("does not defer an endpoint without actual process " + field, () => {
    const f = displaced("read-joined-by-request", 999);
    f.trace.processes.acp.tags = f.trace.processes.acp.tags.filter(
      (row) => row.key !== field,
    );
    assert.throws(() => inspect(f));
  });
for (const owner of ["read", "root"])
  test(
    "does not defer an endpoint without integer-ms " + owner + " anchor",
    () => {
      const f = displaced("read-joined-by-request", 999);
      f[owner].startTime += 1;
      f[owner].duration -= 1;
      assert.throws(() => inspect(f));
    },
  );
for (const kind of [
  "client-joined-at-close",
  "discovery-client-before-ready",
  "dispatch-before-resource-client",
])
  test("does not defer " + kind + " with a noninteger CLIENT anchor", () => {
    const f = displaced(kind, 999);
    const client =
      kind === "discovery-client-before-ready" ? f.handshake.client : f.client;
    client.startTime += 1;
    client.duration -= 1;
    assert.throws(() => inspect(f));
  });
test("does not defer a CLIENT endpoint borrowed from another direct parent", () => {
  const f = displaced("client-joined-at-close", 999);
  f.client.references[0].spanID = f.root.spanID;
  assert.throws(() => inspect(f));
});

function closedResponse(f, timestamp) {
  f.root.operationName = "acp session/prompt";
  for (const [key, value] of Object.entries({
    "span.kind": "server",
    "rpc.method": "session/prompt",
    "antnest.protocol.version": "v1",
    error: true,
    "error.type": "Error",
    "otel.status_code": "ERROR",
    "antnest.outcome": "error",
    "antnest.operation.phase": "acp.dispatch",
  }))
    set(f.root, key, value);
  f.root.logs = [
    {
      timestamp,
      fields: Object.entries({
        event: "antnest.error",
        "antnest.error.stage": "acp.dispatch",
        "antnest.error.type": "Error",
        "antnest.error.message": "Error: unregistered message omitted",
        "antnest.error.cause_types": "[]",
        "antnest.error.causes": JSON.stringify([
          { type: "Error", message: "Error: unregistered message omitted" },
        ]),
        "antnest.operation.phase": "acp.dispatch",
      }).map(([key, value]) => ({ key, value })),
    },
  ];
}
for (const http of [false, true])
  for (const causeTypes of [[], "[]"])
    test(`failed v1 Run response retains independently completed read without owning the parent error: http=${http}, cause=${typeof causeTypes}`, () => {
      const f = fixture();
      addFailedV1RunResponse(f.root, { http, causeTypes });
      const raw = structuredClone(f.trace);
      assert.throws(() => inspect(f));
      assert.throws(() => inspect(f, { requestOutcome: "closed-v1-response" }));
      const proof = inspect(f, { requestOutcome: "failed-v1-run-response" });
      assert.equal(proof.request, f.root);
      assert(!proof.spans.includes(f.root));
      assert(
        !proof.neutralDiagnostics.some((row) => row.span_id === f.root.spanID),
      );
      assert.deepEqual(f.trace, raw);
    });

for (const [name, mutate] of [
  ["v2", (f) => set(f.root, "antnest.protocol.version", "v2")],
  ["wrong RPC", (f) => set(f.root, "rpc.method", "session/new")],
  [
    "wrong operation",
    (f) => {
      f.root.operationName = "unrelated";
    },
  ],
  ["wrong error type", (f) => set(f.root, "error.type", "Error")],
  ["wrong code", (f) => set(f.root, "antnest.error.code", "-32020")],
  ["wrong RPC status", (f) => set(f.root, "rpc.response.status_code", -32020)],
  [
    "foreign origin",
    (f) => set(f.root, "antnest.error.origin_span_id", "foreign"),
  ],
  ["false error marker", (f) => set(f.root, "error", false)],
  [
    "extra cause",
    (f) =>
      eventSet(f.root.logs[0], "antnest.error.cause_types", ["ForeignError"]),
  ],
  [
    "forged model code",
    (f) =>
      eventSet(
        f.root.logs[0],
        "antnest.error.code",
        "model_unsupported_content",
      ),
  ],
  [
    "extra event origin",
    (f) => eventSet(f.root.logs[0], "antnest.error.origin_trace_id", "foreign"),
  ],
  [
    "extra warning",
    (f) =>
      f.root.logs.push({
        timestamp: f.root.startTime + 1,
        fields: [{ key: "level", value: "WARN" }],
      }),
  ],
  [
    "duplicate tag",
    (f) => f.root.tags.push({ key: "error.code", value: "-32022" }),
  ],
  ["failed HTTP", (f) => set(f.root, "http.response.status_code", 503)],
  ["wrong HTTP method", (f) => set(f.root, "http.request.method", "GET")],
  ["wrong HTTP route", (f) => set(f.root, "http.route", "/v2/acp")],
  [
    "failed read close",
    (f) => set(f.read, "antnest.mcp.connection.close.outcome", "failed"),
  ],
  [
    "cancelled read caller",
    (f) => set(f.read, "antnest.mcp.caller_cancelled", true),
  ],
  [
    "error before read joined by one ms",
    (f) => {
      f.root.logs[0].timestamp = f.read.startTime + f.read.duration - 1000;
    },
  ],
])
  test(`failed v1 parent does not excuse ${name}`, () => {
    const f = fixture();
    addFailedV1RunResponse(f.root, { http: true });
    mutate(f);
    assert.throws(() =>
      inspect(f, { requestOutcome: "failed-v1-run-response" }),
    );
  });

for (const difference of [1, 999])
  test(`failed v1 parent preserves the original ${difference}us same-Node endpoint`, () => {
    const f = fixture();
    addFailedV1RunResponse(f.root, {
      timestamp: f.read.startTime + f.read.duration - difference,
    });
    const proof = inspect(f, { requestOutcome: "failed-v1-run-response" });
    assert.equal(
      proof.timeObservations.find(
        (row) => row.boundary === "read-before-response-error",
      ).raw_difference_us,
      difference,
    );
  });
for (const difference of [1, 999])
  test(
    "records the independent original response-error endpoint " +
      difference +
      "us",
    () => {
      const f = fixture();
      closedResponse(f, f.read.startTime + f.read.duration - difference);
      const before = structuredClone(f.trace);
      const proof = inspect(f, { requestOutcome: "closed-v1-response" });
      const row = proof.timeObservations.find(
        (r) => r.boundary === "read-before-response-error",
      );
      assert(row);
      assert.equal(row.raw_difference_us, difference);
      assert.equal(row.raw_left_us - row.raw_right_us, difference);
      assert.deepEqual(f.trace, before);
    },
  );
test("response-error comparison rejects exactly one millisecond independently", () => {
  const f = fixture();
  closedResponse(f, f.read.startTime + f.read.duration - 1000);
  assert.throws(() => inspect(f, { requestOutcome: "closed-v1-response" }));
});
test("response-error comparison cannot accumulate a parent-end allowance", () => {
  const f = displaced("read-joined-by-request", 600);
  closedResponse(f, f.root.startTime + f.root.duration - 500);
  assert.throws(() => inspect(f, { requestOutcome: "closed-v1-response" }));
});
test("does not add a parent-end allowance to the original close completion boundary", () => {
  const f = fixture(),
    finish = f.read.startTime + f.read.duration;
  f.closeCompleted.timestamp = finish - 500;
  f.client.duration = finish + 600 - f.client.startTime;
  assert.throws(() => inspect(f));
});

test("Runtime timestamps use their own process clock rather than ACP close time", () => {
  const f = fixture({ runtimeOutcome: "success" });
  for (const span of f.trace.spans.filter((s) => s.processID === "runtime")) {
    span.startTime += 10000000;
    for (const event of span.logs) event.timestamp += 10000000;
  }
  assert.doesNotThrow(() => inspect(f));
});

test("legacy successful initialize and bytes cannot replace parsed-read receipts", () => {
  const f = fixture();
  f.trace.spans = f.trace.spans.filter(
    (s) =>
      s !== f.read &&
      !Object.values(f.handshake).includes(s) &&
      s !== f.executor,
  );
  f.client.references[0].spanID = f.root.spanID;
  assert.throws(() => completedInitializeRead(f.trace, f.server));
});

for (const [name, mutate] of [
  [
    "legacy three events without readiness or dispatch",
    (f) => {
      f.read.logs = f.read.logs.filter(
        (e) => e !== f.discoveryReady && e !== f.readStarted,
      );
    },
  ],
  [
    "missing discovery ready",
    (f) => {
      f.read.logs = f.read.logs.filter((e) => e !== f.discoveryReady);
    },
  ],
  [
    "missing resource dispatch",
    (f) => {
      f.read.logs = f.read.logs.filter((e) => e !== f.readStarted);
    },
  ],
  [
    "duplicate discovery ready",
    (f) => f.read.logs.push(structuredClone(f.discoveryReady)),
  ],
  [
    "content on discovery receipt",
    (f) => eventSet(f.discoveryReady, "content", "private"),
  ],
  [
    "dispatch before ready by one microsecond",
    (f) => {
      f.readStarted.timestamp = f.discoveryReady.timestamp - 1;
    },
  ],
  [
    "ready outside its own read",
    (f) => {
      f.discoveryReady.timestamp = f.read.startTime - 1;
    },
  ],
  [
    "dispatch timestamp before ready despite backend event inventory order",
    (f) => {
      f.read.logs.reverse();
      f.readStarted.timestamp = f.discoveryReady.timestamp - 1;
    },
  ],
  [
    "parent borrowing a discovery-ready event",
    (f) => f.root.logs.push(structuredClone(f.discoveryReady)),
  ],
  [
    "sub-ms Runtime executor overrun",
    (f) => {
      f.executor.duration =
        f.operation.startTime + f.operation.duration + 1 - f.executor.startTime;
    },
  ],
  [
    "sub-ms Runtime operation overrun",
    (f) => {
      f.operation.duration =
        f.server.startTime + f.server.duration + 1 - f.operation.startTime;
    },
  ],
  [
    "cancel outside own CLIENT despite sub-ms close difference",
    (f) => {
      f.client.duration = f.client.logs[0].timestamp - 1 - f.client.startTime;
    },
  ],
  [
    "failed HTTP status on operation",
    (f) => set(f.operation, "http.response.status_code", 503),
  ],
  [
    "failed HTTP status on completion",
    (f) => eventSet(f.operation.logs[0], "http.status_code", "503"),
  ],
  [
    "read missing from raw inventory",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s !== f.read);
    },
  ],
  [
    "missing validated event",
    (f) => {
      f.read.logs = f.read.logs.filter((e) => e !== f.validated);
    },
  ],
  [
    "duplicate validated event",
    (f) => f.read.logs.push(structuredClone(f.validated)),
  ],
  [
    "missing close started",
    (f) => {
      f.read.logs = f.read.logs.filter((e) => e !== f.closeStarted);
    },
  ],
  ["missing close completed", (f) => f.read.logs.pop()],
  [
    "duplicate close completed",
    (f) => f.read.logs.push(structuredClone(f.closeCompleted)),
  ],
  [
    "read failed despite parent200",
    (f) => set(f.read, "antnest.mcp.resource_read.outcome", "failed"),
  ],
  [
    "close failed despite parsed read",
    (f) => set(f.read, "antnest.mcp.connection.close.outcome", "failed"),
  ],
  [
    "close event contradicts span",
    (f) => eventSet(f.closeCompleted, "outcome", "failed"),
  ],
  [
    "caller cancelled before close",
    (f) => eventSet(f.closeStarted, "antnest.mcp.caller_cancelled", true),
  ],
  [
    "caller cancelled during close",
    (f) => set(f.read, "antnest.mcp.caller_cancelled", true),
  ],
  [
    "read execution mismatch",
    (f) => set(f.read, "antnest.runtime.execution.id", "other"),
  ],
  [
    "operation execution mismatch",
    (f) => set(f.operation, "antnest.runtime.execution.id", "other"),
  ],
  [
    "handshake execution mismatch",
    (f) => set(f.handshake.server, "antnest.runtime.execution.id", "other"),
  ],
  [
    "handshake Agent mismatch",
    (f) => set(f.handshake.server, "antnest.agent.id", "other"),
  ],
  [
    "different Runtime generation",
    (f) => set(f.handshake.operation, "antnest.runtime.generation", "2"),
  ],
  [
    "cancellation before owning close",
    (f) => {
      f.client.logs[0].timestamp = f.closeStarted.timestamp - 1000;
    },
  ],
  [
    "resource started after its parsed receipt",
    (f) => {
      f.client.startTime = f.root.startTime + 65000;
      f.client.duration = 10000;
    },
  ],
  [
    "resource not joined at close completion",
    (f) => {
      f.client.duration = 53000;
    },
  ],
  [
    "operation completion precedes executor",
    (f) => {
      f.operation.logs[0].timestamp =
        f.executor.startTime + f.executor.duration - 1000;
    },
  ],
  [
    "parent RPC rejection without ERROR",
    (f) => set(f.root, "rpc.response.status_code", -32020),
  ],
  [
    "unclassified stream termination event",
    (f) => {
      f.root.logs.push({
        timestamp: f.root.startTime + 95000,
        fields: [
          { key: "event", value: "antnest.stream.termination" },
          { key: "reason", value: "revoked" },
        ],
      });
    },
  ],
  [
    "executor completion borrowed from sibling",
    (f) => eventSet(f.executor.logs[0], "span_id", "other"),
  ],
  ["executor failed exit code", (f) => set(f.executor, "process.exit.code", 1)],
  [
    "executor failed exit classification",
    (f) => set(f.executor, "executor.exit.classification", "failed"),
  ],
  [
    "Runtime protocol error code without ERROR",
    (f) => set(f.operation, "jsonrpc.error_code", -32001),
  ],
  [
    "cancellation after owning close",
    (f) => {
      f.client.logs[0].timestamp = f.closeCompleted.timestamp + 1;
    },
  ],
  [
    "validated after close starts",
    (f) => {
      f.validated.timestamp = f.closeStarted.timestamp + 1;
    },
  ],
  [
    "close outside read",
    (f) => {
      f.closeCompleted.timestamp = f.read.startTime + f.read.duration + 1;
    },
  ],
  [
    "foreign ACP process",
    (f) => {
      f.trace.processes.other = structuredClone(f.trace.processes.acp);
      f.client.processID = "other";
    },
  ],
  [
    "foreign read process",
    (f) => {
      f.trace.processes.other = structuredClone(f.trace.processes.acp);
      f.read.processID = "other";
    },
  ],
  [
    "foreign Runtime operation process",
    (f) => {
      f.trace.processes.other = structuredClone(f.trace.processes.runtime);
      f.operation.processID = "other";
    },
  ],
  [
    "extra HTTP client",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.client),
        spanID: "extra-client",
      }),
  ],
  [
    "missing handshake",
    (f) => {
      f.trace.spans = f.trace.spans.filter(
        (s) => !Object.values(f.handshake).includes(s),
      );
    },
  ],
  [
    "missing resource server",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s !== f.server);
    },
  ],
  [
    "duplicate resource method",
    (f) => set(f.handshake.server, "rpc.method", "resources/read"),
  ],
  [
    "executable Runtime method",
    (f) => set(f.server, "rpc.method", "tools/call"),
  ],
  [
    "extra Runtime executable child",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.executor),
        operationName: "runtime.mcp.tool",
        spanID: "extra-tool",
      }),
  ],
  [
    "missing executor",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s !== f.executor);
    },
  ],
  [
    "client belongs to sibling read",
    (f) => {
      f.trace.spans.push({
        ...structuredClone(f.read),
        spanID: "sibling-read",
      });
      f.client.references[0].spanID = "sibling-read";
    },
  ],
  [
    "cancellation borrowed from handshake",
    (f) => {
      f.handshake.client.logs = f.client.logs;
      f.client.logs = [];
    },
  ],
  ["unknown read diagnostic", (f) => set(f.read, "exception.type", "Failure")],
  [
    "unknown close event diagnostic",
    (f) => eventSet(f.closeCompleted, "exception.type", "Failure"),
  ],
  [
    "contradictory handshake outcome",
    (f) => set(f.handshake.client, "antnest.outcome", "error"),
  ],
  [
    "contradictory operation status",
    (f) => set(f.operation, "otel.status_code", 2),
  ],
  [
    "extra completion diagnostic",
    (f) => eventSet(f.completion, "antnest.result", "failed"),
  ],
  [
    "duplicate read field",
    (f) =>
      f.read.tags.push({ key: "antnest.mcp.caller_cancelled", value: false }),
  ],
  [
    "duplicate close field",
    (f) => f.closeCompleted.fields.push({ key: "outcome", value: "closed" }),
  ],
  [
    "missing client cancellation",
    (f) => {
      f.client.logs = [];
    },
  ],
  [
    "wrong Runtime completion identity",
    (f) => eventSet(f.completion, "span_id", "foreign"),
  ],
  [
    "wrong response byte count",
    (f) => set(f.client, "http.response.body.size", 424),
  ],
]) {
  test("read proof rejects " + name, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });
}

test("fully completed client EOF cannot explain a canceled Runtime response", () => {
  const f = fixture({ clientOutcome: "success" });
  assert.throws(() => inspect(f));
});
