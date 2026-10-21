import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "./contracts.mjs";
const {
  assertResourceId,
  modelEdit,
  templateInput,
  assertBuildSnapshot,
  assertRuntimeOperation,
} = contracts;
import { assertWorkspaceProjection } from "./workspace-contracts.mjs";

const principal = {
  user_id: "member",
  organization_id: "organization",
  organization_slug: "stage3",
  organization_name: "Stage 3",
  system_role: "user",
  organization_role: "member",
};
const bootstrap = {
  principal: {
    userId: "member",
    organizationId: "organization",
    organizationSlug: "stage3",
    organizationName: "Stage 3",
    administrator: false,
  },
  agents: [
    {
      agentId: "a",
      name: "Agent",
      lifecycle: "created",
      activation: "enabled",
      runtime: "available",
    },
  ],
  renderedAt: "2026-10-18T00:00:00Z",
  bridgeEpoch: "epoch",
};
const state = {
  agent_id: "a",
  access_allowed: true,
  availability: "ready",
  configuration_revision: "a".repeat(64),
  active_session_id: null,
  unavailable_reason: null,
};
test("current bootstrap binds the original member and complete ACP execution state", () => {
  assertWorkspaceProjection(bootstrap, state, "a", principal);
});
for (const [name, change] of [
  [
    "admin substitution",
    (b) => {
      b.principal.administrator = true;
    },
  ],
  [
    "foreign user",
    (b) => {
      b.principal.userId = "other";
    },
  ],
  [
    "foreign organization",
    (b) => {
      b.principal.organizationId = "other";
    },
  ],
  [
    "foreign display",
    (b) => {
      b.principal.organizationName = "Other";
    },
  ],
  [
    "extra Agent",
    (b) => {
      b.agents.push({ ...b.agents[0], agentId: "foreign" });
    },
  ],
  [
    "execution authority in bootstrap",
    (b) => {
      b.agents[0].availability = "ready";
    },
  ],
  [
    "internal subject",
    (b) => {
      b.agent_access_subject = "private";
    },
  ],
  [
    "retired DTO",
    (b) => {
      b.agents = [
        {
          agent_id: "a",
          lifecycle_state: "created",
          activation_state: "enabled",
          runtime_state: "available",
        },
      ];
    },
  ],
])
  test("bootstrap rejects " + name, () => {
    const b = structuredClone(bootstrap);
    change(b);
    assert.throws(() => assertWorkspaceProjection(b, state, "a", principal));
  });
for (const change of [
  { access_allowed: false },
  { configuration_revision: null },
  { agent_id: "foreign" },
  { availability: "offline" },
])
  test(
    "ACP execution evidence cannot be replaced " + JSON.stringify(change),
    () => {
      assert.throws(() =>
        assertWorkspaceProjection(
          bootstrap,
          { ...state, ...change },
          "a",
          principal,
        ),
      );
    },
  );

const model = {
  model_profile_id: "model-1",
  revision: 4,
  display_name: "Primary",
  model: {
    base_url: "http://provider-peer/v1",
    model: "api-name",
    context_window: 8192,
    max_output_tokens: 1024,
    supports_images: false,
  },
};
test("current edits keep stable Model identity and require the observed version", () => {
  const edit = modelEdit(model);
  assert.deepEqual(edit, {
    expected_version: 4,
    display_name: "Primary updated",
    model: {
      model: "api-name",
      supports_images: false,
      context_window: 16384,
      max_output_tokens: 2048,
    },
  });
  assert.deepEqual(templateInput(model, "Primary template"), {
    name: "Primary template",
    model_profile_id: "model-1",
    system_prompt: "Use the requested tool.",
    max_model_requests: 8,
  });
  assert.throws(() => modelEdit({ ...model, revision: undefined }));
});
const template = {
  template_id: "template-1",
  revision: 2,
  name: "Primary template",
  max_model_requests: 8,
  runtime: { image_ref: `sha256:${"a".repeat(64)}` },
};
const agent = {
  configuration: {
    template: { template_id: template.template_id, revision: 2 },
    model_profile: {
      model_profile_id: model.model_profile_id,
      revision: 4,
      model: model.model,
    },
    runtime: template.runtime,
    max_model_requests: 8,
  },
};
test("Agent build evidence rejects catalog drift and internal credential leakage", () => {
  assertBuildSnapshot(agent, template, model);
  for (const change of [
    (a) => a.configuration.model_profile.model.context_window++,
    (a) => a.configuration.template.revision++,
    (a) => (a.configuration.runtime.mcp_endpoint = "private"),
  ]) {
    const changed = structuredClone(agent);
    change(changed);
    assert.throws(() => assertBuildSnapshot(changed, template, model));
  }
});
test("Runtime completion must match the deterministic lifecycle command and generation", async () => {
  const expected = {
    agentId: "agent-1",
    requestId: "operation-1",
    phase: "runtime_update",
    runtimeRevision: "runtime-2",
  };
  const operation = {
    agent_id: "agent-1",
    request_id: "acr_2e47b95c6d6cd170415a4f341206a8f19",
    state: "completed",
    effect: "completed",
    target_revision: "runtime-2",
    kind: "update_runtime",
  };
  // The ID is computed independently from the contract helper.
  const { createHash } = await import("node:crypto");
  operation.request_id =
    "acr_" +
    createHash("sha256")
      .update("operation-1\0runtime_update")
      .digest("hex")
      .slice(0, 32);
  assertRuntimeOperation(operation, expected);
  for (const key of [
    "agent_id",
    "request_id",
    "target_revision",
    "state",
    "effect",
    "kind",
  ]) {
    assert.throws(() =>
      assertRuntimeOperation({ ...operation, [key]: "wrong" }, expected),
    );
  }
});

