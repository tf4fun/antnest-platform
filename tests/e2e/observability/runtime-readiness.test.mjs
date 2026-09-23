import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectReadiness,
  creationObservation,
  verifyCreationReplay,
} from "./runtime-readiness.mjs";

function fixture() {
  const trace = { traceID: "b".repeat(32), spans: [], processes: {} };
  const add = (id, service, name, parent, tags, request, response) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID: trace.traceID,
      spanID: id,
      processID: service,
      operationName: name,
      startTime: 1,
      duration: 1,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }]
        : [],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      logs: Object.entries({ request, response })
        .filter(([, v]) => v !== undefined)
        .map(([direction, value]) => ({
          fields: [
            { key: "event", value: "antnest." + direction },
            { key: "antnest.payload.json", value: JSON.stringify(value) },
          ],
        })),
    });
  };
  const current = {
    agentID: "agent-test",
    runtimeRevision: "runtime-test",
    runtimeExecutionID: "process-test",
  };
  add(
    "observe",
    "agent-controller",
    "agent_controller.runtime_observation.synchronize",
    null,
    { "span.kind": "consumer" },
  );
  add("client", "agent-controller", "GET", "observe", {
    "span.kind": "client",
    "http.request.method": "GET",
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
    undefined,
    {
      agent_id: current.agentID,
      runtime_revision: current.runtimeRevision,
      runtime_execution_id: current.runtimeExecutionID,
      lifecycle_state: "provisioned",
      health: "healthy",
      mcp_endpoint: "http://runtime:8093/mcp",
    },
  );
  add("verify", "runtime-controller", "runtime.status.verify", "inspect", {
    "antnest.agent.id": current.agentID,
    "antnest.runtime.execution_id": current.runtimeExecutionID,
  });
  add("status-client", "runtime-controller", "GET", "verify", {
    "span.kind": "client",
    "http.request.method": "GET",
  });
  add("status", "antnest-runtime", "GET /status", "status-client", {
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "/status",
    "http.response.status_code": 200,
  });
  add("transaction", "agent-controller", "postgresql transaction", "observe", {
    "span.kind": "internal",
  });
  add("execution", "agent-controller", "INSERT", "transaction", {
    "db.query.text":
      "INSERT INTO agent_controller.execution_revisions (id) VALUES ($1)",
  });
  add("commit", "agent-controller", "COMMIT", "transaction", {});
  current.traceID = trace.traceID;
  return { trace, current };
}

test("independent readiness verifies current Runtime and committed execution", () => {
  const { trace, current } = fixture();
  const result = inspectReadiness(trace, current);
  assert.equal(result.trace_id, trace.traceID);
  assert.equal(result.mcp_endpoint, "http://runtime:8093/mcp");
});
for (const [name, mutate] of [
  [
    "missing Runtime status",
    (t) => {
      t.spans = t.spans.filter((s) => s.spanID !== "status");
    },
  ],
  [
    "unrelated status",
    (t) => {
      t.spans.find((s) => s.spanID === "status-client").references[0].spanID =
        "observe";
    },
  ],
  [
    "failed status",
    (t) => {
      t.spans
        .find((s) => s.spanID === "status")
        .tags.push({ key: "error", value: true });
    },
  ],
  [
    "uncommitted execution",
    (t) => {
      t.spans = t.spans.filter((s) => s.spanID !== "commit");
    },
  ],
  [
    "no execution write",
    (t) => {
      t.spans = t.spans.filter((s) => s.spanID !== "execution");
    },
  ],
  ...["agent_id", "runtime_revision", "runtime_execution_id", "health"].map(
    (key) => [
      key,
      (t) => {
        const f = t.spans.find((s) => s.spanID === "inspect").logs[0].fields[1];
        f.value = JSON.stringify({ ...JSON.parse(f.value), [key]: "wrong" });
      },
    ],
  ),
]) {
  test("readiness rejects " + name, () => {
    const { trace, current } = fixture();
    mutate(trace);
    assert.throws(() => inspectReadiness(trace, current));
  });
}

function creationFixture() {
  const agent = {
    agent_id: "agent-test",
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "available",
    executable_execution_revision: "execution-test",
    runtime: {
      runtime_revision: "runtime-test",
      runtime_execution_id: "process-test",
      mcp_endpoint: "http://runtime:8093/mcp",
    },
  };
  const operation = { request_id: "request-test", state: "completed" };
  const events = ["agent_create_requested", "agent_created", "agent_ready"].map(
    (event_type, index) => ({
      event_type,
      agent_id: agent.agent_id,
      operation_request_id: operation.request_id,
      global_sequence: index + 1,
      aggregate_sequence: index + 1,
      occurred_at: new Date(index * 1000).toISOString(),
      trace_id: (index === 2 ? "b" : "a").repeat(32),
      data:
        index === 2
          ? {
              execution_revision_id: "execution-test",
              runtime_revision: "runtime-test",
            }
          : {},
    }),
  );
  return { agent, operation, events, creationTraceID: "a".repeat(32) };
}
test("created and ready are separate ordered events for one target", () => {
  assert.equal(creationObservation(creationFixture()).traceID, "b".repeat(32));
});
for (const [name, mutate] of [
  ["missing created", (f) => f.events.splice(1, 1)],
  [
    "wrong request",
    (f) => {
      f.events[2].operation_request_id = "other";
    },
  ],
  [
    "wrong creation trace",
    (f) => {
      f.events[1].trace_id = "c".repeat(32);
    },
  ],
  [
    "same readiness trace",
    (f) => {
      f.events[2].trace_id = f.creationTraceID;
    },
  ],
  [
    "missing execution",
    (f) => {
      delete f.agent.executable_execution_revision;
    },
  ],
  [
    "missing revision",
    (f) => {
      delete f.agent.runtime.runtime_revision;
    },
  ],
  [
    "not available",
    (f) => {
      f.agent.runtime_state = "waiting";
    },
  ],
  [
    "not completed",
    (f) => {
      f.operation.state = "running";
    },
  ],
  [
    "reversed events",
    (f) => {
      f.events[2].global_sequence = 1;
    },
  ],
])
  test("creation observation rejects " + name, () => {
    const f = creationFixture();
    mutate(f);
    assert.throws(() => creationObservation(f));
  });

test("readiness must match the event trace identity", () => {
  const { trace, current } = fixture();
  current.traceID = "c".repeat(32);
  assert.throws(() => inspectReadiness(trace, current));
});
test("execution identity must match the internal status verifier, even without a client expectation", () => {
  const { trace, current } = fixture();
  delete current.runtimeExecutionID;
  trace.spans
    .find((s) => s.spanID === "verify")
    .tags.find((t) => t.key === "antnest.runtime.execution_id").value =
    "different-process";
  assert.throws(() => inspectReadiness(trace, current));
});

test("creation replay must retain Agent, operation and event identity", () => {
  const { agent, operation, events } = creationFixture();
  const input = {
    agentID: agent.agent_id,
    operation,
    events,
    replay: { agent, operation },
    replayedOperation: operation,
    afterEvents: events,
  };
  assert.doesNotThrow(() => verifyCreationReplay(input));
  for (const mutate of [
    (f) => {
      f.replay.agent.agent_id = "unrelated";
    },
    (f) => {
      f.replay.operation.request_id = "unrelated";
    },
    (f) => {
      f.replayedOperation.state = "failed";
    },
    (f) => {
      f.afterEvents.push({ ...events[0] });
    },
  ]) {
    const changed = JSON.parse(JSON.stringify(input));
    mutate(changed);
    assert.throws(() => verifyCreationReplay(changed));
  }
});
