import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotHash, storedAdmission } from "./rpc-snapshot.mjs";

test("stored admission matches the complete upstream snapshot, not just revision", () => {
  const wire = {
    admission_id: "admission",
    admission_deadline: "2026-09-10T00:00:00Z",
    agent_spec_revision: "spec",
    execution_revision: "execution",
    runtime_mcp_source_digest: "runtime-digest",
    agent_execution_spec_digest: "agent-digest",
    credential_version: "credential",
    runtime: {
      runtime_revision: "runtime",
      runtime_execution_id: "container",
      mcp_endpoint: "http://runtime/mcp",
    },
    execution_spec: {
      system_prompt: "System instruction",
      configuration: {
        model_profile_id: "profile",
        model_profile_revision_id: "revision",
        authorization_revision: 2,
        digest: "digest",
        authorization: {
          mode: "auto",
          tool_rules: [
            {
              source: "runtime",
              source_id: "runtime",
              tool_name: "bash",
              decision: "allow",
            },
          ],
        },
      },
      context_policy_version: "context-v1",
      skill_instructions: [
        { skill_key: "example", version: "1", instructions: "Read carefully" },
      ],
      model: {
        base_url: "http://model/v1",
        model: "model",
        context_window: 64000,
        max_output_tokens: 4096,
        temperature: 0.5,
        supports_images: false,
        supports_audio: false,
        supports_pdf: false,
        pricing: {
          currency: "USD",
          input_per_million: 1,
          output_per_million: 2,
          cache_read_per_million: 0.1,
          cache_write_per_million: 0.2,
        },
      },
      max_model_requests: 4,
      credential_ref: "secret-reference",
    },
  };
  const local = {
    admissionId: "admission",
    admissionDeadline: "2026-09-10T00:00:00.000Z",
    agentSpecRevision: "spec",
    executionRevision: "execution",
    runtimeMcpSourceDigest: "runtime-digest",
    agentExecutionSpecDigest: "agent-digest",
    credentialVersion: "credential",
    clientMcpRevisionId: "client-only",
    runtime: {
      revision: "runtime",
      executionId: "container",
      mcpEndpoint: "http://runtime/mcp",
    },
    executionSpec: {
      systemPrompt: "System instruction",
      configuration: {
        modelProfileId: "profile",
        modelProfileRevisionId: "revision",
        authorizationRevision: 2,
        digest: "digest",
        authorization: {
          mode: "auto",
          toolRules: [
            {
              source: "runtime",
              sourceId: "runtime",
              toolName: "bash",
              decision: "allow",
            },
          ],
        },
      },
      contextPolicyVersion: "context-v1",
      skillInstructions: [
        { skillKey: "example", version: "1", instructions: "Read carefully" },
      ],
      model: {
        baseUrl: "http://model/v1",
        model: "model",
        contextWindow: 64000,
        maxOutputTokens: 4096,
        temperature: 0.5,
        supportsImages: false,
        supportsAudio: false,
        supportsPdf: false,
        pricing: {
          currency: "USD",
          inputPerMillion: 1,
          outputPerMillion: 2,
          cacheReadPerMillion: 0.1,
          cacheWritePerMillion: 0.2,
        },
      },
      maxModelRequests: 4,
      credentialRef: "secret-reference",
    },
  };
  assert.equal(snapshotHash(wire), snapshotHash(storedAdmission(local)));
  for (const mutate of [
    (s) => {
      s.executionSpec.systemPrompt = "";
    },
    (s) => {
      s.executionSpec.skillInstructions = [];
    },
    (s) => {
      s.executionSpec.model.maxOutputTokens = 1024;
    },
    (s) => {
      s.executionSpec.configuration.authorization.mode = "ask";
    },
    (s) => {
      s.executionSpec.configuration.authorization.toolRules[0].decision =
        "deny";
    },
    (s) => {
      s.executionSpec.model.pricing.inputPerMillion = 10;
    },
    (s) => {
      s.runtime.executionId = "different";
    },
    (s) => {
      s.credentialVersion = "different";
    },
  ]) {
    const changed = structuredClone(local);
    mutate(changed);
    assert.notEqual(snapshotHash(wire), snapshotHash(storedAdmission(changed)));
  }
});