test("new resource IDs preserve kind and use exactly 32 lowercase hex digits", () => {
  for (const kind of [
    "agent",
    "session",
    "run",
    "message",
    "org",
    "user",
    "membership",
    "provider",
    "model",
    "template",
    "event",
    "scimtoken",
    "rtv",
  ]) {
    assertResourceId(kind, `${kind}_${"a0".repeat(16)}`);
    for (const invalid of [
      "",
      "b68d13dc-4561-4a45-af5b-10cff87dffd5",
      `${kind}_${"A".repeat(32)}`,
      `${kind}_${"a".repeat(31)}`,
      `${kind}_${"a".repeat(33)}`,
      `other_${"a".repeat(32)}`,
    ]) {
      assert.throws(() => assertResourceId(kind, invalid));
    }
  }
});

function readyEventFixture() {
  // Original Admin agentEventProjectionSource fields; Trace is optional there.
  return {
    event_id: "event_" + "a".repeat(32),
    global_sequence: 10,
    aggregate_sequence: 3,
    schema_version: 1,
    agent_id: "agent_" + "b".repeat(32),
    event_type: "agent_ready",
    operation_request_id: "ready-operation",
    trace_id: "c".repeat(32),
    occurred_at: "2026-10-22T00:00:00Z",
  };
}

function findReady(events, requestId = "ready-operation") {
  assert.equal(
    typeof contracts.findAgentReadyEvent,
    "function",
    "findAgentReadyEvent is required",
  );
  return contracts.findAgentReadyEvent(events, requestId);
}

test("Agent ready business finds the original event for its lifecycle operation", () => {
  const ready = readyEventFixture();
  const events = [
    { ...ready, event_type: "agent_created" },
    { ...ready, operation_request_id: "another-operation" },
    ready,
  ];
  const before = structuredClone(events);
  assert.equal(findReady(events), ready);
  assert.deepEqual(events, before);
});

test("Agent ready business accepts a missing Trace without altering the original event", () => {
  const ready = readyEventFixture();
  delete ready.trace_id;
  const events = [ready],
    before = structuredClone(events);
  assert.equal(findReady(events), ready);
  assert.deepEqual(events, before);
  assert(!Object.hasOwn(ready, "trace_id"));
});

test("Agent ready business accepts malformed Trace values without rewriting raw evidence", () => {
  for (const trace_id of [
    null,
    "",
    "invalid-trace",
    "A".repeat(32),
    "a".repeat(31),
  ]) {
    const ready = { ...readyEventFixture(), trace_id };
    const events = [ready],
      before = structuredClone(events);
    assert.equal(findReady(events), ready);
    assert.deepEqual(events, before);
  }
});

test("Agent ready business does not require matching events to be unique", () => {
  const first = readyEventFixture(),
    second = { ...first, global_sequence: 11 };
  const events = [first, second],
    before = structuredClone(events);
  assert.equal(findReady(events), first);
  assert.deepEqual(events, before);
});

test("Agent ready business still rejects a different event type or lifecycle operation", () => {
  const ready = readyEventFixture();
  assert.equal(findReady([ready]), ready);
  for (const events of [
    [{ ...ready, event_type: "agent_created" }],
    [{ ...ready, operation_request_id: "another-operation" }],
    [{ ...ready, operation_request_id: undefined }],
    [
      { ...ready, event_type: "agent_created" },
      { ...ready, operation_request_id: "another-operation" },
    ],
  ])
    assert.throws(() => findReady(events));
  assert.throws(() => findReady([ready], "another-operation"));
});

test("Agent ready business rejects missing or empty original event inventory", () => {
  const ready = readyEventFixture();
  assert.equal(findReady([ready]), ready);
  for (const events of [undefined, null, {}, []])
    assert.throws(() => findReady(events));
});
