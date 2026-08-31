import { describe, expect, it } from "vitest";

import {
  authorizeSession,
  defaultSessionTitle,
  environmentChangeFact,
  requireWorkspace,
} from "../../src/domain/session.js";
import type {
  ConnectionBinding,
  RunExecutionSnapshot,
  SessionRecord,
} from "../../src/domain/types.js";

const binding: ConnectionBinding = {
  connectionId: "connection-1",
  agentAccessSubject: "subject-1",
  principalId: "principal-1",
  agentId: "agent-1",
  accessRevision: "access-1",
};

const session: SessionRecord = {
  id: "session-1",
  principalId: "principal-1",
  agentId: "agent-1",
  cwd: "/workspace",
  state: "active",
  title: null,
  forkedFromSessionId: null,
  clientMcpRevisionId: "mcp-revision-1",
  lastExecutionRevision: "execution-1",
  lastMessageSequence: 4,
  createdAt: new Date("2026-08-30T00:00:00Z"),
  updatedAt: new Date("2026-08-30T00:00:00Z"),
};

const snapshot: RunExecutionSnapshot = {
  admissionId: "admission-1",
  admissionDeadline: new Date("2026-08-30T00:10:00Z"),
  agentSpecRevision: "config-2",
  executionRevision: "execution-2",
  runtimeMcpSourceDigest: "a".repeat(64),
  agentExecutionSpecDigest: "b".repeat(64),
  credentialVersion: "credential-version-1",
  runtime: {
    revision: "runtime-2",
    executionId: "runtime-execution-2",
    mcpEndpoint: "http://runtime-2:8080/mcp",
  },
  executionSpec: {
    systemPrompt: "You are useful.",
    contextPolicyVersion: "context-v1",
    skillInstructions: [],
    model: {
      baseUrl: "https://api.example.test/v1",
      model: "example-model",
      contextWindow: 64_000,
      maxOutputTokens: 4_096,
      supportsImages: false,
    },
    maxModelRequests: 12,
    credentialRef: "credential-1",
  },
  clientMcpRevisionId: "mcp-revision-1",
};

describe("Session domain", () => {
  it("accepts only the logical Runtime workspace and no additional roots", () => {
    expect(() => requireWorkspace("/workspace", [])).not.toThrow();
    expect(() => requireWorkspace("/tmp", [])).toThrow(/workspace/u);
    expect(() => requireWorkspace("/workspace", ["/workspace/shared"])).toThrow(
      /additional directories/u,
    );
  });

  it("binds a durable Session to exactly one principal and Agent", () => {
    expect(() => authorizeSession(session, binding)).not.toThrow();

    expect(() => authorizeSession(session, { ...binding, principalId: "principal-2" })).toThrow(
      /principal/u,
    );
    expect(() => authorizeSession(session, { ...binding, agentId: "agent-2" })).toThrow(/Agent/u);
  });

  it("derives a bounded title from the first meaningful text block", () => {
    expect(
      defaultSessionTitle([
        { type: "image", data: "ignored" },
        { type: "text", text: "  explain\n\nthis   system  " },
      ]),
    ).toBe("explain this system");
    expect(defaultSessionTitle([{ type: "text", text: "x".repeat(100) }])).toBe(
      `${"x".repeat(77)}...`,
    );
    expect(defaultSessionTitle([{ type: "text", text: "   " }])).toBeUndefined();
  });

  it("adds an environment reset fact only after an executed revision changes", () => {
    expect(environmentChangeFact({ ...session, lastExecutionRevision: null }, snapshot)).toBeNull();
    expect(
      environmentChangeFact(
        { ...session, lastExecutionRevision: snapshot.executionRevision },
        snapshot,
      ),
    ).toBeNull();

    expect(environmentChangeFact(session, snapshot)).toMatchObject({
      visible: false,
      kind: "environment_change",
      previousExecutionRevision: "execution-1",
      currentExecutionRevision: "execution-2",
    });
  });
});
