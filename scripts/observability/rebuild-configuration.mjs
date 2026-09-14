import assert from "node:assert/strict";
import { assertAgentReady } from "../verification/agent-state.mjs";

const identity = (agent) => ({
  agent_id: agent.agent_id,
  owner_user_id: agent.owner_user_id,
  spec: agent.agent_spec_revision,
  execution: agent.executable_execution_revision,
  runtime: agent.runtime,
  configuration: agent.configuration,
});

export function assertPublishedTemplateIsolated(before, current) {
  assertAgentReady(before);
  assertAgentReady(current);
  assert.deepEqual(
    identity(current),
    identity(before),
    "template publication changed the existing Agent",
  );
}

export function assertRebuiltConfiguration(before, current, template, model) {
  assertAgentReady(before);
  assertAgentReady(current);
  assert.equal(current.agent_id, before.agent_id);
  assert.equal(current.owner_user_id, before.owner_user_id);
  for (const field of ["agent_spec_revision", "executable_execution_revision"])
    assert(
      current[field] && current[field] !== before[field],
      `${field} was not replaced`,
    );
  assert(
    current.runtime.runtime_revision &&
      current.runtime.runtime_revision !== before.runtime.runtime_revision,
    "runtime_revision was not replaced",
  );

  const actual = current.configuration;
  assert.equal(actual?.template?.template_id, template.template_id);
  assert.equal(actual.template.revision, template.revision);
  assert.equal(
    actual.model_profile?.model_profile_id,
    template.model_profile_id,
  );
  assert.equal(model.model_profile_id, template.model_profile_id);
  assert(
    model.revision_id && Number.isInteger(model.revision) && model.revision > 0,
  );
  assert(model.model && typeof model.model.model === "string");
  assert.equal(actual.model_profile.revision_id, model.revision_id);
  assert.equal(actual.model_profile.revision, model.revision);
  assert.deepEqual(actual.model_profile.model, model.model);
  assert.equal(actual.max_model_requests, template.max_model_requests);
  assert.equal(actual.runtime?.image_ref, template.runtime.image_ref);
  assert.deepEqual(actual.runtime.resources, template.runtime.resources);
}
