import assert from "node:assert/strict";
import test from "node:test";
import {
  runtimeCancellationBusinessFixture,
  addSDKClosedMetadata,
} from "./resolve-cache-runtime-cancellation-business-fixtures.mjs";
import {
  fields,
  set,
} from "./resolve-cache-runtime-cancellation-clock-fixtures.mjs";
import { inspectOutageRuntimeCancellation } from "./resolve-cache-runtime-cancellation.mjs";
const inspect = (f) =>
  inspectOutageRuntimeCancellation(f.evidence, f.collection, []);

function joinedCancelFixture(delta = 8) {
  const f = runtimeCancellationBusinessFixture();
  const cancelEnd = f.cancel.startTime + f.cancel.duration;
  f.run.duration = cancelEnd + delta - f.run.startTime;
  f.cancelApplication.duration =
    cancelEnd + 999 - f.cancelApplication.startTime;
  return f;
}

for (const delta of [8, 999])
  test(`same-process awaited Run join preserves ${delta}us cross-Trace end inversion`, () => {
    const f = joinedCancelFixture(delta);
    const before = structuredClone({
      trace: f.trace,
      cancelTrace: f.cancelTrace,
    });
    const r = inspect(f);
    assert.deepEqual(r.timing.node_cancel_join_quantization, [
      {
        trace_id: f.trace.traceID,
        span_id: f.run.spanID,
        cancel_trace_id: f.cancelTrace.traceID,
        cancel_span_id: f.cancel.spanID,
        application_span_id: f.cancelApplication.spanID,
        relation: "awaited-run-completion",
        raw_end_delta_us: delta,
        resolution_us: 1000,
      },
    ]);
    assert.deepEqual({ trace: f.trace, cancelTrace: f.cancelTrace }, before);
    assert.equal(r.strict_trace, "failed");
  });

test("the joined terminal SQL records its own bounded difference without stacking allowances", () => {
  const f = joinedCancelFixture(8);
  const cancelEnd = f.cancel.startTime + f.cancel.duration;
  f.finish.duration = cancelEnd + 5 - f.finish.startTime;
  const r = inspect(f);
  assert.deepEqual(
    r.timing.node_cancel_join_quantization.map((row) => [
      row.relation,
      row.raw_end_delta_us,
    ]),
    [
      ["awaited-run-completion", 8],
      ["awaited-run-terminal-sql", 5],
    ],
  );
  f.finish.duration = cancelEnd + 1000 - f.finish.startTime;
  assert.throws(
    () => inspect(f),
    /Run completion outlived internal cancellation/u,
  );
});

for (const [name, change] of [
  ["whole millisecond", (f) => (f.run.duration += 992)],
  ["noninteger Run anchor", (f) => f.run.startTime++],
  ["noninteger cancel anchor", (f) => f.cancel.startTime++],
  ["noninteger application anchor", (f) => f.cancelApplication.startTime++],
  [
    "application does not cover Run",
    (f) => (f.cancelApplication.duration -= 1000),
  ],
  [
    "missing application",
    (f) =>
      (f.cancelTrace.spans = f.cancelTrace.spans.filter(
        (s) => s !== f.cancelApplication,
      )),
  ],
  ["detached application", (f) => (f.cancelApplication.references = [])],
  [
    "wrong application Session",
    (f) => set(f.cancelApplication, "antnest.session.id", "other"),
  ],
  [
    "wrong application Agent",
    (f) => set(f.cancelApplication, "antnest.agent.id", "other"),
  ],
  [
    "failed application",
    (f) => set(f.cancelApplication, "antnest.outcome", "error"),
  ],
  [
    "different ACP process",
    (f) => set(f.cancelTrace.processes.other, "service.instance.id", "other:1"),
  ],
])
  test(`awaited Run end inversion rejects ${name}`, () => {
    const f = joinedCancelFixture();
    change(f);
    assert.throws(() => inspect(f));
  });

