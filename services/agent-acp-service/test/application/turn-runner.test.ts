import { describe, expect, it, vi } from "vitest";

import { TurnRunner, type TurnRunnerDependencies } from "../../src/application/turn-runner.js";
import { RunEventPersistenceError } from "../../src/application/durable-run-events.js";
import { MAX_TOOL_RESULT_BYTES } from "../../src/domain/tool-result.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import type { RunEventPort } from "../../src/ports/run-events.js";
import type {
  ModelMessage,
  ModelToolDefinition,
  RunExecutionSnapshot,
} from "../../src/domain/types.js";

const snapshot: RunExecutionSnapshot = {
  admissionId: "admission-1",
  admissionDeadline: new Date("2026-08-30T00:10:00Z"),
  agentSpecRevision: "config-1",
  executionRevision: "execution-1",
  runtimeMcpSourceDigest: "a".repeat(64),
  agentExecutionSpecDigest: "b".repeat(64),
  credentialVersion: "credential-version-1",
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
    credentialRef: "credential-1",
  },
  clientMcpRevisionId: "client-mcp-1",
};

describe("TurnRunner", () => {
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
          credential: "synthetic",
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
          credential: "synthetic",
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
        credential: "secret",
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
      credential: "secret",
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
        credential: "secret",
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
        credential: "secret",
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
        credential: "secret",
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
        credential: "secret",
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
    credential: "secret",
    context: [{ role: "user", content: [{ type: "text", text: "run" }] }],
    signal: new AbortController().signal,
    authoritySignal: new AbortController().signal,
  });
}

function createEvents() {
  const toolStarted = vi.fn<RunEventPort["toolStarted"]>(() => Promise.resolve());
  const toolRejected = vi.fn<RunEventPort["toolRejected"]>(() => Promise.resolve());
  const toolFinished = vi.fn<RunEventPort["toolFinished"]>(() => Promise.resolve());
  const agentMessage = vi.fn<RunEventPort["agentMessage"]>(() => Promise.resolve());
  const agentThought = vi.fn<RunEventPort["agentThought"]>(() => Promise.resolve());
  const usage = vi.fn<RunEventPort["usage"]>(() => Promise.resolve());
  const port: RunEventPort = {
    toolStarted,
    toolRejected,
    toolFinished,
    agentMessage,
    agentThought,
    usage,
  };
  return { port, toolStarted, toolRejected, toolFinished, agentMessage, agentThought, usage };
}
