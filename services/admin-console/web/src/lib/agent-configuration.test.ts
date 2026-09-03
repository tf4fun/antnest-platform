import assert from "node:assert/strict";
import test from "node:test";
import { agentConfigurationLinks, agentConfigurationSummary } from "./agent-configuration.ts";
import type { Agent } from "./types.ts";

test("agentConfigurationSummary renders exact executable revisions", () => {
  const agent = {
    agent_id: "agent-1",
    owner_user_id: "user-1",
    name: "Research Agent",
    desired_state: "enabled",
    lifecycle_state: "available",
    aggregate_sequence: 4,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    configuration: {
      template: { template_id: "template-1", revision: 2, name: "Research" },
      model_profile: {
        model_profile_id: "model-1",
        revision_id: "model-revision-4",
        revision: 4,
        name: "DeepSeek",
        model: {
          base_url: "https://api.deepseek.com/v1",
          model: "deepseek-chat",
          context_window: 128000,
          max_output_tokens: 8192,
          supports_images: false,
        },
      },
      max_model_requests: 24,
      context_policy_version: "context-v1",
      runtime: {
        image_ref:
          "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        resources: {
          memory_bytes: 536870912,
          pids_limit: 256,
          tmpfs_bytes: 67108864,
        },
      },
    },
  } satisfies Agent;

  assert.deepEqual(agentConfigurationSummary(agent), {
    template: "Research · revision 2",
    model: "DeepSeek · deepseek-chat",
    modelRevision: "revision 4",
    limits: "128,000 context · 8,192 max output",
    executionPolicy: "24 model requests · context-v1",
    runtimeImage: agent.configuration.runtime.image_ref,
  });
});

test("agentConfigurationSummary does not invent unpublished configuration", () => {
  const agent = {
    agent_id: "agent-1",
    owner_user_id: "user-1",
    name: "Provisioning Agent",
    desired_state: "enabled",
    lifecycle_state: "provisioning",
    aggregate_sequence: 1,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
  } satisfies Agent;

  assert.equal(agentConfigurationSummary(agent), undefined);
});

test("agentConfigurationLinks preserve exact immutable revisions", () => {
  const agent = {
    configuration: {
      template: { template_id: "template-1", revision: 2, name: "Research" },
      model_profile: {
        model_profile_id: "model-1",
        revision_id: "model-revision-4",
        revision: 4,
        name: "Reasoning",
        model: {
          base_url: "https://example.test/v1",
          model: "reasoner",
          context_window: 128_000,
          max_output_tokens: 8_192,
          supports_images: false,
        },
      },
      max_model_requests: 8,
      context_policy_version: "context-v1",
      runtime: {
        image_ref: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        resources: { memory_bytes: 1, pids_limit: 1, tmpfs_bytes: 1 },
      },
    },
  } as Agent;

  assert.deepEqual(agentConfigurationLinks(agent), {
    template: "#templates/template-1/revisions/2",
    model: "#models/model-1/revisions/model-revision-4",
  });
});
