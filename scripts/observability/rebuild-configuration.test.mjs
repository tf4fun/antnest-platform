import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublishedTemplateIsolated,
  assertRebuiltConfiguration,
} from "./rebuild-configuration.mjs";

const runtime = (suffix) => ({
  runtime_revision: `runtime-${suffix}`,
});
const modelProfile = (suffix) => ({
  model_profile_id: `model-${suffix}`,
  revision_id: `model-revision-${suffix}`,
  revision: 1,
  model: { model: `model-${suffix}`, context_window: suffix * 10000 },
});
const verify = (before, current, target) =>
  assertRebuiltConfiguration(before, current, target, modelProfile(2));
const configuration = (revision) => ({
  template: { template_id: "template", revision },
  model_profile: modelProfile(revision),
  max_model_requests: revision * 8,
  runtime: {
    image_ref: "antnest/antnest-runtime:local",
    resources: {
      memory_bytes: revision * 268435456,
      pids_limit: revision * 64,
      tmpfs_bytes: revision * 16777216,
    },
  },
});
const agent = (revision) => ({
  agent_id: "agent",
  owner_user_id: "owner",
  lifecycle_state: "created",
  activation_state: "enabled",
  desired_state: "enabled",
  runtime_state: "available",
  agent_spec_revision: `spec-${revision}`,
  executable_execution_revision: `execution-${revision}`,
  runtime: runtime(revision),
  configuration: configuration(revision),
});
const template = {
  template_id: "template",
  revision: 2,
  model_profile_id: "model-2",
  max_model_requests: 16,
  runtime: configuration(2).runtime,
};

test("template publication does not change an existing Agent or start rebuilding", () => {
  assertPublishedTemplateIsolated(agent(1), agent(1));
  for (const change of [
    { active_operation_request_id: "rebuild" },
    { agent_spec_revision: "spec-2" },
    { executable_execution_revision: "execution-2" },
    { runtime: runtime(2) },
    { configuration: configuration(2) },
    { runtime_state: "waiting" },
  ])
    assert.throws(() =>
      assertPublishedTemplateIsolated(agent(1), { ...agent(1), ...change }),
    );
});

test("explicit rebuild replaces execution and applies the selected configuration", () => {
  verify(agent(1), agent(2), template);
  for (const field of ["agent_spec_revision", "executable_execution_revision"])
    assert.throws(() =>
      verify(agent(1), { ...agent(2), [field]: agent(1)[field] }, template),
    );
  for (const field of ["runtime_revision"])
    assert.throws(() =>
      verify(
        agent(1),
        { ...agent(2), runtime: { ...runtime(2), [field]: runtime(1)[field] } },
        template,
      ),
    );
});

test("a new revision alone cannot prove new configuration was applied", () => {
  for (const field of [
    "template",
    "model_profile",
    "max_model_requests",
    "runtime",
  ])
    assert.throws(() =>
      verify(
        agent(1),
        {
          ...agent(2),
          configuration: {
            ...configuration(2),
            [field]: configuration(1)[field],
          },
        },
        template,
      ),
    );
  assert.throws(() =>
    verify(agent(1), { ...agent(2), owner_user_id: "another-owner" }, template),
  );
  assert.throws(() =>
    verify(
      agent(1),
      { ...agent(2), active_operation_request_id: "rebuild" },
      template,
    ),
  );
});
test("a new model ID must not hide a stale or missing model body or revision", () => {
  for (const override of [
    { model: modelProfile(1).model },
    { model: undefined },
    { revision_id: modelProfile(1).revision_id },
    { revision_id: undefined },
    { revision: 0 },
    { revision: undefined },
  ]) {
    const current = agent(2);
    current.configuration.model_profile = { ...modelProfile(2), ...override };
    assert.throws(() => verify(agent(1), current, template));
  }
});
