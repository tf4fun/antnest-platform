import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./loss-model.mjs";
import {
  assertLoss,
  assertReplacement,
  assertOwnedRuntime,
  assertLossDenial,
  assertLossProducer,
  assertLossBinding,
} from "./loss-evidence.mjs";

function payload(phase) {
  return {
    model: "stage3-model",
    tools: ["bash", "read"].map((name) => ({ function: { name } })),
    messages: [
      {
        role: "system",
        content: "Your isolated execution environment was rebuilt",
      },
      { role: "user", content: phase },
    ],
  };
}

for (const mode of ["live", "cold"]) {
  test(`${mode} loss requires actual append then exact read, with a reset notice`, () => {
    const before = `c5-${mode}-before`,
      after = `c5-${mode}-after`;
    assert.equal(decide(payload(before)).call.name, "bash");
    assert.equal(decide(payload(after)).call.name, "read");
    for (const [phase, content] of [
      [before, `${mode}-written`],
      [after, JSON.stringify({ content: `${mode}-preserved\n` })],
    ]) {
      const input = payload(phase);
      input.messages.push({ role: "tool", content });
      assert.equal(decide(input).text, `${phase} completed`);
      input.messages.push(input.messages.at(-1));
      assert.throws(() => decide(input));
    }
    const noNotice = payload(after);
    noNotice.messages.shift();
    assert.throws(() => decide(noNotice));
    for (const content of [
      "",
      "changed",
      `${mode}-preserved\n${mode}-preserved\n`,
    ]) {
      const input = payload(after);
      input.messages.push({
        role: "tool",
        content: JSON.stringify({ content }),
      });
      assert.throws(() => decide(input));
    }
    assert.throws(() => decide({ ...payload(before), tools: [] }));
  });
}

test("unexpected or denied prompts cannot be executed by the fixture", () => {
  for (const phase of ["c5-live-denied", "c5-cold-denied", "other"])
    assert.throws(() => decide(payload(phase)));
});

const initial = () => ({
  agent: {
    agent_id: "a",
    desired_state: "enabled",
    lifecycle_state: "available",
    agent_spec_revision: "s1",
    last_successful_execution_revision: "e1",
    executable_execution_revision: "e1",
    runtime: { runtime_revision: "r1" },
    aggregate_sequence: 2,
  },
  container: { Id: "old" },
  volume: "workspace-a",
});
function lost() {
  return {
    ...initial().agent,
    lifecycle_state: "unavailable",
    runtime: undefined,
    executable_execution_revision: undefined,
    failure_stage: "runtime_observation",
    failure_code: "runtime_missing",
    aggregate_sequence: 3,
  };
}
function events() {
  return [
    {
      agent_id: "a",
      event_id: "loss",
      event_type: "agent_runtime_missing",
      global_sequence: 3,
      data: {
        reason: "runtime_missing",
        runtime_revision: "r1",
        observation_sequence: 7,
      },
    },
  ];
}
test("loss evidence requires absent executable binding and exact prior lineage/audit", () => {
  const recorded = events()[0];
  const publicEvents = events().map(({ data, ...event }) => event);
  assertLoss(initial(), lost(), publicEvents, recorded);
  assert.throws(() => assertLoss(initial(), lost(), publicEvents));
  assert.throws(() =>
    assertLoss(initial(), lost(), publicEvents, {
      ...recorded,
      global_sequence: 9,
    }),
  );
  for (const change of [
    { lifecycle_state: "available" },
    { desired_state: "disabled" },
    { agent_spec_revision: "other" },
    { executable_execution_revision: "e1" },
    { runtime: { runtime_revision: "r1" } },
    { last_successful_execution_revision: "other" },
    { active_operation_request_id: "op" },
    { failure_code: "dependency_unavailable" },
    { aggregate_sequence: 2 },
  ])
    assert.throws(() =>
      assertLoss(initial(), { ...lost(), ...change }, publicEvents, recorded),
    );
  for (const changed of [
    [],
    [...events(), ...events()],
    [{ ...events()[0], agent_id: "other" }],
    [{ ...events()[0], operation_request_id: "old-create" }],
    [
      {
        ...events()[0],
        data: { ...events()[0].data, runtime_revision: "other" },
      },
    ],
  ])
    assert.throws(() => assertLoss(initial(), lost(), changed, changed[0]));
});

