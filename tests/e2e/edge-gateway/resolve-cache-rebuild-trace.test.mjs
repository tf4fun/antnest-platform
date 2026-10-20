import assert from "node:assert/strict";
import test from "node:test";
import { inspectRebuildPreparation } from "./resolve-cache-rebuild-trace.mjs";
import { rebuildTraceFixture } from "./resolve-cache-rebuild-trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

const inspect = (f) =>
  inspectRebuildPreparation(f.evidence, f, ["rebuild-private-canary"]);
const p = (f) => f.evidence.recovery_preparation;
const remove = (f, span) => {
  f.command.trace.spans = f.command.trace.spans.filter((s) => s !== span);
};

for (const status of [202, 503]) {
  for (const early of [false, true]) {
    if (status === 202 && early) continue;
    test(`Rebuild ${status} with ${early ? "early operation absence" : "immediate journal"} requires committed completion and physical replacement`, () => {
      const f = rebuildTraceFixture({ status, early });
      f.command.workflow.warnings = ["raw SDK clock warning"];
      p(f).status = "failed"; // A previous verdict is never an oracle.
      const memory = structuredClone({ e: f.evidence, traces: f.traces });
      const result = inspect(f);
      assert.equal(result.status, "passed");
      assert.equal(result.request_id, f.requestID);
      assert.equal(result.original_run_id, "run");
      assert.equal(result.settlement, "runtime_barrier_required");
      assert.equal(result.runtime_target_revision, "runtime-new");
      assert.equal(result.activities.length, 6);
      assert.equal(
        result.owned_error_spans.length,
        (status === 503 ? 6 : 0) + (early ? 4 : 0),
      );
      assert.equal(result.strict_trace, "failed");
      assert.equal(result.warning_count, 1);
      assert.deepEqual({ e: f.evidence, traces: f.traces }, memory);
    });
  }
}

