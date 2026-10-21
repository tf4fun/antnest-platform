import assert from "node:assert/strict";
import { test } from "node:test";
import * as replayHistory from "./replay-history.mjs";
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
    "exception without an error flag",
    (f) => {
      f.trace.spans[2].tags.push({ key: "exception.type", value: "Unknown" });
    },
  ],
  [
    "error log without an error flag",
    (f) => {
      f.trace.spans[2].logs = [
        { fields: [{ key: "event", value: "exception" }] },
      ];
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

function businessInspector() {
  const inspect = replayHistory.inspectReplayObservationBusiness;
  assert.equal(
    typeof inspect,
    "function",
    "inspectReplayObservationBusiness is required",
  );
  return inspect;
}

function businessInput(f) {
  return {
    event: f.event,
    persisted: f.persisted,
    agentID: f.input.agentID,
    runtimeRevision: f.input.runtimeRevision,
  };
}

function traceFreeFixture() {
  const f = fixture();
  delete f.input.admissionTraceID;
  delete f.input.replayTraceID;
  delete f.event.trace_id;
  delete f.persisted.trace_id;
  return f;
}

const businessReceipt = (f) => ({
  event_id: f.event.event_id,
  agent_id: f.input.agentID,
  business: "passed",
});

test("business observation validates original SQL evidence without Trace metadata or Spans", () => {
  const inspect = businessInspector();
  const f = traceFreeFixture();
  const input = businessInput(f);
  const original = structuredClone(input);
  assert.deepEqual(inspect(input), businessReceipt(f));
  assert.deepEqual(
    input,
    original,
    "business inspection changed the original evidence",
  );
});

test("business replay accepts mismatched diagnostic identities and uses only the business receipt", async () => {
  const inspect = businessInspector();
  const f = fixture();
  f.input.admissionTraceID = "invalid-admission-trace";
  delete f.input.replayTraceID;
  f.event.trace_id = "PRIVATE-INVALID-TRACE-CANARY";
  f.persisted.trace_id = "a-different-diagnostic-identity";
  const original = structuredClone(f);
  let reads = 0;
  const result = await assertReplayHistory(
    f.input,
    async (event) => {
      reads++;
      assert.equal(event, f.event);
      return inspect(businessInput(f));
    },
    { requireTrace: false },
  );
  assert.equal(reads, 1);
  assert.deepEqual(result, [businessReceipt(f)]);
  assert(!JSON.stringify(result).includes("PRIVATE-INVALID-TRACE-CANARY"));
  assert.deepEqual(
    f,
    original,
    "business replay changed the original evidence",
  );
});

test("legacy replay admission remains strict when its collector returns only a business receipt", async () => {
  const f = fixture();
  await assert.rejects(
    assertReplayHistory(f.input, async () => businessReceipt(f)),
  );
});

test("business observation rejects a missing or unrelated persisted row", () => {
  const inspect = businessInspector();
  for (const mutate of [
    (f) => {
      f.persisted = null;
    },
    (f) => {
      f.persisted.event_id = "event_unrelated";
    },
    (f) => {
      f.persisted.agent_id = "another-agent";
    },
    (f) => {
      f.event.agent_id = f.persisted.agent_id = "another-agent";
    },
  ]) {
    const f = traceFreeFixture();
    mutate(f);
    assert.throws(() => inspect(businessInput(f)));
  }
});

test("business observation retains public identity sequence schema and date validation", () => {
  const inspect = businessInspector();
  for (const mutate of [
    (f) => {
      f.event.event_id = f.persisted.event_id = "";
    },
    (f) => {
      f.event.aggregate_sequence = f.persisted.aggregate_sequence = 0;
    },
    (f) => {
      f.event.schema_version = f.persisted.schema_version = 2;
    },
    (f) => {
      f.event.event_type = f.persisted.event_type = "agent_created";
    },
    (f) => {
      f.event.occurred_at = "not-a-date";
    },
  ]) {
    const f = traceFreeFixture();
    mutate(f);
    assert.throws(() => inspect(businessInput(f)));
  }
});

test("business observation binds both persisted cursors to the original public event", () => {
  const inspect = businessInspector();
  for (const mutate of [
    (f) => {
      f.persisted.aggregate_sequence++;
    },
    (f) => {
      f.persisted.global_sequence++;
    },
    (f) => {
      f.event.global_sequence = f.persisted.global_sequence =
        Number.MAX_SAFE_INTEGER + 1;
    },
  ]) {
    const f = traceFreeFixture();
    mutate(f);
    assert.throws(() => inspect(businessInput(f)));
  }
});

test("business observation requires original persisted Runtime data and the expected target", () => {
  const inspect = businessInspector();
  for (const mutate of [
    (f) => {
      delete f.input.runtimeRevision;
    },
    (f) => {
      delete f.persisted.data;
    },
    (f) => {
      f.persisted.data = [];
    },
    (f) => {
      f.persisted.data.runtime_revision = "another-runtime";
    },
  ]) {
    const f = traceFreeFixture();
    mutate(f);
    assert.throws(() => inspect(businessInput(f)));
  }
});

test("business observation rejects command association on either original record", () => {
  const inspect = businessInspector();
  for (const field of ["event", "persisted"]) {
    const f = traceFreeFixture();
    f[field].operation_request_id = "operation-command";
    assert.throws(() => inspect(businessInput(f)));
  }
});

test("business replay preserves the original history prefix without Trace collection", async () => {
  const f = traceFreeFixture();
  f.input.after.events[0].occurred_at = "2026-10-11T00:00:00Z";
  let reads = 0;
  await assert.rejects(
    assertReplayHistory(
      f.input,
      async () => {
        reads++;
        return businessReceipt(f);
      },
      { requireTrace: false },
    ),
  );
  assert.equal(reads, 0, "history corruption reached the observation reader");
});

test("business replay still enforces complete pages cursors metadata and failed-create scope", async () => {
  for (const mutate of [
    (f) => {
      f.input.after.next_sequence--;
    },
    (f) => {
      f.input.after.truncated = true;
    },
    (f) => {
      f.input.runtimeStartupFailure = false;
    },
    (f) => {
      f.input.before.events = Array.from({ length: 100 }, (_, index) => ({
        ...f.input.before.events[0],
        event_id: `event_${index}`,
        aggregate_sequence: index + 1,
        global_sequence: index + 1,
      }));
      f.input.before.next_sequence = 100;
      f.input.after = structuredClone(f.input.before);
    },
  ]) {
    const f = traceFreeFixture();
    mutate(f);
    await assert.rejects(
      assertReplayHistory(f.input, async () => businessReceipt(f), {
        requireTrace: false,
      }),
    );
  }
});

test("business replay propagates the original SQL read failure", async () => {
  const f = traceFreeFixture();
  const failure = new Error("original observation SQL read failed");
  let reads = 0;
  await assert.rejects(
    assertReplayHistory(
      f.input,
      async () => {
        reads++;
        throw failure;
      },
      { requireTrace: false },
    ),
    (error) => error === failure,
  );
  assert.equal(reads, 1);
});

test("business replay requires a matching successful business receipt from its reader", async () => {
  const f = fixture();
  for (const result of [
    undefined,
    { ...businessReceipt(f), event_id: "event_unrelated" },
    { ...businessReceipt(f), agent_id: "another-agent" },
    { ...businessReceipt(f), business: "failed" },
    {
      kind: "runtime-observation",
      topology: "passed",
      event_id: f.event.event_id,
      agent_id: f.input.agentID,
      trace_id: f.event.trace_id,
      spans: 1,
      error_spans: 0,
      warnings: [],
      warning_count: 0,
      strict_trace: "passed",
    },
  ])
    await assert.rejects(
      assertReplayHistory(f.input, async () => result, {
        requireTrace: false,
      }),
    );
  await assert.rejects(
    assertReplayHistory(f.input, undefined, { requireTrace: false }),
  );
});
