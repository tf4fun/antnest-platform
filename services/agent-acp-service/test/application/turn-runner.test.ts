import { describe, expect, it, vi } from "vitest";

import { TurnRunner, type TurnRunnerDependencies } from "../../src/application/turn-runner.js";
import { RunEventPersistenceError } from "../../src/application/durable-run-events.js";
import { MAX_TOOL_RESULT_BYTES } from "../../src/domain/tool-result.js";
import { ModelError, type ModelPort } from "../../src/ports/model.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import type { RunEventPort } from "../../src/ports/run-events.js";
import type {
  ModelMessage,
  ModelToolDefinition,
  RunExecutionSnapshot,
} from "../../src/domain/types.js";

const snapshot: RunExecutionSnapshot = {
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
    maxModelRequests: 4,
  },
  clientMcpRevisionId: "client-mcp-1",
};

describe("TurnRunner", () => {
  it("dispatches Skill platform reads as tools rather than treating every Agent tool as a plan", async () => {
    const events = createEvents();
    const call = vi.fn<ToolCatalogPort["call"]>(() =>
      Promise.resolve({
        content: [{ type: "text", text: "skill-result" }],
        isError: false,
        toolEffectState: "none",
        runtimeCallStopped: true,
      }),
    );
    const complete = vi
      .fn<ModelPort["complete"]>()
      .mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        calls: [{ id: "find", name: "find_skill", arguments: { query: "procedure" } }],
        usage: {},
      })
      .mockResolvedValueOnce({
        kind: "message",
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: {},
      });
    const runner = new TurnRunner({
      model: { complete },
      tools: { call },
      events: events.port,
      catalog: [
        {
          source: "agent",
          sourceId: "skill_registry",
          name: "find_skill",
          modelName: "find_skill",
          description: "Find Skill",
          annotations: { readOnlyHint: true },
        },
      ],
    });
    expect(
      await runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot,
        context: [],
        signal: new AbortController().signal,
        authoritySignal: new AbortController().signal,
      }),
    ).toMatchObject({ terminalClass: "completed", toolEffectState: "none" });
    expect(call).toHaveBeenCalledOnce();
    expect(events.updatePlan).not.toHaveBeenCalled();
    expect(events.toolStarted).toHaveBeenCalledOnce();
    expect(events.toolFinished).toHaveBeenCalledOnce();
    expect(complete.mock.calls[1]?.[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: [{ type: "text", text: "skill-result" }],
        }),
      ]),
    );
  });
  it("keeps model reasoning when retrying a rejected tool call", async () => {
    const thought = [{ type: "text", text: "inspect before executing" }];
    const complete = vi
      .fn<ModelPort["complete"]>()
      .mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        thought,
        calls: [{ id: "bad-call", name: "missing", arguments: {} }],
        usage: {},
      })
      .mockResolvedValueOnce({
        kind: "message",
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: {},
      });
    const call = vi.fn();
    const runner = new TurnRunner({
      model: { complete },
      tools: { call },
      catalog: [],
      events: createEvents().port,
    });
    await expect(run(runner)).resolves.toMatchObject({ terminalClass: "completed" });
    expect(complete.mock.calls[1]?.[0].messages).toContainEqual(
      expect.objectContaining({ role: "assistant", thought }),
    );
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    [true, "result"],
    [false, "result"],
    [true, "error"],
    [false, "error"],
  ] as const)(
    "persists independent Runtime stopping evidence %s from a Tool %s",
    async (runtimeCallStopped, source) => {
      const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue({
        kind: "tool_calls",
        content: [],
        calls: [{ id: "call-1", name: "write", arguments: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const call = vi.fn<ToolCatalogPort["call"]>(() =>
        source === "error"
          ? Promise.reject(
              Object.assign(new Error("effect unknown"), {
                effectState: "unknown",
                runtimeCallStopped,
              }),
            )
          : Promise.resolve({
              content: [],
              isError: true,
              toolEffectState: "unknown",
              runtimeCallStopped,
            }),
      );
      const events = createEvents();
      const runner = new TurnRunner({
        model: { complete },
        tools: { call },
        events: events.port,
        catalog: [
          {
            source: "runtime",
            sourceId: "runtime",
            name: "write",
            modelName: "write",
            description: "Write",
          },
        ],
      });
      await expect(run(runner)).resolves.toMatchObject({
        terminalClass: "unresolved",
        toolEffectState: "unknown",
      });
      expect(events.toolFinished.mock.calls[0]?.[5]?.runtimeCallStopped).toBe(runtimeCallStopped);
      expect(call).toHaveBeenCalledOnce();
    },
  );

  it("records known failed-call cost once without executing tools", async () => {
    const error = new ModelError("model_invalid_response", "invalid", false);
    error.usage = { cost: { amount: 0.01, currency: "USD", source: "provider_reported" } };
    const events = createEvents();
    const call = vi.fn();
    const runner = new TurnRunner({
      model: { complete: vi.fn().mockRejectedValue(error) },
      tools: { call },
      catalog: [],
      events: events.port,
    });
    await expect(run(runner)).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "model_invalid_response",
    });
    expect(events.usage).toHaveBeenCalledExactlyOnceWith("run-1", error.usage);
    expect(call).not.toHaveBeenCalled();
  });

  it("saves returned cost before a final output flush failure", async () => {
    const events = createEvents();
    const failure = new RunEventPersistenceError("agent message", new Error("write failed"));
    events.agentMessage.mockResolvedValueOnce(undefined).mockRejectedValue(failure);
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      cost: { amount: 0.01, currency: "USD" as const, source: "provider_reported" as const },
    };
    const complete = vi.fn<ModelPort["complete"]>(async (request) => {
      await request.onDelta?.({ kind: "message", text: "first flush" });
      await request.onDelta?.({ kind: "message", text: "short pending flush" });
      return { kind: "message", content: [], stopReason: "end_turn", usage };
    });
    const runner = new TurnRunner({
      model: { complete },
      tools: { call: vi.fn() },
      catalog: [],
      events: events.port,
    });
    await expect(run(runner)).rejects.toBe(failure);
    expect(events.usage).toHaveBeenCalledExactlyOnceWith("run-1", usage);
  });
  it("preserves a typed model content failure without retaining the provider message", async () => {
    const complete = vi
      .fn<ModelPort["complete"]>()
      .mockRejectedValue(new ModelError("model_unsupported_content", "private-file-body", false));
    const call = vi.fn();
    const events = createEvents();
    const runner = new TurnRunner({
      model: { complete },
      tools: { call },
      catalog: [],
      events: events.port,
    });
    await expect(run(runner)).resolves.toEqual({
      terminalClass: "failed",
      executorState: "quiescent",
      toolEffectState: "none",
      errorClass: "model_unsupported_content",
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalled();
    expect(events.usage).not.toHaveBeenCalled();
  });

  it("propagates permission-judge accounting failures to recovery before any Tool effect", async () => {
    const events = createEvents();
    const failure = new RunEventPersistenceError("usage", new Error("write failed"));
    events.usage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    const snap = structuredClone(snapshot);
    snap.executionSpec.configuration = {
      modelProfileId: "p",
      authorizationRevision: 1,
      authorization: { mode: "smart_approve", toolRules: [] },
      digest: "a".repeat(64),
    };
    const model = vi
      .fn<ModelPort["complete"]>()
      .mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        calls: [{ id: "c", name: "bash", arguments: { command: "pwd" } }],
      })
      .mockResolvedValue({
        kind: "message",
        content: [{ type: "text", text: "{}" }],
        stopReason: "end_turn",
        usage: { inputTokens: 2, outputTokens: 2 },
      });
    const call = vi.fn();
    const request = vi.fn();
    const runner = new TurnRunner({
      model: { complete: model },
      tools: { call },
      permissions: { request },
      events: events.port,
      catalog: [
        {
          source: "runtime",
          sourceId: "runtime",
          name: "bash",
          modelName: "bash",
          description: "shell",
        },
      ],
    });
    const signal = new AbortController().signal;
    await expect(
      runner.run({
        runId: "r",
        sessionId: "s",
        snapshot: snap,
        context: [],
        signal,
        authoritySignal: signal,
      }),
    ).rejects.toBe(failure);
    expect(call).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(events.toolStarted).not.toHaveBeenCalled();
  });
  it.each(["cancel", "failure", "authority"] as const)(
    "drains a blocked progress write before %s handling without accepting late callbacks",
    async (ending) => {
      const events = createEvents();
      const blocked = Promise.withResolvers<void>();
      events.toolProgress.mockReturnValueOnce(blocked.promise);
      const tool = Promise.withResolvers<never>();
      const started = Promise.withResolvers<Parameters<ToolCatalogPort["call"]>[0]>();
      const cancelled = new AbortController();
      const authority = new AbortController();
      const runner = new TurnRunner({
        events: events.port,
        catalog: [
          {
            source: "runtime",
            sourceId: "runtime",
            name: "read",
            modelName: "read",
            description: "Read",
          },
        ],
        model: {
          complete: () =>
            Promise.resolve({
              kind: "tool_calls",
              content: [],
              calls: [{ id: "call", name: "read", arguments: {} }],
              usage: { inputTokens: 1, outputTokens: 1 },
            }),
        },
        tools: {
          call(input) {
            input.onProgress?.({ progress: 1, message: "first" });
            input.onProgress?.({ progress: 2, message: "tail" });
            started.resolve(input);
            return tool.promise;
          },
        },
      });
      const pending = runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot,
        context: [],
        signal: cancelled.signal,
        authoritySignal: authority.signal,
      });
      const observed = pending.catch(() => undefined);
      const input = await started.promise;
      try {
        const error = Object.assign(new Error("interrupted"), { effectState: "unknown" });
        if (ending === "cancel") cancelled.abort(error);
        if (ending === "authority") authority.abort(error);
        tool.reject(error);
        expect(events.toolFinished).not.toHaveBeenCalled();
        blocked.resolve();
        if (ending === "authority") {
          await expect(pending).rejects.toBe(error);
          expect(events.toolProgress).toHaveBeenCalledOnce();
          expect(events.toolFinished).not.toHaveBeenCalled();
          expect(input.signal.aborted).toBe(true);
        } else {
          expect(await pending).toMatchObject({ terminalClass: "unresolved" });
          expect(events.toolProgress).toHaveBeenCalledTimes(2);
          expect(events.toolFinished).toHaveBeenCalledOnce();
          expect(events.toolProgress.mock.lastCall?.[2]).toEqual([
            { type: "text", text: "first\ntail" },
          ]);
        }
        input.onProgress?.({ progress: 3, message: "late" });
        expect(events.toolProgress).toHaveBeenCalledTimes(ending === "authority" ? 1 : 2);
      } finally {
        blocked.resolve();
        tool.reject(new Error("test cleanup"));
        await observed;
      }
    },
  );

  it.each(["completed", "failed", "cancelled"] as const)(
    "flushes Tool progress before %s and keeps previews out of model context",
    async (ending) => {
      const events = createEvents();
      const controller = new AbortController();
      const complete = vi
        .fn<ModelPort["complete"]>()
        .mockResolvedValue({
          kind: "message",
          content: [{ type: "text", text: "done" }],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        })
        .mockResolvedValueOnce({
          kind: "tool_calls",
          content: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          calls: [{ id: "call", name: "read", arguments: {} }],
        });
      let late: Parameters<ToolCatalogPort["call"]>[0]["onProgress"];
      const runner = new TurnRunner({
        model: { complete },
        events: events.port,
        catalog: [
          {
            source: "runtime",
            sourceId: "runtime",
            name: "read",
            modelName: "read",
            description: "Read",
          },
        ],
        tools: {
          call(input) {
            late = input.onProgress;
            input.onProgress?.({ progress: 1, message: "preview first" });
            input.onProgress?.({ progress: 2, message: "preview tail" });
            if (ending === "cancelled") {
              controller.abort();
              return Promise.reject(
                Object.assign(new Error("disconnected"), { effectState: "unknown" }),
              );
            }
            return Promise.resolve({
              content: [{ type: "text", text: "final result" }],
              isError: ending === "failed",
              toolEffectState: "settled",
            });
          },
        },
      });
      await runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot,
        context: [],
        signal: controller.signal,
        authoritySignal: new AbortController().signal,
      });
      const callId = events.toolStarted.mock.calls[0]?.[1];
      expect(events.toolProgress.mock.calls.map((args) => args[1])).toEqual([callId, callId]);
      expect(events.toolProgress.mock.lastCall).toEqual([
        "run-1",
        callId,
        [{ type: "text", text: "preview first\npreview tail" }],
      ]);
      expect(events.toolStarted).toHaveBeenCalledBefore(events.toolProgress);
      expect(Math.max(...events.toolProgress.mock.invocationCallOrder)).toBeLessThan(
        events.toolFinished.mock.invocationCallOrder[0] ?? 0,
      );
      expect(events.toolFinished.mock.lastCall?.[2]).toBe(ending);
      expect(JSON.stringify(complete.mock.calls)).not.toContain("preview");
      late?.({ progress: 3, message: "late" });
      expect(events.toolProgress).toHaveBeenCalledTimes(2);
    },
  );

  it("aborts the active Tool on failed progress persistence and leaves recovery to close it", async () => {
    const events = createEvents();
    const failure = new RunEventPersistenceError(
      "Tool progress",
      new Error("database unavailable"),
    );
    events.toolProgress.mockRejectedValue(failure);
    const call = vi.fn<ToolCatalogPort["call"]>((input) => {
      const pending = new Promise<never>((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("Tool cancelled", { cause: input.signal.reason })),
          { once: true },
        );
      });
      input.onProgress?.({ progress: 1, message: "started" });
      return pending;
    });
    const runner = new TurnRunner({
      events: events.port,
      tools: { call },
      catalog: [
        {
          source: "runtime",
          sourceId: "runtime",
          name: "read",
          modelName: "read",
          description: "Read",
        },
      ],
      model: {
        complete: () =>
          Promise.resolve({
            kind: "tool_calls",
            content: [],
            calls: [{ id: "call", name: "read", arguments: {} }],
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
      },
    });
    await expect(run(runner)).rejects.toBe(failure);
    expect(call).toHaveBeenCalledOnce();
    expect(events.toolFinished).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains streamed output once, including cancellation=%s",
    async (cancel) => {
      const events = createEvents();
      const controller = new AbortController();
      const runner = new TurnRunner({
        model: {
          async complete(input) {
            await input.onDelta?.({ kind: "thought", text: "think" });
            await input.onDelta?.({ kind: "message", text: "hello" });
            await input.onDelta?.({ kind: "message", text: " world" });
            if (cancel) {
              controller.abort();
              throw new Error("aborted");
            }
            return {
              kind: "message",
              content: [{ type: "text", text: "hello world" }],
              thought: [{ type: "text", text: "think" }],
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 2 },
            };
          },
        },
        tools: { call: vi.fn() },
        catalog: [],
        events: events.port,
      });
      expect(
        await runner.run({
          runId: "run-1",
          sessionId: "session-1",
          snapshot,
          context: [],
          signal: controller.signal,
          authoritySignal: new AbortController().signal,
        }),
      ).toMatchObject({ terminalClass: cancel ? "cancelled" : "completed" });
      expect(
        events.agentMessage.mock.calls
          .flatMap((args) => args[1])
          .map((block) => block.text)
          .join(""),
      ).toBe("hello world");
      expect(events.agentThought.mock.calls.flatMap((args) => args[1])).toEqual([
        { type: "text", text: "think" },
      ]);
    },
  );

  it("keeps Tool identities unique across model requests and Runs, with paired model history", async () => {
    const events = createEvents();
    const contexts: ModelMessage[][] = [];
    const complete = vi.fn<ModelPort["complete"]>((input) => {
      contexts.push(structuredClone(input.messages));
      return Promise.resolve({
        kind: "tool_calls",
        content: [],
        calls: [{ id: "reused", name: "read", arguments: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    });
    const runner = new TurnRunner({
      model: { complete },
      catalog: [
        {
          source: "runtime",
          sourceId: "runtime",
          name: "read",
          modelName: "read",
          description: "Read",
        },
      ],
      tools: {
        call: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "result" }],
          isError: false,
          toolEffectState: "settled",
        }),
      },
      events: events.port,
    });
    for (const runId of ["run-1", "run-2"]) {
      await expect(
        runner.run({
          runId,
          sessionId: "session-1",
          snapshot,
          context: [],
          signal: new AbortController().signal,
          authoritySignal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ terminalClass: "completed" });
    }
    const ids = events.toolStarted.mock.calls.map((args) => args[1]);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(events.toolFinished.mock.calls.map((args) => args[1])).toEqual(ids);
    for (const [index, messages] of contexts.entries()) {
      const assistantIds = messages.flatMap((message) =>
        message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : [],
      );
      const resultIds = messages.flatMap((message) =>
        message.role === "tool" ? [message.toolCallId] : [],
      );
      expect(assistantIds).toEqual(resultIds);
      const first = index < 4 ? 0 : 4;
      expect(assistantIds).toEqual(ids.slice(first, first + (index % 4)));
    }
  });

  it.each(["usage", "agentThought", "agentMessage"] as const)(
    "honors cancellation during %s persistence before choosing the terminal result",
    async (operation) => {
      const controller = new AbortController();
      const events = createEvents();
      events[operation].mockImplementation(() => {
        controller.abort();
        return Promise.resolve();
      });
      const runner = new TurnRunner({
        model: {
          complete: vi.fn().mockResolvedValue({
            kind: "message",
            content: [{ type: "text", text: "answer" }],
            thought: [{ type: "text", text: "reasoning" }],
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "end_turn",
          }),
        },
        tools: { call: vi.fn() },
        catalog: [],
        events: events.port,
      });
      await expect(
        runner.run({
          runId: "run-1",
          sessionId: "session-1",
          snapshot,
          context: [],
          signal: controller.signal,
          authoritySignal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ terminalClass: "cancelled", toolEffectState: "none" });
    },
  );

  it.each([false, true])(
    "feeds a managed structured-only result to the model (isError=%s)",
    async (isError) => {
      const complete = vi
        .fn<ModelPort["complete"]>()
        .mockResolvedValueOnce({
          kind: "tool_calls",
          content: [],
          calls: [{ id: "call-structured", name: "mcp__documents__search", arguments: {} }],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          kind: "message",
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      const runner = new TurnRunner({
        model: { complete },
        events: createEvents().port,
        catalog: [
          {
            source: "runtime",
            sourceId: "runtime",
            name: "mcp__documents__search",
            modelName: "mcp__documents__search",
            description: "Search",
          },
        ],
        tools: {
          call: vi.fn().mockResolvedValue({
            content: [],
            structuredContent: { answer: "structured answer" },
            isError,
            toolEffectState: "settled",
          }),
        },
      });
      await expect(run(runner)).resolves.toMatchObject({ terminalClass: "completed" });
      expect(JSON.stringify(complete.mock.calls[1]?.[0].messages)).toContain("structured answer");
    },
  );

  it("stops before a subsequent model call when tool results exhaust the budget", async () => {
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValueOnce({
      kind: "tool_calls",
      content: [],
      calls: [{ id: "call-1", name: "read", arguments: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const runner = new TurnRunner({
      model: { complete },
      events: createEvents().port,
      catalog: [
        {
          source: "runtime",
          sourceId: "runtime",
          name: "read",
          modelName: "read",
          description: "Read",
        },
      ],
      tools: {
        call: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "x".repeat(8000) }],
          isError: false,
          toolEffectState: "settled",
        }),
      },
    });
    const small = structuredClone(snapshot);
    small.executionSpec.model.contextWindow = 2048;
    small.executionSpec.model.maxOutputTokens = 256;
    await expect(
      runner.run({
        runId: "run-budget",
        sessionId: "session",
        snapshot: small,
        context: [{ role: "user", content: [{ type: "text", text: "read" }] }],
        signal: new AbortController().signal,
        authoritySignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "context_budget_exhausted",
      toolEffectState: "settled",
    });
    expect(complete).toHaveBeenCalledOnce();
  });
  it("feeds one Tool result back to the model and completes without replay", async () => {
    const complete = vi.fn<ModelPort["complete"]>();
    complete
      .mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        calls: [{ id: "call-1", name: "read", arguments: { path: "README.md" } }],
        usage: { inputTokens: 10, outputTokens: 4 },
      })
      .mockResolvedValueOnce({
        kind: "message",
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 20, outputTokens: 2 },
        stopReason: "end_turn",
      });
    const model: ModelPort = {
      complete,
    };
    const call = vi.fn<ToolCatalogPort["call"]>(() =>
      Promise.resolve({
        content: [{ type: "text", text: "contents" }],
        isError: false,
        toolEffectState: "settled",
      }),
    );
    const tools: ToolCatalogPort = {
      list: vi.fn((): Promise<ModelToolDefinition[]> =>
        Promise.resolve([
          {
            source: "runtime",
            sourceId: "runtime",
            name: "read",
            modelName: "read",
            description: "Read a file",
            inputSchema: { type: "object" },
          },
        ]),
      ),
      call,
    };
    const events = createEvents();
    const runner = await createRunner({ model, tools, events: events.port });

    const result = await runner.run({
      runId: "run-1",
      sessionId: "session-1",
      snapshot,
      context: [{ role: "user", content: [{ type: "text", text: "read it" }] }],
      signal: new AbortController().signal,
      authoritySignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      terminalClass: "completed",
      executorState: "quiescent",
      toolEffectState: "settled",
    });
    expect(complete).toHaveBeenCalledTimes(2);
    const toolId = events.toolStarted.mock.calls[0]?.[1];
    expect(toolId).toEqual(expect.any(String));
    const secondRequest = complete.mock.calls[1]?.[0];
    expect(secondRequest?.messages).toEqual(
      expect.arrayContaining([
        {
          role: "assistant",
          content: [],
          toolCalls: [{ id: toolId, name: "read", arguments: { path: "README.md" } }],
        },
        {
          role: "tool",
          toolCallId: toolId,
          content: [{ type: "text", text: "contents" }],
        },
      ]),
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(events.toolStarted).toHaveBeenCalledBefore(events.toolFinished);
    expect(events.agentMessage).toHaveBeenCalledWith("run-1", [{ type: "text", text: "done" }]);
  });

  it("does not retry a Tool whose transport outcome is unknown", async () => {
    const complete = vi.fn<ModelPort["complete"]>(() =>
      Promise.resolve({
        kind: "tool_calls",
        content: [],
        calls: [
          { id: "call-1", name: "bash", arguments: { command: "do-effect" } },
          { id: "call-2", name: "write", arguments: { path: "later.txt" } },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    );
    const model: ModelPort = {
      complete,
    };
    const call = vi.fn<ToolCatalogPort["call"]>(() =>
      Promise.reject(Object.assign(new Error("timeout"), { effectState: "unknown" })),
    );
    const tools: ToolCatalogPort = {
      list: vi.fn((): Promise<ModelToolDefinition[]> =>
        Promise.resolve([
          {
            source: "runtime",
            sourceId: "runtime",
            name: "bash",
            modelName: "bash",
            description: "Run a command",
            inputSchema: { type: "object" },
          },
          {
            source: "runtime",
            sourceId: "runtime",
            name: "write",
            modelName: "write",
            description: "Write a file",
            inputSchema: { type: "object" },
          },
        ]),
      ),
      call,
    };
    const events = createEvents();
    const runner = await createRunner({ model, tools, events: events.port });

    await expect(
      runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot,
        context: [{ role: "user", content: [{ type: "text", text: "run" }] }],
        signal: new AbortController().signal,
        authoritySignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      terminalClass: "unresolved",
      executorState: "quiescent",
      toolEffectState: "unknown",
      unknownEffectSource: "runtime_mcp",
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(events.toolRejected).toHaveBeenCalledWith(
      "run-1",
      {
        id: events.agentMessage.mock.calls[0]?.[2]?.[1]?.id,
        name: "write",
        arguments: { path: "later.txt" },
      },
      "Tool was not executed because this Run ended before dispatch.",
    );
  });

  it("stops after an unconfirmed client MCP transport outcome and preserves its source", async () => {
    const complete = vi.fn<ModelPort["complete"]>(() =>
      Promise.resolve({
        kind: "tool_calls",
        content: [],
        calls: [{ id: "call-client", name: "client_read_abcd1234", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    );
    const call = vi.fn<ToolCatalogPort["call"]>(() =>
      Promise.reject(Object.assign(new Error("timeout"), { effectState: "unknown" })),
    );
    const runner = await createRunner({
      model: { complete },
      tools: {
        list: vi.fn(() =>
          Promise.resolve([
            {
              source: "client" as const,
              sourceId: "client-source",
              name: "read",
              modelName: "client_read_abcd1234",
              description: "Read through client MCP",
              inputSchema: { type: "object" },
            },
          ]),
        ),
        call,
      },
      events: createEvents().port,
    });

    await expect(
      runner.run({
        runId: "run-client",
        sessionId: "session-1",
        snapshot,
        context: [{ role: "user", content: [{ type: "text", text: "read" }] }],
        signal: new AbortController().signal,
        authoritySignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      terminalClass: "unresolved",
      toolEffectState: "unknown",
      unknownEffectSource: "client_mcp",
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("leaves recovery in charge when terminal Tool audit persistence fails", async () => {
    const complete = vi.fn<ModelPort["complete"]>(() =>
      Promise.resolve({
        kind: "tool_calls",
        content: [],
        calls: [{ id: "call-1", name: "bash", arguments: { command: "do-effect" } }],
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    );
    const call = vi.fn<ToolCatalogPort["call"]>(() =>
      Promise.reject(Object.assign(new Error("timeout"), { effectState: "unknown" })),
    );
    const events = createEvents();
    events.toolFinished.mockRejectedValueOnce(
      new RunEventPersistenceError("Tool finish", new Error("audit unavailable")),
    );
    const runner = await createRunner({
      model: { complete },
      tools: {
        list: vi.fn<ToolCatalogPort["list"]>(() =>
          Promise.resolve([
            {
              source: "runtime",
              sourceId: "runtime",
              name: "bash",
              modelName: "bash",
              description: "Run a command",
              inputSchema: { type: "object" },
            },
          ]),
        ),
        call,
      },
      events: events.port,
    });

    await expect(
      runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot,
        context: [{ role: "user", content: [{ type: "text", text: "run" }] }],
        signal: new AbortController().signal,
        authoritySignal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RunEventPersistenceError);
  });

  it("preserves a settled Tool effect when cancellation follows the Tool result", async () => {
    const cancellation = new AbortController();
    const complete = vi.fn<ModelPort["complete"]>(() =>
      Promise.resolve({
        kind: "tool_calls",
        content: [],
        calls: [
          { id: "call-1", name: "write", arguments: { path: "result.txt" } },
          { id: "call-2", name: "read", arguments: { path: "result.txt" } },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    );
    const events = createEvents();
    const call = vi.fn<ToolCatalogPort["call"]>(() => {
      cancellation.abort(new Error("cancel after Tool completion"));
      return Promise.resolve({ content: [], isError: false, toolEffectState: "settled" });
    });
    const runner = await createRunner({
      model: { complete },
      tools: {
        list: vi.fn<ToolCatalogPort["list"]>(() =>
          Promise.resolve([
            {
              source: "runtime",
              sourceId: "runtime",
              name: "write",
              modelName: "write",
              description: "Write a file",
            },
            {
              source: "runtime",
              sourceId: "runtime",
              name: "read",
              modelName: "read",
              description: "Read a file",
            },
          ]),
        ),
        call,
      },
      events: events.port,
    });

    await expect(
      runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot,
        context: [{ role: "user", content: [{ type: "text", text: "write" }] }],
        signal: cancellation.signal,
        authoritySignal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      terminalClass: "cancelled",
      executorState: "quiescent",
      toolEffectState: "settled",
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(events.toolRejected).toHaveBeenCalledWith(
      "run-1",
      {
        id: events.agentMessage.mock.calls[0]?.[2]?.[1]?.id,
        name: "read",
        arguments: { path: "result.txt" },
      },
      "Tool was not executed because this Run ended before dispatch.",
    );
  });

  it("propagates the model stop reason instead of flattening every completion", async () => {
    const runner = await createRunner({
      model: {
        complete: vi.fn<ModelPort["complete"]>(() =>
          Promise.resolve({
            kind: "message",
            content: [{ type: "text", text: "partial" }],
            usage: { inputTokens: 10, outputTokens: 4 },
            stopReason: "max_tokens",
          }),
        ),
      },
      tools: { list: vi.fn(() => Promise.resolve([])), call: vi.fn() },
      events: createEvents().port,
    });

    await expect(run(runner)).resolves.toMatchObject({
      terminalClass: "completed",
      stopReason: "max_tokens",
    });
  });

  it("rejects the entire Tool batch before effects and lets the model repair it", async () => {
    const complete = vi.fn<ModelPort["complete"]>();
    complete
      .mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        calls: [
          { id: "call-1", name: "write", arguments: {} },
          { id: "call-2", name: "missing", arguments: {} },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
      })
      .mockResolvedValueOnce({
        kind: "message",
        content: [{ type: "text", text: "I could not run those tools." }],
        usage: { inputTokens: 12, outputTokens: 5 },
        stopReason: "end_turn",
      });
    const call = vi.fn<ToolCatalogPort["call"]>();
    const events = createEvents();
    const runner = await createRunner({
      model: { complete },
      tools: {
        list: vi.fn(() =>
          Promise.resolve([
            {
              source: "runtime" as const,
              sourceId: "runtime",
              name: "write",
              modelName: "write",
              description: "Write",
              inputSchema: {
                type: "object",
                required: ["path"],
                properties: { path: { type: "string" } },
              },
            },
          ]),
        ),
        call,
      },
      events: events.port,
    });

    await expect(run(runner)).resolves.toMatchObject({
      terminalClass: "completed",
      stopReason: "end_turn",
    });
    expect(call).not.toHaveBeenCalled();
    expect(events.toolRejected).toHaveBeenCalledTimes(2);
    for (const [, rejected] of events.toolRejected.mock.calls) {
      expect(complete.mock.calls[1]?.[0].messages).toContainEqual(
        expect.objectContaining({ role: "tool", toolCallId: rejected.id }),
      );
    }
  });

  it("does not retain an assistant Tool batch when preflight cannot classify it", async () => {
    const events = createEvents();
    const call = vi.fn<ToolCatalogPort["call"]>();
    const runner = await createRunner({
      model: {
        complete: vi.fn(() =>
          Promise.resolve({
            kind: "tool_calls" as const,
            content: [{ type: "text", text: "I will inspect both files." }],
            calls: [
              { id: "duplicate", name: "read", arguments: { path: "a.txt" } },
              { id: "duplicate", name: "read", arguments: { path: "b.txt" } },
            ],
            usage: { inputTokens: 10, outputTokens: 4 },
          }),
        ),
      },
      tools: {
        list: vi.fn(() =>
          Promise.resolve([
            {
              source: "runtime" as const,
              sourceId: "runtime",
              name: "read",
              modelName: "read",
              description: "Read",
            },
          ]),
        ),
        call,
      },
      events: events.port,
    });

    await expect(run(runner)).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "duplicate_tool_call_id",
      toolEffectState: "none",
    });
    expect(events.agentMessage).not.toHaveBeenCalled();
    expect(events.toolStarted).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("bounds Tool results before model feedback and durable audit", async () => {
    const complete = vi.fn<ModelPort["complete"]>();
    complete
      .mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        calls: [{ id: "call-1", name: "read", arguments: { path: "large.txt" } }],
        usage: { inputTokens: 10, outputTokens: 4 },
      })
      .mockResolvedValueOnce({
        kind: "message",
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 12, outputTokens: 2 },
        stopReason: "end_turn",
      });
    const events = createEvents();
    const runner = await createRunner({
      model: { complete },
      tools: {
        list: vi.fn(() =>
          Promise.resolve([
            {
              source: "runtime" as const,
              sourceId: "runtime",
              name: "read",
              modelName: "read",
              description: "Read",
            },
          ]),
        ),
        call: vi.fn(() =>
          Promise.resolve({
            content: [{ type: "text", text: "工".repeat(MAX_TOOL_RESULT_BYTES) }],
            isError: false,
            toolEffectState: "settled" as const,
          }),
        ),
      },
      events: events.port,
    });

    await run(runner);

    const persisted = events.toolFinished.mock.calls[0]?.[3];
    expect(Buffer.byteLength(JSON.stringify(persisted), "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES,
    );
    expect(JSON.stringify(complete.mock.calls[1]?.[0].messages)).toContain("Tool result truncated");
  });
});

async function createRunner(
  dependencies: Omit<TurnRunnerDependencies, "catalog" | "tools"> & { tools: ToolCatalogPort },
): Promise<TurnRunner> {
  return new TurnRunner({
    ...dependencies,
    catalog: await dependencies.tools.list(snapshot, new AbortController().signal),
  });
}

function run(runner: TurnRunner) {
  return runner.run({
    runId: "run-1",
    sessionId: "session-1",
    snapshot,
    context: [{ role: "user", content: [{ type: "text", text: "run" }] }],
    signal: new AbortController().signal,
    authoritySignal: new AbortController().signal,
  });
}

function createEvents() {
  const updatePlan = vi.fn<RunEventPort["updatePlan"]>(() => Promise.resolve(true));
  const toolProgress = vi.fn<RunEventPort["toolProgress"]>(() => Promise.resolve());
  const toolStarted = vi.fn<RunEventPort["toolStarted"]>(() => Promise.resolve());
  const toolRejected = vi.fn<RunEventPort["toolRejected"]>(() => Promise.resolve());
  const toolFinished = vi.fn<RunEventPort["toolFinished"]>(() => Promise.resolve());
  const agentMessage = vi.fn<RunEventPort["agentMessage"]>(() => Promise.resolve());
  const agentThought = vi.fn<RunEventPort["agentThought"]>(() => Promise.resolve());
  const usage = vi.fn<RunEventPort["usage"]>(() => Promise.resolve());
  const port: RunEventPort = {
    updatePlan,
    toolProgress,
    toolStarted,
    toolRejected,
    toolFinished,
    agentMessage,
    agentThought,
    usage,
  };
  return {
    port,
    updatePlan,
    toolProgress,
    toolStarted,
    toolRejected,
    toolFinished,
    agentMessage,
    agentThought,
    usage,
  };
}
