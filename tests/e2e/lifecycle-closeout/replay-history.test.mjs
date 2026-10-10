import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertReplayHistory,
  inspectReplayObservation,
  observationEventQuery,
} from "./replay-history.mjs";

function fixture() {
  const admissionTraceID = "a".repeat(32);
  const replayTraceID = "b".repeat(32);
  const traceID = "c".repeat(32);
  const agentID = "agent_test";
  const runtimeRevision = "runtime-test";
  const events = ["agent_create_requested", "agent_created"].map(
    (event_type, index) => ({
      event_type,
      event_id: `event_${index + 1}`,
      agent_id: agentID,
      operation_request_id: "operation-create",
      schema_version: 1,
      aggregate_sequence: index + 1,
      global_sequence: 27 + index,
      trace_id: admissionTraceID,
      occurred_at: `2026-10-10T08:32:5${index}.000Z`,
    }),
  );
  const event = {
    event_type: "agent_runtime_condition_changed",
    event_id: "event_observed",
    agent_id: agentID,
    schema_version: 1,
    aggregate_sequence: 3,
    global_sequence: 29,
    trace_id: traceID,
    occurred_at: "2026-10-10T08:32:57.780789Z",
  };
  const input = {
    before: { events, next_sequence: 28 },
    after: { events: [...structuredClone(events), event], next_sequence: 29 },
    agentID,
    kind: "create",
    runtimeStartupFailure: true,
    runtimeRevision,
    admissionTraceID,
    replayTraceID,
  };
  const persisted = {
    ...event,
    operation_request_id: "",
    data: {
      runtime_revision: runtimeRevision,
      runtime_state: "waiting",
      reason: "runtime_restarting",
    },
  };
  const trace = { traceID, spans: [], processes: {} };
  const add = (id, service, name, parent, tags = {}) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID,
      spanID: id,
      processID: service,
      operationName: name,
      startTime: 1,
      duration: 1,
      references: parent
        ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
        : [],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  };
  add(
    "observe",
    "agent-controller",
    "agent_controller.runtime_observation.synchronize",
    null,
    { "span.kind": "consumer" },
  );
  add("client", "agent-controller", "HTTP GET", "observe", {
    "span.kind": "client",
    "http.request.method": "GET",
    "http.response.status_code": 200,
    "antnest.agent.id": agentID,
    "rpc.method": "inspect",
  });
  add(
    "inspect",
    "runtime-controller",
    "GET /internal/runtimes/{agent_id}",
    "client",
    {
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/internal/runtimes/{agent_id}",
      "http.response.status_code": 200,
    },
  );
  add("transaction", "agent-controller", "postgresql transaction", "observe");
  add("insert", "agent-controller", "INSERT", "transaction", {
    "db.query.text":
      "INSERT INTO agent_controller.agent_events (event_id) VALUES ($1)",
  });
  add("commit", "agent-controller", "COMMIT", "transaction");
  return { input, event, trace, persisted };
}

async function verify(f) {
  return assertReplayHistory(f.input, (event) =>
    inspectReplayObservation(f.trace, {
      ...f.input,
      event,
      persisted: f.persisted,
    }),
  );
}

test("startup-failure replay accepts a proven independent observation without changing the old history", async () => {
  const f = fixture();
  const original = JSON.stringify(f);
  const evidence = await verify(f);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].trace_id, f.event.trace_id);
  assert.equal(evidence[0].event_id, f.event.event_id);
  assert.equal(evidence[0].strict_trace, "passed");
  assert.equal(JSON.stringify(f), original);
});

test("unchanged replay needs no observation exception or collector", async () => {
  const { input } = fixture();
  input.runtimeStartupFailure = false;
  input.after = structuredClone(input.before);
  assert.deepEqual(await assertReplayHistory(input), []);
});

test("both snapshots must be complete even when their visible events are identical", async () => {
  const { input } = fixture();
  input.before.events = Array.from({ length: 100 }, (_, index) => ({
    ...input.before.events[0],
    event_id: `event_${index}`,
    aggregate_sequence: index + 1,
    global_sequence: index + 1,
  }));
  input.before.next_sequence = 100;
  input.after = structuredClone(input.before);
  await assert.rejects(assertReplayHistory(input));
});

