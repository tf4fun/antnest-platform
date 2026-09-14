import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStartupFailure,
  assertFailureEvents,
  assertMCPStartupLog,
} from "./failure.mjs";

function fixture() {
  return {
    agentID: "a",
    image: "sha256:fixture",
    operation: {
      agent_id: "a",
      kind: "create",
      state: "completed",
      phase: "completed",
    },
    agent: {
      agent_id: "a",
      lifecycle_state: "created",
      activation_state: "enabled",
      runtime_state: "exited",
      runtime_reason: "runtime_exited",
      runtime: { runtime_revision: "r1" },
    },
    physical: {
      containers: [
        {
          Image: "sha256:fixture",
          State: { Status: "exited", Health: { Status: "unhealthy" } },
        },
      ],
      volumes: ["antnest-workspace-a"],
    },
  };
}
test("failure proves ownership without executable publication", () => {
  assertStartupFailure(fixture());
});
for (const [name, mutate] of [
  [
    "no diagnostic",
    (f) => {
      delete f.agent.runtime_reason;
    },
  ],
  [
    "unknown outcome",
    (f) => {
      f.operation.state = "unknown";
    },
  ],
  [
    "wrong phase",
    (f) => {
      f.operation.phase = "publish";
    },
  ],
  [
    "foreign operation",
    (f) => {
      f.operation.agent_id = "b";
    },
  ],
  [
    "missing workspace",
    (f) => {
      f.physical.volumes = [];
    },
  ],
  [
    "missing container",
    (f) => {
      f.physical.containers = [];
    },
  ],
  [
    "wrong image",
    (f) => {
      f.physical.containers[0].Image = "other";
    },
  ],
  [
    "healthy runtime",
    (f) => {
      f.physical.containers[0].State.Health.Status = "healthy";
    },
  ],
  [
    "executable revision",
    (f) => {
      f.agent.executable_execution_revision = "rev";
    },
  ],
  [
    "published binding",
    (f) => {
      f.agent.runtime = { mcp_endpoint: "http://runtime/mcp" };
    },
  ],
])
  test(`rejects startup failure: ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => assertStartupFailure(f));
  });

const failureLog = {
  "antnest.agent.id": "a",
  "antnest.runtime.generation": "1",
  level: "ERROR",
  component: "managed_mcp",
  "error.type": "managed_mcp_start_failed",
  reason: "managed MCP missing-mcp: initialization failed",
};
test("correlates actual managed MCP startup diagnostics without echoing raw logs", () => {
  assertMCPStartupLog(
    "unstructured line\n" + JSON.stringify(failureLog),
    "a",
    "1",
  );
});
for (const [name, change] of [
  ["foreign Agent", { "antnest.agent.id": "b" }],
  ["foreign generation", { "antnest.runtime.generation": "2" }],
  ["network failure", { component: "network", "error.type": "network_failed" }],
  ["another MCP", { reason: "managed MCP other: initialization failed" }],
])
  test(`rejects uncorrelated startup log: ${name}`, () => {
    assert.throws(() =>
      assertMCPStartupLog(
        JSON.stringify({ ...failureLog, ...change }),
        "a",
        "1",
      ),
    );
  });

const failureEvents = [
  "agent_create_requested",
  "agent_created",
  "agent_delete_requested",
  "agent_deleted",
].map((event_type, index) => ({
  event_type,
  operation_request_id: index < 2 ? "create" : "delete",
}));
test("retained history includes exactly the failure and deletion outcomes", () => {
  assertFailureEvents(failureEvents, "create", "delete");
});
for (const index of [0, 1, 2, 3])
  test(`rejects missing or duplicate event ${index}`, () => {
    assert.throws(() =>
      assertFailureEvents(
        failureEvents.filter((_, i) => i !== index),
        "create",
        "delete",
      ),
    );
    assert.throws(() =>
      assertFailureEvents(
        [...failureEvents, failureEvents[index]],
        "create",
        "delete",
      ),
    );
  });