for (const [name, change] of [
  [
    "missing preparation",
    (f) => {
      delete f.evidence.recovery_preparation;
    },
  ],
  [
    "passed marker without inputs",
    (f) => {
      f.evidence.recovery_preparation = { status: "passed" };
    },
  ],
  [
    "different idempotency key",
    (f) => {
      p(f).request.idempotency_key = "different-key";
    },
  ],
  [
    "different completed request",
    (f) => {
      p(f).operation.body.request_id = "different-request";
    },
  ],
  [
    "different completed Agent",
    (f) => {
      p(f).operation.body.agent_id = "foreign";
    },
  ],
  [
    "different lifecycle kind",
    (f) => {
      p(f).receipt.body.kind = "enable";
    },
  ],
  [
    "different administrator credential",
    (f) => {
      p(f).command.credential_scope = "foreign";
    },
  ],
  [
    "inactive administrator",
    (f) => {
      f.admin.body.principal.active = false;
    },
  ],
  [
    "member impersonating administrator",
    (f) => {
      f.admin.body.principal.organization_role = "member";
    },
  ],
  [
    "foreign administrator organization",
    (f) => {
      f.admin.body.principal.organization_id = "foreign";
    },
  ],
  [
    "second command",
    (f) => {
      p(f).receipt.method = "POST";
    },
  ],
  [
    "missing actual HTTP receipt",
    (f) => {
      f.evidence.http = f.evidence.http.filter((r) => r !== p(f).command);
    },
  ],
  [
    "missing archived trace",
    (f) => {
      f.archivedTraceIDs.delete(p(f).command.trace_id);
    },
  ],
  [
    "duplicate actual HTTP trace",
    (f) => {
      f.evidence.http.push(p(f).command);
    },
  ],
  [
    "incomplete preparation",
    (f) => {
      p(f).receipt.body.state = "preparing";
    },
  ],
  [
    "failed operation",
    (f) => {
      p(f).operation.body.state = "failed";
    },
  ],
  [
    "unfinished operation phase",
    (f) => {
      p(f).operation.body.phase = "publish";
    },
  ],
  [
    "operation returned an error",
    (f) => {
      p(f).operation.body.error_code = "update_failed";
    },
  ],
  [
    "unchanged physical container",
    (f) => {
      p(f).runtime.container.id = f.evidence.runtime.container.id;
    },
  ],
  [
    "foreign volume",
    (f) => {
      p(f).runtime.container.volume = "foreign";
    },
  ],
  [
    "unchanged runtime execution",
    (f) => {
      p(f).runtime.runtime_execution_id =
        f.evidence.runtime.runtime_execution_id;
    },
  ],
  [
    "unhealthy replacement",
    (f) => {
      p(f).runtime.container.health = "unhealthy";
    },
  ],
  [
    "lost workspace effects",
    (f) => {
      p(f).runtime.observation.work.effects = "";
    },
  ],
  [
    "missing physical observation",
    (f) => {
      p(f).runtime.observations = [];
    },
  ],
  [
    "replaced original Run",
    (f) => {
      p(f).after.run.body.run_id = "replacement";
    },
  ],
  [
    "changed original storage",
    (f) => {
      p(f).after.stored.record.snapshot_sha256 = "b".repeat(64);
    },
  ],
  [
    "lost original audit event",
    (f) => {
      p(f).after.events.body.items = [];
    },
  ],
  [
    "truncated original inventory",
    (f) => {
      p(f).after.inventory.body.next_cursor = "more";
    },
  ],
  [
    "different template",
    (f) => {
      p(f).ready.body.configuration.template.revision = 2;
    },
  ],
  [
    "missing workflow parent",
    (f) => {
      f.command.workflow.references[0].spanID = "missing";
    },
  ],
  [
    "different workflow",
    (f) =>
      setTag(f.command.workflow, "temporalWorkflowID", "agent-rebuild/other"),
  ],
  [
    "interrupted workflow",
    (f) =>
      setTag(
        f.command.workflow,
        "antnest.temporal.workflow.span_end",
        "worker_shutdown",
      ),
  ],
  [
    "different Temporal run",
    (f) =>
      setTag(f.command.activities.drain.activity, "temporalRunID", "other"),
  ],
  [
    "missing admission COMMIT",
    (f) => remove(f, f.command.activities.admit_lifecycle.commit),
  ],
  [
    "missing completed SQL",
    (f) => remove(f, f.command.activities.publish.writes[3]),
  ],
  [
    "failed publication CAS",
    (f) =>
      setTag(f.command.activities.publish.writes[0], "pgx.rows_affected", 0),
  ],
  [
    "read-only phase transaction",
    (f) =>
      setTag(
        f.command.activities.network_fence.writes[0],
        "db.query.text",
        "SELECT 1",
      ),
  ],
  [
    "unbounded drain",
    (f) => {
      const s = f.command.activities.drain.writes[0];
      setTag(
        s,
        "db.query.text",
        s.tags
          .find((t) => t.key === "db.query.text")
          .value.replace("AND drain_deadline_at > clock_timestamp() ", ""),
      );
    },
  ],
  [
    "SQL error",
    (f) =>
      setTag(
        f.command.activities.drain.writes[0],
        "error.type",
        "database_error",
      ),
  ],
  [
    "rolled back phase",
    (f) =>
      setTag(
        f.command.activities.runtime_update.transaction,
        "antnest.transaction.outcome",
        "rolled_back",
      ),
  ],
  [
    "SQL outside transaction",
    (f) => {
      f.command.activities.publish.commit.startTime += 100000;
    },
  ],
  [
    "settlement before snapshot",
    (f) => {
      f.command.activities.drain.settled.client.startTime -= 4000;
    },
  ],
  [
    "wrong settlement revision",
    (f) =>
      setTag(
        f.command.activities.drain.settled.server,
        "antnest.configuration.revision",
        99,
      ),
  ],
  [
    "settlement for another request",
    (f) =>
      setTag(
        f.command.activities.drain.settled.client,
        "antnest.operation.id",
        "foreign",
      ),
  ],
  [
    "settled substituted for required barrier",
    (f) =>
      setTag(
        f.command.activities.drain.settled.server,
        "antnest.settlement.outcome",
        "settled",
      ),
  ],
  [
    "different Runtime target",
    (f) =>
      setTag(
        f.command.activities.runtime_update.execution,
        "antnest.runtime.target_revision",
        "foreign",
      ),
  ],
  [
    "different Runtime child command",
    (f) =>
      setTag(
        f.command.activities.runtime_update.rpc.client,
        "antnest.operation.request_id",
        "foreign",
      ),
  ],
  [
    "Runtime completion without COMMIT",
    (f) => remove(f, f.command.activities.runtime_update.completed.commit),
  ],
  [
    "404 with a present operation",
    (f) => setTag(f.absent.read, "pgx.rows_affected", 1),
  ],
  [
    "404 after operation insertion",
    (f) => {
      f.absent.read.startTime =
        f.command.activities.admit_lifecycle.writes[1].startTime + 1;
    },
  ],
  [
    "404 from different Controller process",
    (f) => {
      f.absent.trace.processes.controller.tags = fields({
        "host.name": "controller-host",
        "process.pid": 1,
        "service.instance.id": "restarted",
      });
    },
  ],
  [
    "404 with unexpected SQL",
    (f) => {
      f.absent.sql(
        f.absent.controllerServer,
        "SELECT 1",
        1,
        f.absent.read.startTime + 100,
      );
    },
  ],
  [
    "404 with other failure",
    (f) =>
      setTag(
        f.absent.controllerServer,
        "antnest.error.code",
        "organization_not_found",
      ),
  ],
  [
    "completed read before commit",
    (f) => {
      f.final.read.startTime =
        f.command.activities.publish.commit.startTime - 1;
    },
  ],
  [
    "completed read has a different raw request",
    (f) => setTag(f.final.controllerServer, "antnest.operation.id", "other"),
  ],
  [
    "completed read changed state",
    (f) =>
      setTag(
        f.final.read,
        "db.query.text",
        "UPDATE agent_controller.agent_lifecycle_operations SET state='completed'",
      ),
  ],
  [
    "unknown successful HTTP error metadata",
    (f) => setTag(f.receipt.root, "antnest.error.code", "hidden_error"),
  ],
  [
    "secret in raw trace",
    (f) => setTag(f.command.workflow, "debug", "rebuild-private-canary"),
  ],
  [
    "captured request payload",
    (f) => {
      f.command.workflow.logs.push({
        fields: fields({
          event: "antnest.request",
          "antnest.payload.json": "{}",
        }),
      });
    },
  ],
  [
    "captured SQL arguments",
    (f) => setTag(f.absent.read, "db.query.parameters", "[]"),
  ],
]) {
  test(`Rebuild ownership rejects ${name} even with an injected passed marker`, () => {
    const f = rebuildTraceFixture();
    p(f).status = "passed";
    change(f);
    assert.throws(() => inspect(f));
  });
}