test("actual cancel application retains the observed 586us joined-end representation", () => {
  const f = runtimeCancellationBusinessFixture();
  f.cancelApplication.duration =
    f.cancel.startTime +
    f.cancel.duration +
    586 -
    f.cancelApplication.startTime;
  const before = structuredClone(f.cancelTrace);
  const r = inspect(f);
  assert.deepEqual(r.cancel_time_observations, [
    {
      trace_id: f.cancelTrace.traceID,
      span_id: f.cancelApplication.spanID,
      parent_span_id: f.cancel.spanID,
      raw_end_difference_us: 586,
      reason: "same-node-sdk-sub-ms-joined-end",
    },
  ]);
  assert.deepEqual(f.cancelTrace, before);
  assert.equal(r.strict_trace, "failed");
});
for (const [name, change] of [
  ["whole millisecond", (f) => (f.cancelApplication.duration += 414)],
  ["non-integer-ms child anchor", (f) => f.cancelApplication.startTime++],
  ["foreign ACP process", (f) => (f.cancelApplication.processID = "consumer")],
  ["missing dispatch parent", (f) => (f.cancelApplication.references = [])],
  [
    "starts before dispatch",
    (f) => (f.cancelApplication.startTime = f.cancel.startTime - 1000),
  ],
])
  test(`actual cancel application rejects ${name}`, () => {
    const f = runtimeCancellationBusinessFixture();
    f.cancelApplication.duration =
      f.cancel.startTime +
      f.cancel.duration +
      586 -
      f.cancelApplication.startTime;
    change(f);
    assert.throws(() => inspect(f));
  });
test("audit joined-end representation records sub-ms evidence and rejects a whole millisecond", () => {
  const f = runtimeCancellationBusinessFixture(),
    a = f.audits[1],
    sql = a.trace.spans.find((s) => s.spanID === "audit-sql");
  sql.duration = a.server.startTime + a.server.duration + 999 - sql.startTime;
  const before = structuredClone(a.trace),
    r = inspect(f);
  assert.equal(r.audit_time_observations.length, 1);
  assert.equal(r.audit_time_observations[0].raw_end_difference_us, 999);
  assert.deepEqual(a.trace, before);
  sql.duration++;
  assert.throws(() => inspect(f), /outlived its owning operation/u);
});
for (const [name, change] of [
  [
    "audit SQL starts before owner",
    (f) => {
      f.audits[1].trace.spans.find((s) => s.spanID === "audit-sql").startTime =
        f.audits[1].server.startTime - 2000;
    },
  ],
  [
    "audit SQL outlives owner",
    (f) => {
      f.audits[1].trace.spans.find((s) => s.spanID === "audit-sql").duration +=
        10000;
    },
  ],
  [
    "audit CLIENT foreign service",
    (f) => {
      f.audits[1].client.processID = "acp";
    },
  ],
  ...[
    ["span.kind", "server"],
    ["http.request.method", "GET"],
    ["http.response.status_code", 204],
  ].map(([key, value]) => [
    `audit CLIENT ${key}`,
    (f) => set(f.audits[1].client, key, value),
  ]),
  ...[
    ["db.response.status_code", "ERROR"],
    ["antnest.operation.phase", "unexpected"],
    ["antnest.result", "ok"],
  ].map(([key, value]) => [
    `EOF metadata CLIENT ${key}`,
    (f) => set(f.first.client, key, value),
  ]),
])
  test(`cancellation review rejects ${name}`, () => {
    const f = runtimeCancellationBusinessFixture();
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });
for (const [name, change] of [
  [
    "prompt ACK from another ACP process",
    (f) => {
      f.trace.processes.otherACP = structuredClone(f.trace.processes.acp);
      f.promptAck.processID = "otherACP";
    },
  ],
  [
    "audit readiness substituted for the business query",
    (f) => {
      set(
        f.audits[1].trace.spans.find((s) => s.spanID === "audit-sql"),
        "db.query.text",
        "SELECT 1",
      );
    },
  ],
  [
    "audit query without organization and Run predicates",
    (f) => {
      set(
        f.audits[1].trace.spans.find((s) => s.spanID === "audit-sql"),
        "db.query.text",
        "SELECT * FROM runs",
      );
    },
  ],
])
  test(`actual Runtime cancellation rejects ${name}`, () => {
    const f = runtimeCancellationBusinessFixture();
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });
for (const [key, value] of [
  ["http.request.method", "GET"],
  ["http.route", "/wrong"],
  ["http.response.status_code", 204],
])
  test(`actual Runtime cancellation rejects prompt ACK ${key}`, () => {
    const f = runtimeCancellationBusinessFixture();
    inspect(f);
    set(f.promptAck, key, value);
    assert.throws(() => inspect(f));
  });
