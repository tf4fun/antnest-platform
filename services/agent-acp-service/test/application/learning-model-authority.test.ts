import { describe, expect, it, vi } from "vitest";

import { LearningModelAuthority } from "../../src/application/learning-model-authority.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";
import type { RunExecutionSnapshot } from "../../src/domain/types.js";

const claim: LearningTaskClaim = {
  taskId: "task-1",
  claimId: "claim-1",
  generation: 1,
  organizationId: "org-1",
  agentId: "agent-1",
  ownerId: "owner-1",
  sourceRunId: "run-1",
  frozenPolicy: {},
};
const snapshot: RunExecutionSnapshot = {
  organizationId: "org-1",
  providerConnectionId: "provider-1",
  modelProfileId: "profile-1",
  configurationRevision: 1,
  accessRevision: "access-1",
  deadlineAt: new Date("2026-09-29T00:10:00Z"),
  agentSpecRevision: "spec-1",
  executionRevision: "execution-1",
  runtimeMcpSourceDigest: "a".repeat(64),
  agentExecutionSpecDigest: "b".repeat(64),
  runtime: { revision: "runtime-1", executionId: "execution-1", mcpEndpoint: "http://runtime/mcp" },
  executionSpec: {
    systemPrompt: "original",
    contextPolicyVersion: "context-v1",
    skillInstructions: [],
    model: {
      baseUrl: "https://model.example/v1",
      model: "test-model",
      contextWindow: 64000,
      maxOutputTokens: 4096,
      supportsImages: false,
    },
    maxModelRequests: 4,
  },
  clientMcpRevisionId: "mcp-1",
};
const current = {
  agent: { agent_id: "agent-1", accepting_runs: true },
  configuration: {
    organization_id: "org-1",
    models: [
      {
        model_profile_id: "profile-1",
        connection_id: "provider-1",
        enabled: true,
        model: "test-model",
        context_window: 64000,
        max_output_tokens: 4096,
        supports_images: false,
      },
    ],
    providers: [
      {
        connection_id: "provider-1",
        enabled: true,
        provider_key: "openrouter",
        base_url: "https://model.example/v1",
      },
    ],
  },
};

describe("learning review current model authority", () => {
  it("checks the current owner, Agent, selected model and Provider", () => {
    const directory = { inspect: vi.fn(() => current) };
    new LearningModelAuthority(directory).assertCurrent(claim, snapshot);
    expect(directory.inspect).toHaveBeenCalledWith({
      organizationId: "org-1",
      agentId: "agent-1",
      principalId: "owner-1",
    });
  });

  it("rejects disabled or drifted model routes before review dispatch", () => {
    for (const changed of [
      { ...current, agent: { ...current.agent, accepting_runs: false } },
      { ...current, configuration: { ...current.configuration, organization_id: "other" } },
      {
        ...current,
        configuration: {
          ...current.configuration,
          models: [{ ...current.configuration.models[0]!, enabled: false }],
        },
      },
      {
        ...current,
        configuration: {
          ...current.configuration,
          models: [{ ...current.configuration.models[0]!, model: "changed-model" }],
        },
      },
      {
        ...current,
        configuration: {
          ...current.configuration,
          models: [{ ...current.configuration.models[0]!, max_output_tokens: 2048 }],
        },
      },
      {
        ...current,
        configuration: {
          ...current.configuration,
          providers: [{ ...current.configuration.providers[0]!, enabled: false }],
        },
      },
      {
        ...current,
        configuration: {
          ...current.configuration,
          providers: [
            { ...current.configuration.providers[0]!, base_url: "https://other.example/v1" },
          ],
        },
      },
    ])
      expect(() =>
        new LearningModelAuthority({ inspect: () => changed }).assertCurrent(claim, snapshot),
      ).toThrow();
  });
});