for (const name of [
  "root",
  "consoleClient",
  "consoleServer",
  "controllerClient",
  "controllerServer",
  "update",
]) {
  for (const mutation of [
    "missing error",
    "extra error tag",
    "extra exception",
    "duplicate field",
  ]) {
    test(`Rebuild timeout rejects ${name}: ${mutation}`, () => {
      const f = rebuildTraceFixture(),
        span = f.command[name];
      if (mutation === "missing error") {
        span.logs = [];
        span.tags = span.tags.filter(
          ({ key }) =>
            !/^(error|exception|antnest\.error|otel\.status)/u.test(key),
        );
      }
      if (mutation === "extra error tag")
        setTag(span, "exception.type", "UnexpectedDatabaseError");
      if (mutation === "extra exception")
        span.logs.push({
          timestamp: span.startTime,
          fields: fields({ event: "exception", "exception.type": "extra" }),
        });
      if (mutation === "duplicate field") span.tags.push({ ...span.tags[0] });
      assert.throws(() => inspect(f));
    });
  }
}

for (const [key, value] of [
  ["antnest.result", "failed"],
  ["antnest.outcome", "failed"],
  ["antnest.stream.termination", "access_denied"],
  ["antnest.cancellation.reason", "different-operation"],
]) {
  test(`Rebuild cancellation rejects unrelated ${key} on an otherwise claimed span`, () => {
    const f = rebuildTraceFixture();
    setTag(f.command.root, key, value);
    assert.throws(() => inspect(f));
  });
}

