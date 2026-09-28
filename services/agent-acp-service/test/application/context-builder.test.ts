import { emptyRuntimePreparation } from "../fixtures/runtime-information.js";
import { describe, expect, it, vi } from "vitest";

import { ContextBuilder } from "../../src/application/context-builder.js";
import type { ContextRepository, ContextSource } from "../../src/ports/context-repository.js";
import type { RunExecutionSnapshot } from "../../src/domain/types.js";

describe("ContextBuilder", () => {
  it("builds system, environment, and conversation context in order", async () => {
    const saveCheckpoint = vi.fn<ContextRepository["saveCheckpoint"]>();
    const repository: ContextRepository = {
      load: vi.fn((): Promise<ContextSource> =>
        Promise.resolve({
          checkpoint: null,
          messages: [
            { sequence: 1, kind: "user_message", content: [{ type: "text", text: "hello" }] },
            {
              sequence: 2,
              kind: "environment_change",
              content: [{ type: "text", text: "Runtime changed" }],
            },
            { sequence: 3, kind: "agent_message", content: [{ type: "text", text: "ready" }] },
          ],
        }),
      ),
      saveCheckpoint,
    };
    const builder = new ContextBuilder({
      ...emptyRuntimePreparation(),
      repository,
      id: () => "checkpoint-1",
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    const { messages } = await builder.build("session-1", snapshot(), new AbortController().signal);

    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "system",
      "assistant",
    ]);
    const systemText = messages[0]?.content[0];
    expect(systemText?.type).toBe("text");
    expect(systemText?.type === "text" ? systemText.text : "").toBe("system");
    expect(saveCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects a persisted Run snapshot with legacy Skill bodies before Runtime access", async () => {
    const runtime = emptyRuntimePreparation();
    const read = vi.spyOn(runtime.runtimeInformation, "read");
    const builder = new ContextBuilder({
      ...runtime,
      repository: {
        load: vi.fn(() => Promise.resolve({ checkpoint: null, messages: [] })),
        saveCheckpoint: vi.fn(),
      },
      id: () => "checkpoint-legacy",
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    const legacy = snapshot();
    legacy.executionSpec.skillInstructions = [
      { skillKey: "example", version: "1", instructions: "hidden body" },
    ];
    await expect(builder.build("session-1", legacy, new AbortController().signal)).rejects.toThrow(
      "Legacy Skill instructions are unsupported",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("checkpoints old history while preserving the newest user request", async () => {
    const saveCheckpoint = vi.fn<ContextRepository["saveCheckpoint"]>();
    const repository: ContextRepository = {
      load: vi.fn((): Promise<ContextSource> =>
        Promise.resolve({
          checkpoint: { throughSequence: 1, summary: "older summary" },
          messages: [
            {
              sequence: 2,
              kind: "user_message",
              content: [{ type: "text", text: "x".repeat(4_000) }],
            },
            {
              sequence: 3,
              kind: "agent_message",
              content: [{ type: "text", text: "intermediate" }],
            },
            {
              sequence: 4,
              kind: "user_message",
              content: [{ type: "text", text: "latest request" }],
            },
          ],
        }),
      ),
      saveCheckpoint,
    };
    const builder = new ContextBuilder({
      ...emptyRuntimePreparation(),
      repository,
      id: () => "checkpoint-2",
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    const constrained = snapshot();
    constrained.executionSpec.model.contextWindow = 1_536;
    constrained.executionSpec.model.maxOutputTokens = 128;

    const { messages } = await builder.build(
      "session-1",
      constrained,
      new AbortController().signal,
    );

    expect(JSON.stringify(messages.at(-1))).toContain("latest request");
    expect(saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "checkpoint-2",
        sessionId: "session-1",
        throughSequence: 2,
      }),
    );
  });

  it("restores one Tool exchange as an atomic assistant-call/result pair", async () => {
    const repository: ContextRepository = {
      load: vi.fn(() =>
        Promise.resolve({
          checkpoint: null,
          messages: [
            {
              sequence: 1,
              kind: "user_message" as const,
              content: [{ type: "text", text: "read" }],
            },
            {
              sequence: 2,
              endSequence: 3,
              kind: "tool_exchange" as const,
              assistant: {
                content: [{ type: "text", text: "I will read the file." }],
                thought: [{ type: "text", text: "Need evidence" }],
                toolCalls: [{ id: "call-1", name: "read", arguments: { path: "README.md" } }],
              },
              results: [
                {
                  toolCallId: "call-1",
                  content: [{ type: "text", text: "contents" }],
                },
              ],
            },
            {
              sequence: 4,
              kind: "agent_message" as const,
              content: [{ type: "text", text: "done" }],
            },
          ],
        }),
      ),
      saveCheckpoint: vi.fn(),
    };
    const builder = new ContextBuilder({
      ...emptyRuntimePreparation(),
      repository,
      id: () => "checkpoint-1",
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    const { messages } = await builder.build("session-1", snapshot(), new AbortController().signal);

    expect(messages.slice(1)).toEqual([
      { role: "user", content: [{ type: "text", text: "read" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will read the file." }],
        thought: [{ type: "text", text: "Need evidence" }],
        toolCalls: [{ id: "call-1", name: "read", arguments: { path: "README.md" } }],
      },
      { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "contents" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  it("does not save a checkpoint after worker ownership is lost during context load", async () => {
    const ownership = new AbortController();
    const saveCheckpoint = vi.fn<ContextRepository["saveCheckpoint"]>();
    const repository: ContextRepository = {
      load: vi.fn((): Promise<ContextSource> => {
        ownership.abort(new Error("worker lock lost"));
        return Promise.resolve({
          checkpoint: null,
          messages: [
            {
              sequence: 1,
              kind: "user_message",
              content: [{ type: "text", text: "x".repeat(4_000) }],
            },
            {
              sequence: 2,
              kind: "user_message",
              content: [{ type: "text", text: "latest request" }],
            },
          ],
        });
      }),
      saveCheckpoint,
    };
    const builder = new ContextBuilder({
      ...emptyRuntimePreparation(),
      repository,
      id: () => "checkpoint-lost",
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    const constrained = snapshot();
    constrained.executionSpec.model.contextWindow = 1_024;
    constrained.executionSpec.model.maxOutputTokens = 128;

    await expect(builder.build("session-1", constrained, ownership.signal)).rejects.toThrow(
      "worker lock lost",
    );
    expect(saveCheckpoint).not.toHaveBeenCalled();
  });

  it("surfaces ownership loss instead of a concurrent checkpoint error", async () => {
    const ownership = new AbortController();
    const repository: ContextRepository = {
      load: vi.fn((): Promise<ContextSource> =>
        Promise.resolve({
          checkpoint: null,
          messages: [
            {
              sequence: 1,
              kind: "user_message",
              content: [{ type: "text", text: "x".repeat(4_000) }],
            },
            {
              sequence: 2,
              kind: "user_message",
              content: [{ type: "text", text: "latest request" }],
            },
          ],
        }),
      ),
      saveCheckpoint: vi.fn(() => {
        ownership.abort(new Error("worker lock lost"));
        return Promise.reject(new Error("database write failed"));
      }),
    };
    const builder = new ContextBuilder({
      ...emptyRuntimePreparation(),
      repository,
      id: () => "checkpoint-lost",
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    const constrained = snapshot();
    constrained.executionSpec.model.contextWindow = 1_536;
    constrained.executionSpec.model.maxOutputTokens = 128;

    await expect(builder.build("session-1", constrained, ownership.signal)).rejects.toThrow(
      "worker lock lost",
    );
  });
});

function snapshot(): RunExecutionSnapshot {
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
