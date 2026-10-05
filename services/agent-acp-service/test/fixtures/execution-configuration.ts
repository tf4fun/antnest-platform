import type {
  ExecutionConfiguration,
  ProviderConfiguration,
} from "../../src/domain/execution-configuration.js";

export function executionConfiguration(): Omit<ExecutionConfiguration, "providers"> & {
  providers: Extract<ProviderConfiguration, { enabled: true }>[];
} {
  return {
    organization_id: "organization-1",
    revision: 1,
    providers: [
      {
        connection_id: "provider-1",
        provider_key: "deepseek" as const,
        request_protocol: "openai_chat_completions" as const,
        base_url: "https://api.deepseek.com",
        enabled: true as const,
        credential_revision: "credential-1",
        credential: { method: "api_key" as const, secret: "synthetic-provider-key" },
      },
    ],
    models: [
      {
        model_profile_id: "model-1",
        connection_id: "provider-1",
        display_name: "Test model",
        enabled: true,
        model: "test-model",
        context_window: 64000,
        max_output_tokens: 4096,
        supports_images: false,
      },
    ],
    agents: [
      {
        agent_id: "agent-1",
        principal_ids: ["principal-1"],
        access_revision: "access-1",
        accepting_runs: true,
        unavailable_reason: null,
        operation_id: null,
        default_model_profile_id: "model-1",
        default_authorization: { mode: "approve" as const, tool_rules: [] },
        authorization_revision: 1,
        agent_spec_revision: "agent-spec-1",
        execution_revision: "execution-1",
        system_prompt: "You are a helpful assistant.",
        context_policy_version: "context-v1" as const,
        skill_instructions: [],
        max_model_requests: 8,
        runtime: runtimeConfiguration(),
      },
    ],
  };
}

/** Public synthetic conformance credentials; never install this fixture in a deployment. */
export function runtimeConfiguration(generation = 1) {
  const suffix = generation.toString(16).padStart(1, "0").repeat(32);
  return {
    runtime_revision: "rtv_" + suffix,
    runtime_execution_id: "runtime-execution-" + generation,
    mcp_endpoint: "http://runtime-" + generation + ":8080/mcp",
    connection_id: "rci_" + suffix,
    credential: {
      caller: "agent-acp-service" as const,
      token:
        generation === 1
          ? "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
          : Buffer.alloc(32, generation).toString("base64url"),
    },
  };
}

export function closedExecutionAgent(agent: ExecutionConfiguration["agents"][number]) {
  const closed = structuredClone(agent);
  closed.accepting_runs = false;
  if (closed.runtime !== null) delete closed.runtime.credential;
  return closed;
}

export function executionIdentity() {
  return {
    organizationId: "organization-1",
    principalId: "principal-1",
    agentId: "agent-1",
  };
}
