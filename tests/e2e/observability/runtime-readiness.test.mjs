import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectReadiness,
  creationObservation,
  verifyCreationReplay,
} from "./runtime-readiness.mjs";
import { fixture, creationFixture } from "./runtime-readiness-fixtures.mjs";

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