test("Runtime completion cannot precede the same operation's admission commit", () => {
  const f = rebuildTraceFixture(),
    a = f.command.activities.runtime_update;
  for (const s of [
    a.completed.transaction,
    a.completed.begin,
    ...a.completed.writes,
    a.completed.commit,
  ])
    s.startTime -= 7000;
  assert.throws(() => inspect(f));
});

for (const label of [
  "recovery-rebuild-ready",
  "recovery-rebuild-before-events",
]) {
  test(`Rebuild rejects a different Console GET route for ${label}`, () => {
    const f = rebuildTraceFixture();
    const r = f.parts.find((r) => r.row.label === label);
    setTag(
      r.consoleServer,
      "http.route",
      "/api/admin/execution-audits/{run_id}",
    );
    assert.throws(() => inspect(f));
  });
}
for (const [name, change] of [
  [
    "last response rotated credential",
    (row) => {
      row.set_cookie_count = 1;
    },
  ],
  [
    "cached response",
    (row) => {
      row.cache_control = "public";
    },
  ],
  [
    "mixed public cache directive",
    (row) => {
      row.cache_control = "no-store, public";
    },
  ],
]) {
  test(`Rebuild rejects ${name}`, () => {
    const f = rebuildTraceFixture();
    change(p(f).after.inventory);
    assert.throws(() => inspect(f));
  });
}

test("clean 202 never inherits timeout error admission", () => {
  const f = rebuildTraceFixture({ status: 202, early: false });
  setTag(f.command.update, "error", true);
  assert.throws(() => inspect(f));
});

test("successful 202 admission cannot be followed by an absent operation in the same Controller instance", () => {
  const f = rebuildTraceFixture({ status: 202, early: true });
  assert.throws(() => inspect(f));
});

test("successful 202 requires the admission commit before update completion", () => {
  const f = rebuildTraceFixture({ status: 202, early: false });
  f.command.update.duration = 1000;
  assert.throws(() => inspect(f));
});

test("Runtime admission retains its actual serializable transaction isolation", () => {
  const f = rebuildTraceFixture();
  setTag(
    f.command.activities.runtime_update.started.begin,
    "db.query.text",
    "begin isolation level serializable",
  );
  assert.equal(inspect(f).status, "passed");
});

test("Runtime completion rejects a transaction with downgraded isolation", () => {
  const f = rebuildTraceFixture();
  setTag(
    f.command.activities.runtime_update.completed.begin,
    "db.query.text",
    "begin",
  );
  assert.throws(() => inspect(f));
});

test("Rebuild retains a nested configuration publication's SQL while requiring its owning phase commit", () => {
  const f = rebuildTraceFixture(),
    c = f.command;
  const a = c.activities.admit_lifecycle.activity;
  const publication = c.add(
    "agent_controller.configuration.publish",
    "controller",
    a,
    { "span.kind": "internal" },
    a.startTime + 1000,
    10000,
  );
  c.tx(publication, ["SELECT 1"], publication.startTime + 1000);
  assert.equal(inspect(f).status, "passed");
});

for (const status of [200, "200"]) {
  test(`Rebuild preserves the Runtime status representation ${JSON.stringify(status)}`, () => {
    const f = rebuildTraceFixture(),
      c = f.command;
    c.trace.processes.rust = { serviceName: "antnest-runtime" };
    c.add("HTTP GET /status", "rust", c.activities.runtime_update.execution, {
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/status",
      "http.status_code": status,
    });
    const before = JSON.stringify(c.trace);
    assert.equal(inspect(f).status, "passed");
    assert.equal(JSON.stringify(c.trace), before);
  });
}

for (const status of [" 200", "2e2", "200.0", [200], "500"]) {
  test(`Rebuild rejects malformed or unsuccessful Runtime status ${JSON.stringify(status)}`, () => {
    const f = rebuildTraceFixture(),
      c = f.command;
    c.trace.processes.rust = { serviceName: "antnest-runtime" };
    c.add("HTTP GET /status", "rust", c.activities.runtime_update.execution, {
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/status",
      "http.status_code": status,
    });
    assert.throws(() => inspect(f));
  });
}

