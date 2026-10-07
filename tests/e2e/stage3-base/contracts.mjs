import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// This assertion applies to fresh resources in a disposable deployment only.
// Product consumers continue to treat already-issued IDs as opaque strings.
export function assertResourceId(kind, value) {
  assert.match(
    value,
    new RegExp(`^${kind}_[0-9a-f]{32}$`),
    `${kind} resource ID format`,
  );
}

export function assertWorkspaceProjection(bootstrap, state, agentId) {
  const agent = bootstrap.agents.find((item) => item.agent_id === agentId);
  assert(agent, "Agent missing from management discovery");
  assert.equal(agent.lifecycle_state, "created");
  assert.equal(agent.activation_state, "enabled");
  assert.equal(agent.runtime_state, "available");
  assert(
    !Object.hasOwn(agent, "availability"),
    "bootstrap must not own execution availability",
  );
  assert(!JSON.stringify(bootstrap).includes("agent_access_subject"));
  assert.equal(state.agent_id, agentId);
  assert.equal(state.access_allowed, true);
  assert.equal(state.availability, "ready");
  assert.match(state.configuration_revision, /^[a-f0-9]{64}$/);
}

export function modelParameters(model) {
  return Object.fromEntries(
    [
      "model",
      "context_window",
      "max_output_tokens",
      "temperature",
      "supports_images",
      "supports_audio",
      "supports_pdf",
      "pricing",
    ]
      .filter((key) => model[key] !== undefined)
      .map((key) => [key, structuredClone(model[key])]),
  );
}

export function modelEdit(current) {
  assert(Number.isSafeInteger(current.revision) && current.revision > 0);
  assert(current.model_profile_id && current.model.model);
  return {
    expected_version: current.revision,
    display_name: `${current.display_name} updated`,
    model: {
      ...modelParameters(current.model),
      context_window: 16384,
      max_output_tokens: 2048,
    },
  };
}
export function templateInput(model, name) {
  assert(model.model_profile_id);
  return {
    name,
    model_profile_id: model.model_profile_id,
    system_prompt: "Use the requested tool.",
    max_model_requests: 8,
  };
}
export function assertBuildSnapshot(agent, template, model) {
  const c = agent.configuration;
  assert.equal(c.template.template_id, template.template_id);
  assert.equal(c.template.revision, template.revision);
  assert.equal(c.model_profile.model_profile_id, model.model_profile_id);
  assert.equal(c.model_profile.revision, model.revision);
  for (const key of [
    "model",
    "context_window",
    "max_output_tokens",
    "supports_images",
  ])
    assert.deepEqual(
      c.model_profile.model[key],
      model.model[key],
      `build snapshot drift: ${key}`,
    );
  assert.equal(c.max_model_requests, template.max_model_requests);
  assert.equal(c.runtime.image_ref, template.runtime.image_ref);
  assert(
    !/"(?:credential_ref|credential_version|runtime_execution_id|mcp_endpoint)"/.test(
      JSON.stringify(agent),
    ),
    "internal build data leaked",
  );
}
export function runtimeCommandId(requestId, phase) {
  return (
    "acr_" +
    createHash("sha256")
      .update(`${requestId}\0${phase}`)
      .digest("hex")
      .slice(0, 32)
  );
}
export function assertRuntimeOperation(operation, expected) {
  assert.equal(operation.agent_id, expected.agentId);
  assert.equal(
    operation.request_id,
    runtimeCommandId(expected.requestId, expected.phase),
  );
  assert.equal(operation.kind, `${expected.phase.slice(8)}_runtime`);
  assert.equal(operation.state, "completed");
  assert.equal(operation.effect, "completed");
  assert.equal(operation.target_revision, expected.runtimeRevision);
}
