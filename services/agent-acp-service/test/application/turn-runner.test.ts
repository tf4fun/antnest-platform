import { describe, expect, it, vi } from "vitest";

import { TurnRunner } from "../../src/application/turn-runner.js";
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
      adapter: "openai_compatible",
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
        runtimeEffectState: "settled",
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
      runtimeEffectState: "settled",
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
        calls: [{ id: "call-1", name: "bash", arguments: { command: "do-effect" } }],
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
        ]),
      ),
      call,
    };
    const runner = new TurnRunner({ model, tools, events: createEvents().port });

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
      runtimeEffectState: "unknown",
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("preserves an unknown Tool outcome when terminal audit persistence also fails", async () => {
    const complete = vi.fn<ModelPort["complete"]>(() =>
      Promise.resolve({
        kind: "tool_calls",
        calls: [{ id: "call-1", name: "bash", arguments: { command: "do-effect" } }],
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    );
    const call = vi.fn<ToolCatalogPort["call"]>(() =>
      Promise.reject(Object.assign(new Error("timeout"), { effectState: "unknown" })),
    );
    const events = createEvents();
    events.toolFinished.mockRejectedValueOnce(new Error("audit unavailable"));
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
    ).resolves.toMatchObject({
      terminalClass: "unresolved",
      executorState: "unknown",
      runtimeEffectState: "unknown",
    });
  });

  it("preserves a settled Runtime effect when cancellation follows the Tool result", async () => {
    const cancellation = new AbortController();
    const complete = vi.fn<ModelPort["complete"]>(() =>
      Promise.resolve({
        kind: "tool_calls",
        calls: [{ id: "call-1", name: "write", arguments: { path: "result.txt" } }],
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    );
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
          ]),
        ),
        call: vi.fn<ToolCatalogPort["call"]>(() => {
          cancellation.abort(new Error("cancel after Tool completion"));
          return Promise.resolve({ content: [], isError: false, runtimeEffectState: "settled" });
        }),
      },
      events: createEvents().port,
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
      runtimeEffectState: "settled",
    });
  });
});

function createEvents() {
  const toolStarted = vi.fn<RunEventPort["toolStarted"]>(() => Promise.resolve());
  const toolFinished = vi.fn<RunEventPort["toolFinished"]>(() => Promise.resolve());
  const agentMessage = vi.fn<RunEventPort["agentMessage"]>(() => Promise.resolve());
  const port: RunEventPort = {
    toolStarted,
    toolFinished,
    agentMessage,
    usage: vi.fn(() => Promise.resolve()),
  };
  return { port, toolStarted, toolFinished, agentMessage };
}
