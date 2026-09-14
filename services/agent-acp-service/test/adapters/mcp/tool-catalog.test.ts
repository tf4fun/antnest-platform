import { describe, expect, it, vi } from "vitest";

import {
  McpToolCatalog,
  McpToolCallError,
  type McpConnection,
  type McpDialer,
} from "../../../src/adapters/mcp/tool-catalog.js";
import type { ClientMcpRevisionPort } from "../../../src/ports/tools.js";
import type { RunExecutionSnapshot } from "../../../src/domain/types.js";

describe("McpToolCatalog", () => {
  it.each(["execution+agent@example.org", "execution/department:1"])(
    "preserves opaque Runtime identity %s before discovery and dispatch",
    async (executionId) => {
      const runtime = fakeDialer([{ name: "read", description: "Read" }]);
      const catalog = new McpToolCatalog({ runtimeDialer: runtime.dialer, revisions: revisions() });
      const input = snapshot();
      input.runtime.executionId = executionId;
      const signal = new AbortController().signal;
      await catalog.list(input, signal);
      await catalog.call({
        runId: "run-1",
        snapshot: input,
        tool: runtimeTool("read"),
        arguments: {},
        signal,
      });
      expect(runtime.connect).toHaveBeenCalledTimes(2);
      for (const [connection] of runtime.connect.mock.calls) {
        expect(connection).toMatchObject({
          headers: { "x-antnest-expected-execution-id": executionId },
        });
      }
    },
  );

  it.each([" padded", "padded ", "line\nbreak", "execution\u0100"])(
    "rejects lossy or unrepresentable Runtime identity %j before any request",
    async (executionId) => {
      const runtime = fakeDialer([{ name: "write", description: "Write" }]);
      const catalog = new McpToolCatalog({ runtimeDialer: runtime.dialer, revisions: revisions() });
      const input = snapshot();
      input.runtime.executionId = executionId;
      const signal = new AbortController().signal;
      await expect(catalog.read(input, signal)).rejects.toThrow();
      await expect(catalog.list(input, signal)).rejects.toThrow();
      await expect(
        catalog.call({
          runId: "run-1",
          snapshot: input,
          tool: runtimeTool("write"),
          arguments: {},
          signal,
        }),
      ).rejects.toMatchObject({
        effectState: "none",
        runtimeCallStopped: true,
      });
      expect(runtime.connect).not.toHaveBeenCalled();
      expect(runtime.callTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["write", "outcome_unknown", "unknown", true],
    ["edit", "outcome_unknown", "unknown", true],
    ["bash", "outcome_unknown", "unknown", false],
    ["read", "runtime_failed", "none", false],
    ["bash", "child_process_containment_unproven", "none", false],
    ["read", "child_process_containment_unproven", "unknown", false],
    ["write", "invalid_path", "none", true],
    ["read", "read_failed", "none", true],
    ["edit", "old_string_not_found", "none", true],
    ["bash", "runtime_busy", "none", true],
    ["bash", "spawn_failed", "none", true],
    ["bash", "timeout", "none", true],
    ["bash", "encode_result_failed", "settled", true],
    ["read", "future_unclassified_error", "none", false],
    ["mcp__documents__search", "outcome_unknown", "unknown", false],
    ["mcp__documents__search", "child_process_containment_unproven", "none", false],
    ["mcp__documents__search", "runtime_failed", "none", false],
  ] as const)(
    "separates stopping evidence for %s / %s from effects",
    async (name, code, effect, stopped) => {
      const runtime = fakeDialer([{ name, description: name }], {
        content: [{ type: "text", text: "This text does not determine stopping evidence" }],
        isError: true,
        structuredContent: {
          error_code: code,
          effect_state: effect,
          effect_source: effect === "unknown" ? "runtime_mcp" : null,
        },
      });
      const catalog = new McpToolCatalog({ runtimeDialer: runtime.dialer, revisions: revisions() });
      const result = await catalog.call({
        runId: "run-1",
        snapshot: snapshot(),
        tool: runtimeTool(name),
        arguments: {},
        signal: new AbortController().signal,
      });
      expect(result.runtimeCallStopped).toBe(stopped);
      expect(result.toolEffectState).toBe(effect);
    },
  );

  it.each(["read", "write", "edit", "bash"])(
    "recognizes %s completion without requiring successful external side effects",
    async (name) => {
      const runtime = fakeDialer([{ name, description: name }], {
        content: [],
        isError: false,
        structuredContent: { exit_code: 1, effect_state: "settled", effect_source: null },
      });
      const catalog = new McpToolCatalog({ runtimeDialer: runtime.dialer, revisions: revisions() });
      const result = await catalog.call({
        runId: "run-1",
        snapshot: snapshot(),
        tool: runtimeTool(name),
        arguments: {},
        signal: new AbortController().signal,
      });
      expect(result.runtimeCallStopped).toBe(true);
    },
  );

  it.each([
    undefined,
    { effect_state: "unknown", effect_source: "runtime_mcp" },
    { effect_state: "settled", effect_source: "client_mcp" },
    { effect_state: "none", effect_source: null },
  ])(
    "does not invent stopping evidence from incomplete builtin success: %j",
    async (structuredContent) => {
      const runtime = fakeDialer([{ name: "write", description: "Write" }], {
        content: [],
        isError: false,
        ...(structuredContent === undefined ? {} : { structuredContent }),
      });
      const catalog = new McpToolCatalog({ runtimeDialer: runtime.dialer, revisions: revisions() });
      const result = await catalog.call({
        runId: "run-1",
        snapshot: snapshot(),
        tool: runtimeTool("write"),
        arguments: {},
        signal: new AbortController().signal,
      });
      expect(result.runtimeCallStopped).toBe(false);
    },
  );

  it("lists only platform Runtime Tools", async () => {
    const runtime = fakeDialer([
      {
        name: "read",
        title: "Read document",
        description: "Read",
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    ]);
    const catalog = new McpToolCatalog({
      runtimeDialer: runtime.dialer,
      revisions: revisions(),
    });

    const tools = await catalog.list(snapshot(), new AbortController().signal);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      source: "runtime",
      modelName: "read",
      title: "Read document",
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(runtime.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: new URL("http://runtime-1:8080/mcp"),
        headers: { "x-antnest-expected-execution-id": "runtime-execution-1" },
      }),
    );
  });

  it("rejects a client Tool without connecting or dispatching", async () => {
    const runtime = fakeDialer([]);
    const catalog = new McpToolCatalog({ runtimeDialer: runtime.dialer, revisions: revisions() });
    await expect(
      catalog.call({
        runId: "run-1",
        snapshot: snapshot(),
        tool: { ...runtimeTool("search"), source: "client", sourceId: "old-source" },
        arguments: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ effectState: "none" });
    expect(runtime.connect).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("keeps a confirmed Tool result settled when connection cleanup fails", async () => {
    const runtime = fakeDialer([{ name: "read", description: "Read" }], {
      content: [{ type: "text", text: "confirmed" }],
      isError: false,
    });
    const closeFailure = new Error("close failed");
    const reportConnectionCloseFailure = vi.fn();
    const catalog = new McpToolCatalog({
      runtimeDialer: runtime.dialer,
      revisions: revisions(),
      reportConnectionCloseFailure,
    });
    const [tool] = await catalog.list(snapshot(), new AbortController().signal);
    if (tool === undefined) {
      throw new Error("expected Runtime Tool");
    }
    runtime.close.mockRejectedValueOnce(closeFailure);

    await expect(
      catalog.call({
        runId: "run-1",
        snapshot: snapshot(),
        tool,
        arguments: { path: "README.md" },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ toolEffectState: "settled" });
    expect(reportConnectionCloseFailure).toHaveBeenCalledWith("runtime", "runtime", closeFailure);
  });

  it("does not replay a Runtime Tool when the outcome is unknown", async () => {
    const runtime = fakeDialer([{ name: "write", description: "Write" }]);
    runtime.callTool.mockRejectedValueOnce(new TypeError("connection reset"));
    const catalog = new McpToolCatalog({
      runtimeDialer: runtime.dialer,
      revisions: revisions(),
    });
    const [tool] = await catalog.list(snapshot(), new AbortController().signal);
    if (tool === undefined) {
      throw new Error("expected Runtime Tool");
    }

    const error = await catalog
      .call({
        runId: "run-1",
        snapshot: snapshot(),
        tool,
        arguments: { path: "notes.txt" },
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpToolCallError);
    expect(error).toMatchObject({ effectState: "unknown", runtimeCallStopped: false });
    expect(runtime.callTool).toHaveBeenCalledTimes(1);
  });

  it("classifies Runtime connection failure before callTool as no effect", async () => {
    const runtime = fakeDialer([{ name: "write", description: "Write" }]);
    runtime.connect.mockRejectedValueOnce(new TypeError("connection refused"));
    const catalog = new McpToolCatalog({
      runtimeDialer: runtime.dialer,
      revisions: revisions(),
    });
    const tool = runtimeTool("write");

    const error = await catalog
      .call({
        runId: "run-1",
        snapshot: snapshot(),
        tool,
        arguments: { path: "notes.txt" },
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpToolCallError);
    expect(error).toMatchObject({ effectState: "none", runtimeCallStopped: true });
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("preserves a declared Runtime error with no side effect", async () => {
    const runtime = fakeDialer([{ name: "write", description: "Write" }], {
      content: [{ type: "text", text: "invalid path" }],
      isError: true,
      structuredContent: {
        error_code: "invalid_path",
        message: "invalid path",
        effect_state: "none",
        effect_source: null,
      },
    });
    const catalog = new McpToolCatalog({
      runtimeDialer: runtime.dialer,
      revisions: revisions(),
    });

    await expect(
      catalog.call({
        runId: "run-1",
        snapshot: snapshot(),
        tool: runtimeTool("write"),
        arguments: { path: "../outside" },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ isError: true, toolEffectState: "none" });
  });

  it("returns an ordinary managed MCP error to the model as a completed response", async () => {
    const runtime = fakeDialer([{ name: "mcp__documents__search", description: "Search" }], {
      content: [{ type: "text", text: "write failed" }],
      isError: true,
      structuredContent: { error_code: "write_failed", message: "write failed" },
    });
    const catalog = new McpToolCatalog({
      runtimeDialer: runtime.dialer,
      revisions: revisions(),
    });

    await expect(
      catalog.call({
        runId: "run-1",
        snapshot: snapshot(),
        tool: runtimeTool("mcp__documents__search"),
        arguments: { path: "notes.txt" },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      isError: true,
      toolEffectState: "settled",
      runtimeCallStopped: true,
      structuredContent: { error_code: "write_failed" },
    });
  });

  it("rejects persisted client sources before tool discovery", async () => {
    const runtime = fakeDialer([{ name: "read", description: "Read" }]);
    const catalog = new McpToolCatalog({
      runtimeDialer: runtime.dialer,
      revisions: {
        getClientMcpRevision: vi.fn(() =>
          Promise.resolve([
            {
              sourceId: "old",
              name: "old",
              url: "https://private.example/mcp",
              headers: [],
            },
          ]),
        ),
      },
    });
    await expect(catalog.list(snapshot(), new AbortController().signal)).rejects.toMatchObject({
      code: "client_mcp_not_allowed",
    });
    expect(runtime.connect).not.toHaveBeenCalled();
  });
});

function fakeDialer(
  tools: Array<{
    name: string;
    description: string;
    title?: string;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }>,
  result: {
    content: Array<{ type: string; [key: string]: unknown }>;
    isError: boolean;
    structuredContent?: unknown;
  } = { content: [], isError: false },
): {
  dialer: McpDialer;
  connect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const callTool = vi.fn(() => Promise.resolve(result));
  const close = vi.fn(() => Promise.resolve());
  const connection: McpConnection = {
    readResource: vi.fn(),
    listTools: vi.fn(() => Promise.resolve(tools)),
    callTool,
    close,
  };
  const connect = vi.fn(() => Promise.resolve(connection));
  return { dialer: { connect }, connect, callTool, close };
}

function runtimeTool(name: string) {
  return {
    source: "runtime" as const,
    sourceId: "runtime",
    name,
    modelName: name,
    description: name,
    inputSchema: { type: "object" },
  };
}

function revisions(): ClientMcpRevisionPort {
  return {
    getClientMcpRevision: vi.fn(() => Promise.resolve([])),
  };
}

function snapshot(): RunExecutionSnapshot {
  return {
    organizationId: "organization-1",
    providerConnectionId: "provider-1",
    modelProfileId: "model-1",
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
