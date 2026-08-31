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
  it("merges Runtime and client Tools without allowing client shadowing", async () => {
    const runtime = fakeDialer([{ name: "read", description: "Read" }]);
    const client = fakeDialer([{ name: "read", description: "Other read" }]);
    const catalog = new McpToolCatalog({
      runtimeDialer: runtime.dialer,
      clientDialer: client.dialer,
      revisions: revisions(),
    });

    const tools = await catalog.list(snapshot(), new AbortController().signal);

    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ source: "runtime", modelName: "read" });
    expect(tools[1]).toMatchObject({ source: "client", name: "read" });
    expect(tools[1]?.modelName).not.toBe("read");
    expect(runtime.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: new URL("http://runtime-1:8080/mcp"),
        headers: { "x-antnest-expected-execution-id": "runtime-execution-1" },
      }),
    );
  });

  it("routes a qualified client Tool back to its original source and closes the connection", async () => {
    const runtime = fakeDialer([]);
    const client = fakeDialer([{ name: "search", description: "Search" }], {
      content: [{ type: "text", text: "found" }],
      isError: false,
    });
    const catalog = new McpToolCatalog({
      runtimeDialer: runtime.dialer,
      clientDialer: client.dialer,
      revisions: revisions(),
    });
    const [tool] = (await catalog.list(snapshot(), new AbortController().signal)).filter(
      (candidate) => candidate.source === "client",
    );
    if (tool === undefined) {
      throw new Error("expected client Tool");
    }

    await expect(
      catalog.call({
        runId: "run-1",
        snapshot: snapshot(),
        tool,
        arguments: { query: "antnest" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "found" }],
      isError: false,
      toolEffectState: "settled",
    });
    expect(client.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { query: "antnest" } },
      expect.any(AbortSignal),
    );
    expect(client.close).toHaveBeenCalled();
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
      clientDialer: fakeDialer([]).dialer,
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
      clientDialer: fakeDialer([]).dialer,
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
    expect(error).toMatchObject({ effectState: "unknown" });
    expect(runtime.callTool).toHaveBeenCalledTimes(1);
  });

  it("treats an unconfirmed client Tool outcome as unknown side effects", async () => {
    const client = fakeDialer([{ name: "search", description: "Search" }]);
    client.callTool.mockRejectedValueOnce(new TypeError("connection reset"));
    const catalog = new McpToolCatalog({
      runtimeDialer: fakeDialer([]).dialer,
      clientDialer: client.dialer,
      revisions: revisions(),
    });
    const tool = (await catalog.list(snapshot(), new AbortController().signal)).find(
      (candidate) => candidate.source === "client",
    );
    if (tool === undefined) {
      throw new Error("expected client Tool");
    }

    const error = await catalog
      .call({
        runId: "run-1",
        snapshot: snapshot(),
        tool,
        arguments: { query: "antnest" },
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpToolCallError);
    expect(error).toMatchObject({ effectState: "unknown" });
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("keeps Runtime Tools when an optional client MCP source is unavailable", async () => {
    const runtime = fakeDialer([{ name: "read", description: "Read" }]);
    const client = fakeDialer([]);
    client.connect.mockRejectedValueOnce(new TypeError("client MCP unavailable"));
    const catalog = new McpToolCatalog({
      runtimeDialer: runtime.dialer,
      clientDialer: client.dialer,
      revisions: revisions(),
    });

    await expect(catalog.list(snapshot(), new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ source: "runtime", modelName: "read" }),
    ]);
  });
});

function fakeDialer(
  tools: Array<{ name: string; description: string }>,
  result = { content: [] as Array<{ type: string; [key: string]: unknown }>, isError: false },
): {
  dialer: McpDialer;
  connect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const callTool = vi.fn(() => Promise.resolve(result));
  const close = vi.fn(() => Promise.resolve());
  const connection: McpConnection = {
    listTools: vi.fn(() => Promise.resolve(tools)),
    callTool,
    close,
  };
  const connect = vi.fn(() => Promise.resolve(connection));
  return { dialer: { connect }, connect, callTool, close };
}

function revisions(): ClientMcpRevisionPort {
  return {
    getClientMcpRevision: vi.fn(() =>
      Promise.resolve([
        {
          sourceId: "client-source-1",
          name: "docs",
          url: "https://mcp.example.test/mcp",
          headers: [{ name: "authorization", value: "Bearer secret" }],
        },
      ]),
    ),
  };
}

function snapshot(): RunExecutionSnapshot {
  return {
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
      credentialRef: "credential-1",
    },
    clientMcpRevisionId: "client-mcp-1",
  };
}
