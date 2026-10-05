import type { RuntimeInformation } from "../../src/domain/runtime-information.js";
import type { RunExecutionSnapshot } from "../../src/domain/types.js";

export function runtimeInformation(): RuntimeInformation {
  return {
    executionId: "runtime-execution-1",
    environment: { os: "linux", arch: "aarch64", home: "/workspace", workspace: "/workspace" },
    instructions: {
      path: { root: "workspace", path: "AGENTS.md" },
      content: "Use the company style guide",
      truncated: false,
    },
    skills: [
      {
        source: "system",
        name: "documents",
        description: "Find company documents",
        path: { root: "system_skills", path: "documents/SKILL.md" },
      },
    ],
    warnings: [],
    truncated: false,
  };
}

export function runtimeSnapshot(): RunExecutionSnapshot {
  return {
    organizationId: "organization-1",
    providerConnectionId: "connection-1",
    modelProfileId: "profile-1",
    configurationRevision: 1,
    accessRevision: "access-1",
    deadlineAt: new Date(Date.now() + 60000),
    agentSpecRevision: "spec-1",
    executionRevision: "execution-1",
    runtimeMcpSourceDigest: "a".repeat(64),
    agentExecutionSpecDigest: "b".repeat(64),
    runtime: {
      revision: "runtime-1",
      executionId: "runtime-execution-1",
      mcpEndpoint: "http://runtime:8080/mcp",
      connectionId: "rci_11111111111111111111111111111111",
    },
    executionSpec: {
      systemPrompt: "Be helpful",
      contextPolicyVersion: "context-v1",
      skillInstructions: [],
      maxModelRequests: 4,
      model: {
        baseUrl: "http://model:8080/v1",
        model: "example",
        contextWindow: 64000,
        maxOutputTokens: 4096,
        supportsImages: false,
      },
    },
    clientMcpRevisionId: "client-mcp-1",
  };
}

export function emptyRuntimePreparation() {
  const information = runtimeInformation();
  information.instructions = null;
  information.skills = [];
  return {
    runtimeInformation: { read: () => Promise.resolve(information) },
    tools: { list: () => Promise.resolve([]) },
  };
}