test("actual ACP audit retains its successful postgres readiness span alongside driver SQL", () => {
  const f = runtimeCancellationBusinessFixture();
  const a = f.audits[1],
    ready = structuredClone(a.server);
  ready.spanID = "postgres-ready";
  ready.operationName = "postgres.ready";
  ready.references = [
    { refType: "CHILD_OF", traceID: a.trace.traceID, spanID: a.server.spanID },
  ];
  ready.tags = fields({
    "span.kind": "internal",
    "db.system.name": "postgresql",
  });
  a.trace.spans.push(ready);
  const readinessSQL = structuredClone(
    a.trace.spans.find((s) => s.spanID === "audit-sql"),
  );
  readinessSQL.spanID = "readiness-sql";
  readinessSQL.references[0].spanID = ready.spanID;
  set(readinessSQL, "db.query.text", "SELECT 1");
  a.trace.spans.push(readinessSQL);
  inspect(f);
  set(ready, "error", true);
  assert.throws(() => inspect(f));
});
test("successful metadata SDK close remains separate from held cancellation and EOF clock samples", () => {
  const f = runtimeCancellationBusinessFixture(),
    m = addSDKClosedMetadata(f),
    r = inspect(f);
  assert.equal(r.metadata_receipts.length, 1);
  assert.equal(r.metadata_receipts[0].clock_sample, false);
  assert(
    !r.timing.clock_samples.some((s) => s.client_span_id === m.client.spanID),
  );
  assert.equal(r.owned_error_spans.length, 6);
});
for (const [name, change] of [
  [
    "foreign ACP HTTP parent",
    (f) => {
      f.ack.processID = "consumer";
    },
  ],
  [
    "metadata extra transport error",
    (_f, m) => set(m.client, "http.transport.error.type", "UnexpectedError"),
  ],
  [
    "metadata extra protocol failure",
    (_f, m) => set(m.client, "antnest.protocol.outcome", "error"),
  ],
  [
    "metadata extra rpc error",
    (_f, m) => set(m.client, "rpc.error.type", "UnexpectedError"),
  ],
  [
    "metadata request cancellation",
    (_f, m) => set(m.client, "antnest.http.request_cancelled", true),
  ],
  [
    "metadata executor cancelled",
    (_f, m) => set(m.executor, "executor.exit.classification", "canceled"),
  ],
  [
    "metadata executor signal",
    (_f, m) => set(m.executor, "executor.exit.signal", 9),
  ],
  [
    "metadata executor foreign event",
    (_f, m) => {
      m.executor.logs[0].fields.find((x) => x.key === "span_id").value =
        "another";
    },
  ],
  [
    "metadata executor foreign Agent",
    (_f, m) => {
      set(m.executor, "antnest.agent.id", "other");
      m.executor.logs[0].fields.find(
        (x) => x.key === "antnest.agent.id",
      ).value = "other";
    },
  ],
  [
    "metadata missing executor completion",
    (_f, m) => {
      m.executor.logs = [];
    },
  ],
  [
    "metadata failed protocol",
    (_f, m) => set(m.server, "antnest.protocol.outcome", "error"),
  ],
  [
    "metadata unequal bytes",
    (_f, m) => set(m.client, "http.response.body.size", 43),
  ],
  [
    "metadata zero bytes",
    (_f, m) => {
      set(m.client, "http.response.body.size", 0);
      set(m.server, "http.response.body.size", 0);
    },
  ],
  [
    "metadata substituted tools call",
    (_f, m) => {
      set(m.server, "rpc.method", "tools/call");
      set(m.operation, "rpc.method", "tools/call");
    },
  ],
  [
    "metadata extra event",
    (_f, m) => m.client.logs.push(structuredClone(m.client.logs[0])),
  ],
  [
    "metadata duplicate field",
    (_f, m) => m.client.tags.push({ ...m.client.tags[0] }),
  ],
])
  test(`actual Runtime cancellation rejects ${name}`, () => {
    const f = runtimeCancellationBusinessFixture(),
      m = addSDKClosedMetadata(f);
    inspect(f);
    change(f, m);
    assert.throws(() => inspect(f));
  });
