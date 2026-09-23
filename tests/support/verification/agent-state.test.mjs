import assert from "node:assert/strict";
import test from "node:test";
import {
  agentReady,
  assertAgentReady,
  assertAgentDisabled,
  assertAgentDeleted,
  waitForAgentReady,
} from "./agent-state.mjs";

const ready = {
  lifecycle_state: "created",
  activation_state: "enabled",
  desired_state: "enabled",
  runtime_state: "available",
  executable_execution_revision: "execution",
  runtime: { runtime_revision: "runtime" },
};

test("deleted projection has no active configuration or execution entry", () => {
  const deleted = {
    lifecycle_state: "deleted",
    desired_state: "deleted",
    runtime_state: "absent",
    last_successful_execution_revision: "historical-execution",
  };
  assertAgentDeleted(deleted);
  for (const changed of [
    { lifecycle_state: "created" },
    { desired_state: "enabled" },
    { runtime_state: "unknown" },
    { activation_state: "disabled" },
    { agent_spec_revision: "spec" },
    { configuration: { template: { name: "Residual template" } } },
    { executable_execution_revision: "execution" },
    { active_operation_request_id: "deleting" },
    { runtime: { runtime_revision: "runtime" } },
    { runtime: { runtime_execution_id: "process" } },
    { runtime: { mcp_endpoint: "http://runtime/mcp" } },
  ])
    assert.throws(() => assertAgentDeleted({ ...deleted, ...changed }));
});

test("Runtime health alone does not imply Agent availability", () => {
  assertAgentReady(ready);
  for (const override of [
    { lifecycle_state: "not_created" },
    { activation_state: "disabled" },
    { desired_state: "disabled" },
    { executable_execution_revision: undefined },
    { runtime: undefined },
    { active_operation_request_id: "disable" },
    ...["waiting", "unhealthy", "exited", "absent", "unknown"].map(
      (runtime_state) => ({ runtime_state }),
    ),
  ])
    assert.equal(agentReady({ ...ready, ...override }), false);
});

test("disabled is confirmed separately from the request", () => {
  const disabled = {
    ...ready,
    desired_state: "disabled",
    activation_state: "disabled",
    executable_execution_revision: undefined,
  };
  assertAgentDisabled(disabled);
  assert.throws(() =>
    assertAgentDisabled({ ...disabled, activation_state: "enabled" }),
  );
});

test("readiness wait reads independently after creation and can be cancelled", async () => {
  let reads = 0;
  assert.equal(
    await waitForAgentReady(async () =>
      ++reads === 1 ? { ...ready, runtime_state: "waiting" } : ready,
    ),
    ready,
  );
  assert.equal(reads, 2);
  await assert.rejects(
    waitForAgentReady(async () => ready, AbortSignal.abort()),
  );
});

test("enable acceptance waits through unknown and waiting without reusing the old binding", async () => {
  const states = [
    {
      ...ready,
      runtime_state: "unknown",
      executable_execution_revision: undefined,
    },
    {
      ...ready,
      runtime_state: "waiting",
      executable_execution_revision: undefined,
    },
    { ...ready, executable_execution_revision: "new-execution" },
  ];
  let reads = 0;
  assert.equal(await waitForAgentReady(async () => states[reads++]), states[2]);
  assert.equal(reads, 3);
});