for (const [name, mutate] of [
  [
    "ordinary create",
    (f) => {
      f.input.runtimeStartupFailure = false;
    },
  ],
  [
    "another lifecycle kind",
    (f) => {
      f.input.kind = "enable";
    },
  ],
  [
    "changed old event",
    (f) => {
      f.input.after.events[0].occurred_at = "2026-10-11T00:00:00Z";
    },
  ],
  [
    "lost old event",
    (f) => {
      f.input.after.events.shift();
    },
  ],
  [
    "duplicate identity",
    (f) => {
      f.event.event_id = f.input.before.events[0].event_id;
    },
  ],
  [
    "wrong cursor",
    (f) => {
      f.input.after.next_sequence = 28;
    },
  ],
  [
    "changed page metadata",
    (f) => {
      f.input.after.truncated = true;
    },
  ],
  [
    "reversed global sequence",
    (f) => {
      f.event.global_sequence = 28;
    },
  ],
  [
    "reversed aggregate sequence",
    (f) => {
      f.event.aggregate_sequence = 2;
    },
  ],
  [
    "noninteger aggregate sequence",
    (f) => {
      f.event.aggregate_sequence = 3.5;
    },
  ],
  [
    "wrong Agent",
    (f) => {
      f.event.agent_id = "other";
    },
  ],
  [
    "unknown event schema",
    (f) => {
      f.event.schema_version = 2;
      f.persisted.schema_version = 2;
    },
  ],
  [
    "extra lifecycle effect",
    (f) => {
      f.event.event_type = "agent_created";
    },
  ],
  [
    "operation-associated observation",
    (f) => {
      f.event.operation_request_id = "operation-create";
    },
  ],
  [
    "admission trace",
    (f) => {
      f.event.trace_id = f.input.admissionTraceID;
    },
  ],
  [
    "replay trace",
    (f) => {
      f.event.trace_id = f.input.replayTraceID;
    },
  ],
  [
    "missing trace",
    (f) => {
      delete f.event.trace_id;
    },
  ],
  [
    "missing target",
    (f) => {
      delete f.input.runtimeRevision;
    },
  ],
  [
    "missing persisted evidence",
    (f) => {
      f.persisted = null;
    },
  ],
  [
    "wrong persisted event",
    (f) => {
      f.persisted.event_id = "event_unrelated";
    },
  ],
  [
    "wrong persisted trace",
    (f) => {
      f.persisted.trace_id = "d".repeat(32);
    },
  ],
  [
    "wrong persisted Agent",
    (f) => {
      f.persisted.agent_id = "other";
    },
  ],
  [
    "wrong persisted target",
    (f) => {
      f.persisted.data.runtime_revision = "other";
    },
  ],
  [
    "wrong persisted sequence",
    (f) => {
      f.persisted.global_sequence++;
    },
  ],
  [
    "missing persisted data",
    (f) => {
      delete f.persisted.data;
    },
  ],
  [
    "persisted command effect",
    (f) => {
      f.persisted.operation_request_id = "another-command";
    },
  ],
  [
    "unrelated trace",
    (f) => {
      f.trace.traceID = "d".repeat(32);
    },
  ],
  [
    "non-observer root",
    (f) => {
      f.trace.spans[0].operationName = "admit_agent";
    },
  ],
  [
    "server root",
    (f) => {
      f.trace.spans[0].tags[0].value = "server";
    },
  ],
  [
    "foreign inspection",
    (f) => {
      f.trace.spans[1].tags.find((t) => t.key === "antnest.agent.id").value =
        "other";
    },
  ],
  [
    "failed inspection",
    (f) => {
      f.trace.spans[2].tags.push({ key: "error", value: true });
    },
  ],
  [
    "no event write",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "insert");
    },
  ],
  [
    "uncommitted event",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "commit");
    },
  ],
  [
    "failed event write",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "insert")
        .tags.push({ key: "error", value: true });
    },
  ],
  [
    "unknown warning",
    (f) => {
      f.trace.warnings = ["missing spans"];
    },
  ],
  [
    "captured RPC content",
    (f) => {
      f.trace.spans[2].logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ];
    },
  ],
])
  test(`replay rejects ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(verify(f));
  });

test("a missing observation collector cannot silently accept an append", async () => {
  await assert.rejects(assertReplayHistory(fixture().input));
});

test("an empty or unrelated collector result cannot stand in for provenance", async () => {
  for (const result of [
    undefined,
    {},
    { topology: "passed", event_id: "event_unrelated" },
  ])
    await assert.rejects(
      assertReplayHistory(fixture().input, async () => result),
    );
});

test("clock warnings remain in raw and strict observation evidence", async () => {
  const f = fixture();
  const warning =
    "clock skew adjustment disabled; not applying calculated delta of 500µs";
  f.trace.spans[2].warnings = [warning];
  const [evidence] = await verify(f);
  assert.equal(evidence.strict_trace, "failed");
  assert.deepEqual(evidence.warnings, [warning]);
  assert.deepEqual(f.trace.spans[2].warnings, [warning]);
});

test("event evidence SELECT is bounded to a validated identity and excludes secrets", () => {
  const sql = observationEventQuery("event_safe123");
  assert.match(
    sql,
    /FROM agent_controller\.agent_events WHERE event_id='event_safe123'/u,
  );
  assert(!sql.includes("SELECT *"));
  for (const value of [
    "",
    "event'; DELETE FROM agent_controller.agents;--",
    "event\nunsafe",
  ])
    assert.throws(() => observationEventQuery(value));
});
