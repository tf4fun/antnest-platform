import { emptyRuntimePreparation, runtimeInformation } from "../fixtures/runtime-information.js";
import { describe, expect, it, vi } from "vitest";

import { ContextBuilder } from "../../src/application/context-builder.js";
import { estimateMessages, inputBudget } from "../../src/application/context-budget.js";
import type { ContextRepository, ContextSource } from "../../src/ports/context-repository.js";
import type { RunExecutionSnapshot } from "../../src/domain/types.js";

describe("ContextBuilder", () => {
  it("loads the selected Skill as transient user context and preserves attachments and stored history", async () => {
    const information = runtimeInformation();
    const content = [
      { type: "text" as const, text: "/skill:system:documents Find the release notes" },
      { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
    ];
    const readSkill = vi.fn(() => Promise.resolve("# Documents\nSearch the release index."));
    const saveCheckpoint = vi.fn();
    const builder = new ContextBuilder({
      repository: {
        load: () =>
          Promise.resolve({
            checkpoint: null,
            messages: [{ sequence: 1, kind: "user_message", content }],
          }),
        saveCheckpoint,
      },
      runtimeInformation: { read: () => Promise.resolve(information) },
      tools: { list: () => Promise.resolve([]) },
      readSkill,
      id: () => "checkpoint-1",
      now: () => new Date(),
    });
    const result = await builder.build(
      "session-1",
      snapshot(),
      new AbortController().signal,
      "run-1",
    );
    expect(readSkill).toHaveBeenCalledWith(
      snapshot().runtime,
      information.skills[0]!.path,
      expect.any(AbortSignal),
    );
    expect(result.messages.at(-1)?.content[0]).toMatchObject({
      type: "text",
    });
    expect(JSON.stringify(result.messages.at(-1)?.content[0])).toContain(
      "Search the release index.",
    );
    expect(result.messages.at(-1)?.content[1]).toEqual(content[1]);
    expect(JSON.stringify(result.messages.at(-1))).toContain("Find the release notes");
    expect(content[0]?.text).toBe("/skill:system:documents Find the release notes");
    expect(saveCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects a stale Skill command before reading arbitrary paths", async () => {
    const readSkill = vi.fn();
    const builder = new ContextBuilder({
      ...emptyRuntimePreparation(),
      readSkill,
      repository: {
        load: () =>
          Promise.resolve({
            checkpoint: null,
            messages: [
              {
                sequence: 1,
                kind: "user_message",
                content: [{ type: "text", text: "/skill:personal:missing Do it" }],
              },
            ],
          }),
        saveCheckpoint: vi.fn(),
      },
      id: () => "checkpoint-1",
      now: () => new Date(),
    });
    await expect(
      builder.build("session-1", snapshot(), new AbortController().signal, "run-1"),
    ).rejects.toThrow("no longer available");
    expect(readSkill).not.toHaveBeenCalled();
  });

  it("does not reload historical Skill commands or save expanded bodies when compacting", async () => {
    const information = runtimeInformation();
    const readSkill = vi.fn(() => Promise.resolve("PRIVATE SKILL BODY"));
    const saveCheckpoint = vi.fn();
    const messages: ContextSource["messages"] = [
      {
        sequence: 1,
        kind: "user_message",
        content: [{ type: "text", text: "Original task" }],
      },
      {
        sequence: 2,
        kind: "user_message",
        content: [{ type: "text", text: `/skill:system:documents ${"old ".repeat(5_000)}` }],
      },
      { sequence: 3, kind: "agent_message", content: [{ type: "text", text: "done" }] },
      {
        sequence: 4,
        kind: "user_message",
        content: [{ type: "text", text: "/skill:system:documents Find current docs" }],
      },
    ];
    const builder = new ContextBuilder({
      repository: { load: () => Promise.resolve({ checkpoint: null, messages }), saveCheckpoint },
      runtimeInformation: { read: () => Promise.resolve(information) },
      tools: { list: () => Promise.resolve([]) },
      readSkill,
      id: () => "checkpoint-1",
      now: () => new Date(),
    });
    const constrained = snapshot();
    constrained.executionSpec.model.contextWindow = 8_192;
    constrained.executionSpec.model.maxOutputTokens = 128;
    const result = await builder.build(
      "session-1",
      constrained,
      new AbortController().signal,
      "run-1",
    );
    expect(readSkill).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.messages.at(-1))).toContain("PRIVATE SKILL BODY");
    expect(saveCheckpoint).toHaveBeenCalled();
    expect(JSON.stringify(saveCheckpoint.mock.calls)).not.toContain("PRIVATE SKILL BODY");
    messages[3] = {
      sequence: 4,
      kind: "user_message",
      content: [{ type: "text", text: "Another task" }],
    };
    await builder.build("session-1", constrained, new AbortController().signal, "run-1");
    expect(readSkill).toHaveBeenCalledTimes(1);
  });
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

    const { messages } = await builder.build(
      "session-1",
      snapshot(),
      new AbortController().signal,
      "run-1",
    );

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
    await expect(
      builder.build("session-1", legacy, new AbortController().signal, "run-1"),
    ).rejects.toThrow("Legacy Skill instructions are unsupported");
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
              content: [{ type: "text", text: "Original task" }],
            },
            {
              sequence: 3,
              kind: "agent_message",
              content: [{ type: "text", text: "x".repeat(24_000) }],
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
    constrained.executionSpec.model.contextWindow = 8_192;
    constrained.executionSpec.model.maxOutputTokens = 128;

    const { messages } = await builder.build(
      "session-1",
      constrained,
      new AbortController().signal,
      "original-run",
    );

    expect(JSON.stringify(messages.at(-1))).toContain("latest request");
    expect(saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "checkpoint-2",
        sessionId: "session-1",
        runId: "original-run",
        throughSequence: 3,
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

    const { messages } = await builder.build(
      "session-1",
      snapshot(),
      new AbortController().signal,
      "run-1",
    );

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
              content: [{ type: "text", text: "Original task" }],
            },
            {
              sequence: 2,
              kind: "agent_message",
              content: [{ type: "text", text: "x".repeat(24_000) }],
            },
            {
              sequence: 3,
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
    constrained.executionSpec.model.contextWindow = 8_192;
    constrained.executionSpec.model.maxOutputTokens = 128;

    await expect(
      builder.build("session-1", constrained, ownership.signal, "run-1"),
    ).rejects.toThrow("worker lock lost");
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
              content: [{ type: "text", text: "Original task" }],
            },
            {
              sequence: 2,
              kind: "agent_message",
              content: [{ type: "text", text: "x".repeat(24_000) }],
            },
            {
              sequence: 3,
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
    constrained.executionSpec.model.contextWindow = 8_192;
    constrained.executionSpec.model.maxOutputTokens = 128;

    await expect(
      builder.build("session-1", constrained, ownership.signal, "run-1"),
    ).rejects.toThrow("worker lock lost");
  });

  it("compacts oversized history through the supplied model call and records checkpoint metadata", async () => {
    type CompactionComplete = NonNullable<
      NonNullable<Parameters<ContextBuilder["build"]>[4]>["complete"]
    >;
    const complete = vi.fn<CompactionComplete>(() =>
      Promise.resolve({
        kind: "message" as const,
        content: [{ type: "text" as const, text: "任务摘要" }],
        usage: {},
        stopReason: "end_turn" as const,
      }),
    );
    const saveCheckpoint = vi.fn<ContextRepository["saveCheckpoint"]>();
    const pinnedEntry = {
      sequence: 1,
      kind: "user_message" as const,
      content: [{ type: "text", text: "Original task" }],
    };
    Reflect.set(pinnedEntry, "id", "msg-1");
    const source: ContextSource = {
      checkpoint: { throughSequence: 1, summary: "previous summary" },
      messages: [
        {
          sequence: 2,
          kind: "user_message" as const,
          content: [{ type: "text", text: "x".repeat(24_000) }],
        },
        {
          sequence: 3,
          kind: "agent_message" as const,
          content: [{ type: "text", text: "intermediate ".repeat(300) }],
        },
        {
          sequence: 4,
          kind: "user_message" as const,
          content: [{ type: "text", text: "Latest question" }],
        },
      ],
    };
    Reflect.set(source, "pinned", [pinnedEntry]);
    const builder = new ContextBuilder({
      ...emptyRuntimePreparation(),
      repository: { load: () => Promise.resolve(source), saveCheckpoint },
      id: () => "checkpoint-compaction",
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    const constrained = snapshot();
    constrained.executionSpec.model.contextWindow = 8_192;
    constrained.executionSpec.model.maxOutputTokens = 128;

    const { messages } = await builder.build(
      "session-1",
      constrained,
      new AbortController().signal,
      "run-1",
      { complete },
    );

    expect(complete).toHaveBeenCalled();
    const request = complete.mock.calls[0]![0];
    expect(request.purpose).toBe("compaction");
    expect(JSON.stringify(request.messages)).toContain("previous summary");
    expect(saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionPromptVersion: "context-summary-v1",
      }),
    );
    expect(saveCheckpoint.mock.calls[0]?.[0].pinnedMessageIds).toContain("msg-1");
    expect(JSON.stringify(messages)).toContain("Original task");
    expect(JSON.stringify(messages)).toContain("Latest question");
    expect(JSON.stringify(messages)).toContain("任务摘要");
  });

  it("keeps the pinned first task when runtime context consumes most of the byte budget", async () => {
    const information = runtimeInformation();
    information.instructions!.content = "中".repeat(12_000);
    information.skills = Array.from({ length: 40 }, (_, index) => ({
      source: "system" as const,
      name: `skill-${index}`,
      description: "中文技能说明".repeat(100),
      path: { root: "system_skills" as const, path: `skills/skill-${index}/SKILL.md` },
    }));
    const originalTask = "原始任务要求".repeat(80);
    const builder = new ContextBuilder({
      ...emptyRuntimePreparation(),
      runtimeInformation: { read: () => Promise.resolve(information) },
      repository: {
        load: () =>
          Promise.resolve({
            checkpoint: null,
            messages: [
              {
                sequence: 1,
                kind: "user_message",
                content: [{ type: "text", text: originalTask }],
              },
              {
                sequence: 2,
                kind: "user_message",
                content: [{ type: "text", text: "继续" }],
              },
            ],
          }),
        saveCheckpoint: vi.fn(),
      },
      id: () => "checkpoint-runtime",
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    const constrained = snapshot();
    constrained.executionSpec.model.contextWindow = 8_192;
    constrained.executionSpec.model.maxOutputTokens = 128;
    constrained.executionSpec.model.tokenizer = "none";

    const { messages, tools } = await builder.build(
      "session-1",
      constrained,
      new AbortController().signal,
      "run-1",
    );

    expect(estimateMessages(messages, constrained.executionSpec.model)).toBeLessThanOrEqual(
      inputBudget(constrained, tools),
    );
    expect(JSON.stringify(messages)).toContain(originalTask);
    expect(JSON.stringify(messages)).toContain("/workspace/AGENTS.md");
    expect(JSON.stringify(messages)).not.toContain("中".repeat(12_000));
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
      connectionId: "rci_11111111111111111111111111111111",
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
