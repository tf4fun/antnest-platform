import type {
  ConnectionBinding,
  RunExecutionSnapshot,
  SessionRecord,
} from "../../src/domain/types.js";
import {
  configurationView,
  type ConfigurationCatalog,
} from "../../src/domain/session-configuration.js";

export function configurationCatalog(): ConfigurationCatalog & { nextCursor: string } {
  const model = {
    modelProfileId: "profile-1",
    displayName: "Example model",
    model: "example-model",
    contextWindow: 64000,
    maxOutputTokens: 4096,
    supportsImages: false,
  };
  return {
    models: [model],
    defaultModel: { ...model, available: true },
    defaultAuthorization: { mode: "auto", toolRules: [] },
    authorizationRevision: 1,
    nextCursor: "",
  };
}

export function sessionConfigurationView() {
  return configurationView({}, configurationCatalog());
}

export function binding(): ConnectionBinding {
  return {
    connectionId: "connection-1",
    organizationId: "organization-1",
    principalId: "principal-1",
    agentId: "agent-1",
  };
}

export function identityHeaders(
  identity: Pick<ConnectionBinding, "organizationId" | "principalId" | "agentId"> = binding(),
): Record<string, string> {
  return {
    "x-antnest-organization-id": identity.organizationId,
    "x-antnest-principal-id": identity.principalId,
    "x-antnest-agent-id": identity.agentId,
  };
}

export function snapshot(): RunExecutionSnapshot {
  return {
    organizationId: "organization-1",
    providerConnectionId: "connection-1",
    modelProfileId: "profile-1",
    configurationRevision: 1,
    accessRevision: "access-1",
    deadlineAt: new Date("2026-08-30T00:10:00Z"),
    agentSpecRevision: "config-1",
    executionRevision: "execution-1",
    runtimeMcpSourceDigest: "a".repeat(64),
    agentExecutionSpecDigest: "b".repeat(64),
    runtime: {
      revision: "runtime-1",
      executionId: "runtime-execution-1",
      mcpEndpoint: "http://runtime-1:8080/mcp",
    },
    executionSpec: {
      systemPrompt: "system",
      contextPolicyVersion: "context-v1",
      skillInstructions: [],
      model: {
        baseUrl: "https://api.example.test/v1",
        model: "example-model",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        supportsImages: false,
      },
      maxModelRequests: 4,
    },
    clientMcpRevisionId: "client-mcp-1",
  };
}

export function sessionRecord(): SessionRecord {
  return {
    id: "session-1",
    organizationId: "organization-1",
    principalId: "principal-1",
    agentId: "agent-1",
    cwd: "/workspace",
    state: "active",
    title: null,
    forkedFromSessionId: null,
    clientMcpRevisionId: "client-mcp-1",
    lastExecutionRevision: null,
    lastMessageSequence: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