function skillProbe(f) {
  const c = f.command,
    a = c.activities.admit_lifecycle.activity;
  const r = c.rpc(
    a,
    "runtime",
    "POST",
    "/internal/runtimes/{agent_id}/skill-sets/prepare",
    a.startTime + 1000,
    202,
  );
  setTag(r.server, "antnest.outcome", "completed");
  const probe = c.add(
    "HTTP GET docker",
    "runtime",
    r.server,
    {
      "span.kind": "client",
      "http.request.method": "GET",
      "http.response.status_code": 404,
      "peer.service": "docker",
      "antnest.outcome": "absent",
    },
    r.server.startTime + 100,
    100,
  );
  return { ...r, probe };
}

function setEventField(event, key, value) {
  const holder = { tags: event.fields };
  setTag(holder, key, value);
  event.fields = holder.tags;
}

function runtimeStatus(f) {
  const c = f.command;
  c.trace.processes.rust = {
    serviceName: "antnest-runtime",
    tags: fields({
      "antnest.agent.id": "configuration-consumer-agent",
      "antnest.runtime.generation": "1",
    }),
  };
  const span = c.add(
    "HTTP GET /status",
    "rust",
    c.activities.admit_lifecycle.activity,
    {
      "span.kind": "server",
      "service.name": "antnest-runtime",
      "antnest.agent.id": "configuration-consumer-agent",
      "antnest.runtime.execution.id": "configuration-consumer-execution",
      "antnest.runtime.generation": "1",
      "http.request.method": "GET",
      "http.route": "/status",
      "url.path": "/status",
      "http.status_code": "200",
      "http.transport.outcome": "success",
    },
  );
  setTag(span, "span_id", span.spanID);
  setTag(span, "trace_id", span.traceID);
  const event = {
    timestamp: span.startTime + span.duration,
    fields: fields({
      event: "Runtime HTTP request completed",
      "service.name": "antnest-runtime",
      "antnest.agent.id": "configuration-consumer-agent",
      "antnest.runtime.generation": "1",
      "error.type": "",
      "http.request.method": "GET",
      "http.status_code": "200",
      "http.transport.outcome": "success",
      level: "INFO",
      span_id: span.spanID,
      trace_id: span.traceID,
      "url.path": "/status",
    }),
  };
  span.logs = [event];
  return { span, event };
}

test("Rebuild preserves a configuration consumer's successful Runtime status completion with an empty error type", () => {
  const f = rebuildTraceFixture();
  runtimeStatus(f);
  const before = structuredClone({ e: f.evidence, trace: f.command.trace });
  const result = inspect(f);
  assert.equal(result.status, "passed");
  assert.equal(result.owned_error_spans.length, 10);
  assert.deepEqual({ e: f.evidence, trace: f.command.trace }, before);
});

function quantizedRuntimeStatus(f) {
  const r = runtimeStatus(f);
  setTag(f.command.trace.processes.rust, "telemetry.sdk.language", "rust");
  setTag(f.command.trace.processes.rust, "telemetry.sdk.name", "opentelemetry");
  r.event.timestamp = r.span.startTime + r.span.duration + 1;
  return r;
}

test("Rebuild retains a Runtime status event at the integer microsecond end boundary", () => {
  const f = rebuildTraceFixture();
  const { span, event } = quantizedRuntimeStatus(f);
  const before = structuredClone({ e: f.evidence, trace: f.command.trace });
  const result = inspect(f);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.time_observations, [
    {
      trace_id: f.command.trace.traceID,
      span_id: span.spanID,
      process_id: span.processID,
      boundary: "runtime-status-event-within-span",
      event_index: 0,
      raw_left_us: event.timestamp,
      raw_right_us: span.startTime + span.duration,
      raw_difference_us: 1,
      raw_span_start_us: span.startTime,
      raw_span_duration_us: span.duration,
      representation_us: 1,
      reason: "jaeger-integer-microsecond-representation",
    },
  ]);
  assert.deepEqual({ e: f.evidence, trace: f.command.trace }, before);
});