test("actual single-model held bash cancellation binds HTTP, Run, stored snapshot and Runtime process", () => {
  const f = runtimeCancellationBusinessFixture(),
    before = structuredClone({
      evidence: f.evidence,
      collection: f.collection,
    }),
    r = inspect(f);
  assert.equal(r.status, "passed");
  assert.equal(r.runtime_calls, 1);
  assert.equal(r.provider_requests, 1);
  assert.equal(r.owned_error_spans.length, 6);
  assert.equal(r.otel_error_spans.length, 5);
  assert.equal(r.transport_receipts.length, 2);
  assert.equal(r.strict_trace, "failed");
  assert.equal(r.business.runtime_quiescent, true);
  assert.deepEqual({ evidence: f.evidence, collection: f.collection }, before);
});
for (const [name, change] of [
  [
    "retired policy",
    (f) => {
      f.evidence.policy_revision = 3;
    },
  ],
  [
    "retired transport",
    (f) => {
      f.evidence.transport = "websocket";
    },
  ],
  [
    "missing raw cancellation",
    (f) => f.collection.traces.delete(f.cancelTrace.traceID),
  ],
  [
    "unarchived cancellation",
    (f) => f.collection.archivedTraceIDs.delete(f.cancelTrace.traceID),
  ],
  [
    "missing actual HTTP prompt",
    (f) => {
      f.evidence.http = f.evidence.http.filter((r) => r !== f.evidence.prompt);
    },
  ],
  [
    "mutated actual HTTP cancel",
    (f) => {
      f.evidence.cancel = { ...f.evidence.cancel, status: 202 };
    },
  ],
  [
    "another credential",
    (f) => {
      f.evidence.cancel.credential_scope = "other";
    },
  ],
  [
    "another Principal",
    (f) => {
      f.evidence.http[0].body.principal.user_id = "other";
    },
  ],
  [
    "another Runtime image",
    (f) =>
      set(
        f.trace.processes.runtime,
        "antnest.runtime.image.id",
        "sha256:" + "c".repeat(64),
      ),
  ],
  [
    "changed Runtime generation",
    (f) => {
      f.evidence.runtime.quiescent.status.generation = 2;
    },
  ],
  [
    "unproved Runtime generation",
    (f) => {
      delete f.evidence.runtime.started.status.generation;
    },
  ],
  [
    "foreign Runtime status Agent",
    (f) => {
      f.evidence.runtime.started.status.agent_id = "other";
    },
  ],
  [
    "Runtime still alive",
    (f) => {
      f.evidence.runtime.quiescent.work.processes =
        f.evidence.runtime.started.work.processes;
    },
  ],
  [
    "changed stored snapshot",
    (f) => {
      f.evidence.run_storage.after.record.snapshot_sha256 = "1".repeat(64);
    },
  ],
  [
    "different durable Run",
    (f) => {
      f.evidence.run_storage.after.record.run_id = "other";
    },
  ],
  [
    "different audit Principal",
    (f) => {
      f.evidence.audit.body.principal_id = "other";
    },
  ],
  [
    "different cancel Session",
    (f) => set(f.cancel, "antnest.session.id", "other"),
  ],
  [
    "detached cancel execution",
    (f) => {
      f.cancel.references[0].spanID = f.cancelHTTP.root.spanID;
    },
  ],
  [
    "failed public cancellation",
    (f) => set(f.cancelHTTP.root, "http.response.status_code", 503),
  ],
  [
    "wrong cancellation Resolve profile",
    (f) =>
      set(f.cancelHTTP.decision, "antnest.identity.resolve.profile", "acp"),
  ],
  [
    "foreign audit organization",
    (f) => set(f.audits[1].server, "antnest.organization.id", "other"),
  ],
  [
    "failed audit SQL",
    (f) =>
      set(
        f.audits[1].trace.spans.find((s) => s.spanID === "audit-sql"),
        "error",
        true,
      ),
  ],
  [
    "second model request",
    (f) =>
      f.evidence.model_cancelled.state.requests.push({
        ...f.evidence.model_cancelled.state.requests[0],
      }),
  ],
  [
    "model disconnect substituted",
    (f) => {
      for (const o of [f.evidence.model_started, f.evidence.model_cancelled])
        o.state.requests[0].disconnected = true;
    },
  ],
  [
    "wrong model trace",
    (f) => {
      for (const o of [f.evidence.model_started, f.evidence.model_cancelled])
        o.state.requests[0].trace_id = "1".repeat(32);
    },
  ],
  ["failed model", (f) => set(f.model, "antnest.outcome", "error")],
  [
    "missing model response body",
    (f) => set(f.modelHTTP, "http.response.body.size", 0),
  ],
  [
    "second Runtime Tool",
    (f) => {
      const s = structuredClone(f.server);
      s.spanID = "another";
      f.trace.spans.push(s);
    },
  ],
  [
    "unrelated non-ERROR diagnostic",
    (f) => set(f.finish, "jsonrpc.error_code", -32603),
  ],
  [
    "unrelated cancellation event",
    (f) => {
      f.model.logs = [
        {
          timestamp: f.model.startTime,
          fields: fields({ event: "antnest.cancelled" }),
        },
      ];
    },
  ],
])
  test(`actual Runtime cancellation rejects ${name}`, () => {
    const f = runtimeCancellationBusinessFixture();
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });
