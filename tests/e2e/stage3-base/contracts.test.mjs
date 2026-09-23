import assert from "node:assert/strict";
import test from "node:test";
import {
  modelEdit,
  templateInput,
  assertBuildSnapshot,
  assertRuntimeOperation,
  assertWorkspaceProjection,
} from "./contracts.mjs";

test("bootstrap exposes management facts while ACP state owns execution availability", () => {
  const bootstrap = {
    agents: [
      {
        agent_id: "a",
        lifecycle_state: "created",
        activation_state: "enabled",
        runtime_state: "available",
      },
    ],
  };
  const state = {
    agent_id: "a",
    access_allowed: true,
    availability: "ready",
    configuration_revision: "a".repeat(64),
  };
  assertWorkspaceProjection(bootstrap, state, "a");
  assert.throws(() =>
    assertWorkspaceProjection(
      { agents: [{ ...bootstrap.agents[0], availability: "ready" }] },
      state,
      "a",
    ),
  );
  assert.throws(() =>
    assertWorkspaceProjection(
      bootstrap,
      { ...state, access_allowed: false },
      "a",
    ),
  );
  assert.throws(() =>
    assertWorkspaceProjection(
      bootstrap,
      { ...state, configuration_revision: null },
      "a",
    ),
  );
});

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