for (const [name, change] of [
  ["two microseconds late", ({ event }) => event.timestamp++],
  [
    "before the start",
    ({ span, event }) => {
      event.timestamp = span.startTime - 1;
    },
  ],
  ["fractional event", ({ event }) => (event.timestamp -= 0.5)],
  ["fractional start", ({ span }) => (span.startTime += 0.5)],
  ["fractional duration", ({ span }) => (span.duration += 0.5)],
  [
    "unidentified SDK language",
    (_, f) =>
      setTag(f.command.trace.processes.rust, "telemetry.sdk.language", "go"),
  ],
  [
    "unidentified SDK name",
    (_, f) =>
      setTag(f.command.trace.processes.rust, "telemetry.sdk.name", "other"),
  ],
  [
    "wrong event owner",
    ({ event }) => setEventField(event, "span_id", "foreign"),
  ],
  [
    "error diagnostic",
    ({ event }) => setEventField(event, "exception.type", "UnexpectedError"),
  ],
]) {
  test(`Rebuild Runtime status representation rejects ${name}`, () => {
    const f = rebuildTraceFixture();
    const r = quantizedRuntimeStatus(f);
    change(r, f);
    assert.throws(() => inspect(f));
  });
}

for (const [name, change] of [
  [
    "wrong event",
    ({ event }) => setEventField(event, "event", "different completion"),
  ],
  [
    "actual error",
    ({ event }) => setEventField(event, "error.type", "timeout"),
  ],
  [
    "additional exception",
    ({ event }) => setEventField(event, "exception.type", "UnexpectedError"),
  ],
  [
    "additional failure outcome",
    ({ event }) => setEventField(event, "antnest.outcome", "failed"),
  ],
  ["wrong log level", ({ event }) => setEventField(event, "level", "ERROR")],
  [
    "wrong event Agent",
    ({ event }) => setEventField(event, "antnest.agent.id", "foreign"),
  ],
  [
    "wrong process Agent",
    (_, f) =>
      setTag(f.command.trace.processes.rust, "antnest.agent.id", "foreign"),
  ],
  [
    "wrong generation",
    ({ event }) => setEventField(event, "antnest.runtime.generation", "2"),
  ],
  ["wrong trace", ({ event }) => setEventField(event, "trace_id", "foreign")],
  ["wrong span", ({ event }) => setEventField(event, "span_id", "foreign")],
  [
    "wrong service",
    ({ event }) => setEventField(event, "service.name", "runtime-controller"),
  ],
  ["wrong path", ({ span }) => setTag(span, "url.path", "/mcp")],
  [
    "wrong method",
    ({ event }) => setEventField(event, "http.request.method", "POST"),
  ],
  [
    "wrong status",
    ({ event }) => setEventField(event, "http.status_code", "500"),
  ],
  [
    "failed transport",
    ({ span }) => setTag(span, "http.transport.outcome", "failed"),
  ],
  [
    "span transport error",
    ({ span }) =>
      setTag(span, "http.transport.error.type", "client_disconnected"),
  ],
  [
    "event transport error",
    ({ event }) =>
      setEventField(event, "http.transport.error.type", "client_disconnected"),
  ],
  [
    "event before span",
    ({ span, event }) => {
      event.timestamp = span.startTime - 1;
    },
  ],
  [
    "event after span",
    ({ span, event }) => {
      event.timestamp = span.startTime + span.duration + 1;
    },
  ],
  [
    "duplicate completion",
    ({ span, event }) => {
      span.logs.push(structuredClone(event));
    },
  ],
]) {
  test(`Rebuild status completion rejects ${name}`, () => {
    const f = rebuildTraceFixture();
    const r = runtimeStatus(f);
    change(r, f);
    assert.throws(() => inspect(f));
  });
}

test("Rebuild retains the completed admission Skill preparation's absent Docker probe", () => {
  const f = rebuildTraceFixture();
  skillProbe(f);
  assert.equal(inspect(f).status, "passed");
});
for (const [name, change] of [
  [
    "unsuccessful prepare",
    (r) => setTag(r.server, "http.response.status_code", 500),
  ],
  ["unfinished prepare", (r) => setTag(r.server, "antnest.outcome", "running")],
  [
    "foreign phase",
    (r, f) => {
      r.client.references[0].spanID =
        f.command.activities.drain.activity.spanID;
    },
  ],
  ["probe error", (r) => setTag(r.probe, "error", true)],
]) {
  test(`Rebuild rejects Skill Docker absence with ${name}`, () => {
    const f = rebuildTraceFixture(),
      r = skillProbe(f);
    change(r, f);
    assert.throws(() => inspect(f));
  });
}
