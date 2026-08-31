import { describe, expect, it, vi } from "vitest";

import { TurnRunner } from "../../src/application/turn-runner.js";
import { RunEventPersistenceError } from "../../src/application/durable-run-events.js";
import { MAX_TOOL_RESULT_BYTES } from "../../src/domain/tool-result.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import type { RunEventPort } from "../../src/ports/run-events.js";
import type { ModelToolDefinition, RunExecutionSnapshot } from "../../src/domain/types.js";

const snapshot: RunExecutionSnapshot = {
  admissionId: "admission-1",
  admissionDeadline: new Date("2026-08-30T00:10:00Z"),
  agentConfigRevision: "config-1",
  executionRevision: "execution-1",
  runtimeMcpSourceDigest: "a".repeat(64),
  agentExecutionSpecDigest: "b".repeat(64),
  credentialVersion: "credential-version-1",
  runtime: {
    generation: 1,
    instanceId: "runtime-1",
    executionId: "runtime-execution-1",
    mcpEndpoint: "http://runtime-1:8080/mcp",
  },
  executionSpec: {
    systemPrompt: "You are useful.",
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
    const runner = new TurnRunner({ model, tools, events: events.port });

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
    const secondRequest = complete.mock.calls[1]?.[0];
    expect(secondRequest?.messages).toEqual(
      expect.arrayContaining([
        {
          role: "assistant",
          content: [],
          toolCalls: [{ id: "call-1", name: "read", arguments: { path: "README.md" } }],
        },
        {
          role: "tool",
          toolCallId: "call-1",
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
    const runner = new TurnRunner({ model, tools, events: events.port });

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
      executorState: "unknown",
      toolEffectState: "unknown",
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(events.toolRejected).toHaveBeenCalledWith(
      "run-1",
      { id: "call-2", name: "write", arguments: { path: "later.txt" } },
      "Tool was not executed because this Run ended before dispatch.",
    );
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
    const runner = new TurnRunner({
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
    const runner = new TurnRunner({
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
      { id: "call-2", name: "read", arguments: { path: "result.txt" } },
      "Tool was not executed because this Run ended before dispatch.",
    );
  });

  it("propagates the model stop reason instead of flattening every completion", async () => {
    const runner = new TurnRunner({
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
    const runner = new TurnRunner({
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
    expect(complete.mock.calls[1]?.[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", toolCallId: "call-1" }),
        expect.objectContaining({ role: "tool", toolCallId: "call-2" }),
      ]),
    );
  });

  it("does not retain an assistant Tool batch when preflight cannot classify it", async () => {
    const events = createEvents();
    const call = vi.fn<ToolCatalogPort["call"]>();
    const runner = new TurnRunner({
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
    const runner = new TurnRunner({
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
  const port: RunEventPort = {
    toolStarted,
    toolRejected,
    toolFinished,
    agentMessage,
    agentThought,
    usage: vi.fn(() => Promise.resolve()),
  };
  return { port, toolStarted, toolRejected, toolFinished, agentMessage, agentThought };
}