function replacement() {
  return {
    agent: {
      ...initial().agent,
      agent_spec_revision: "s2",
      executable_execution_revision: "e2",
      last_successful_execution_revision: "e2",
      runtime: { runtime_revision: "r2" },
      aggregate_sequence: 5,
    },
    container: { Id: "new" },
    volume: "workspace-a",
  };
}
test("replacement cannot pass with old compute, stale binding or a new workspace", () => {
  assertReplacement(initial(), replacement());
  for (const change of [
    { container: { Id: "old" } },
    { volume: "new-volume" },
    { agent: { ...replacement().agent, runtime: initial().agent.runtime } },
    { agent: { ...replacement().agent, executable_execution_revision: "e1" } },
    { agent: { ...replacement().agent, lifecycle_state: "unavailable" } },
  ])
    assert.throws(() =>
      assertReplacement(initial(), { ...replacement(), ...change }),
    );
});

test("fault targeting rejects conflicting scope, Agent, or container identity", () => {
  const container = {
    Id: "old",
    State: { Running: true },
    Config: {
      Labels: {
        "io.antnest.runtime-controller-scope": "antnest-lifecycle-ab123456",
        "io.antnest.agent-id": "a",
      },
    },
  };
  assertOwnedRuntime(container, initial(), "antnest-lifecycle-ab123456");
  for (const value of ["", "other"]) {
    assert.throws(() =>
      assertOwnedRuntime(
        { ...container, Id: value },
        initial(),
        "antnest-lifecycle-ab123456",
      ),
    );
    assert.throws(() => assertOwnedRuntime(container, initial(), value));
  }
  assert.throws(() =>
    assertOwnedRuntime(
      {
        ...container,
        Config: {
          Labels: {
            ...container.Config.Labels,
            "com.docker.compose.project": "retained",
          },
        },
      },
      initial(),
      "antnest-lifecycle-ab123456",
    ),
  );
});

test("loss denial must be a semantic admission failure, not a timeout or disconnect", () => {
  assertLossDenial({
    code: -32021,
    data: { code: "agent_build_failed", retryable: false },
  });
  for (const error of [
    new Error("closed"),
    { code: -32021, data: { code: "agent_rebuilding", retryable: true } },
    { code: -32021, data: { code: "dependency_unavailable", retryable: true } },
  ])
    assert.throws(() => assertLossDenial(error));
});

test("Runtime loss clears executable identity but retains the spec needed for Rebuild", () => {
  const binding = {
    runtime_revision: "r1",
    executable_spec_revision_id: "s1",
    last_successful_execution_revision_id: "e1",
    runtime_execution_id: "",
    runtime_mcp_endpoint: "",
    executable_execution_revision_id: "",
  };
  assertLossBinding(initial(), binding);
  for (const change of [
    { executable_spec_revision_id: "" },
    { last_successful_execution_revision_id: "" },
    { runtime_execution_id: "old" },
    { runtime_mcp_endpoint: "http://old/mcp" },
    { executable_execution_revision_id: "e1" },
  ])
    assert.throws(() =>
      assertLossBinding(initial(), { ...binding, ...change }),
    );
});

for (const mode of ["live", "cold"]) {
  test(`${mode} loss evidence correlates exact producer route and physical identity`, () => {
    const before = initial();
    before.container.Config = {
      Labels: { "io.antnest.runtime-generation": "1" },
    };
    const row = {
      sequence: 7,
      agent_id: "a",
      runtime_revision: "r1",
      generation: 1,
      platform_resource_id: "old",
      kind: mode === "live" ? "runtime_deleted" : "runtime_missing",
      source: mode === "live" ? "docker_event" : "platform_reconciliation",
    };
    const inspection = {
      agent_id: "a",
      runtime_revision: "r1",
      lifecycle_state: "ready",
      health: "absent",
    };
    const loss = {
      ...events()[0],
      data: { ...events()[0].data, reason: row.kind },
    };
    assertLossProducer(mode, before, loss, row, inspection);
    assert.throws(() =>
      assertLossProducer(
        mode,
        before,
        {
          ...loss,
          data: {
            ...loss.data,
            reason: mode === "live" ? "runtime_missing" : "runtime_deleted",
          },
        },
        row,
        inspection,
      ),
    );
    for (const change of [
      { sequence: 6 },
      { agent_id: "b" },
      { runtime_revision: "r2" },
      { generation: 2 },
      { source: "other" },
      { kind: "exited" },
    ])
      assert.throws(() =>
        assertLossProducer(
          mode,
          before,
          loss,
          { ...row, ...change },
          inspection,
        ),
      );
    for (const change of [
      { health: "unknown" },
      { mcp_endpoint: "http://old/mcp" },
      { runtime_execution_id: "old" },
      { runtime_revision: "r2" },
    ])
      assert.throws(() =>
        assertLossProducer(mode, before, loss, row, {
          ...inspection,
          ...change,
        }),
      );
  });
}
