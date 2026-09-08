import { describe, expect, it } from "vitest";

import { requireNoClientMcpServers, runtimeToolCatalog } from "../../src/domain/mcp.js";

describe("platform MCP boundary", () => {
  it("accepts empty client input", () => {
    expect(requireNoClientMcpServers([])).toEqual([]);
  });

  it.each(["http", "stdio", "sse", "acp"])("rejects client %s without disclosing input", (type) => {
    expect(() =>
      requireNoClientMcpServers([
        { type, name: "private-source", url: "https://private.example/mcp" },
      ]),
    ).toThrow(expect.objectContaining({ code: "client_mcp_not_allowed" }));
    expect(() => requireNoClientMcpServers([{ type, name: "private-source" }])).toThrow(
      "Client MCP injection is not supported",
    );
  });

  it("keeps platform tool names, including Runtime-managed MCP tools", () => {
    const tools = ["read", "mcp__documents__search"].map((name) => ({
      source: "runtime" as const,
      sourceId: "runtime",
      name,
      description: name,
    }));
    expect(runtimeToolCatalog(tools).map((tool) => tool.modelName)).toEqual([
      "read",
      "mcp__documents__search",
    ]);
  });

  it("rejects collisions and non-platform sources", () => {
    const tool = { source: "runtime" as const, sourceId: "runtime", name: "read", description: "" };
    expect(() => runtimeToolCatalog([tool, tool])).toThrow(/collision/u);
    expect(() => runtimeToolCatalog([{ ...tool, source: "client" }])).toThrow(
      expect.objectContaining({ code: "client_mcp_not_allowed" }),
    );
  });
});
