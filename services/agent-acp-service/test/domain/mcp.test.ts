import { describe, expect, it } from "vitest";

import {
  mergeToolCatalogs,
  normalizeClientMcpServers,
  qualifyClientToolName,
} from "../../src/domain/mcp.js";

describe("MCP source model", () => {
  it("accepts only HTTP sources and excludes secret header values from source identity", () => {
    const first = normalizeClientMcpServers([
      {
        type: "http",
        name: "knowledge",
        url: "https://mcp.example.test/service",
        headers: [{ name: "Authorization", value: "Bearer first-secret" }],
      },
    ]);
    const second = normalizeClientMcpServers([
      {
        type: "http",
        name: "knowledge",
        url: "https://mcp.example.test/service",
        headers: [{ name: "Authorization", value: "Bearer rotated-secret" }],
      },
    ]);

    expect(first[0]?.sourceId).toBe(second[0]?.sourceId);
    expect(first[0]?.headers).not.toEqual(second[0]?.headers);
    expect(() =>
      normalizeClientMcpServers([
        {
          type: "stdio",
          name: "unsafe",
          command: "/bin/sh",
        },
      ]),
    ).toThrow(/HTTP/u);
  });

  it("rejects insecure client MCP endpoints before persistence", () => {
    expect(() =>
      normalizeClientMcpServers([
        { type: "http", name: "unsafe", url: "http://mcp.example.test/mcp" },
      ]),
    ).toThrow(/HTTPS/u);
  });

  it("qualifies client Tool names deterministically", () => {
    const first = qualifyClientToolName("source-a", "read");
    const second = qualifyClientToolName("source-a", "read");

    expect(first).toBe(second);
    expect(first).not.toBe("read");
    expect(first).toMatch(/^client_[a-z0-9_]+_[a-f0-9]{8}$/u);
  });

  it("keeps Runtime Tool names canonical and makes client collisions impossible", () => {
    const catalog = mergeToolCatalogs(
      [{ source: "runtime", sourceId: "runtime", name: "read", description: "Read" }],
      [
        { source: "client", sourceId: "source-a", name: "read", description: "Fake read" },
        { source: "client", sourceId: "source-b", name: "read", description: "Other read" },
      ],
    );

    expect(catalog.map((tool) => tool.modelName)).toHaveLength(3);
    expect(catalog[0]?.modelName).toBe("read");
    expect(new Set(catalog.map((tool) => tool.modelName)).size).toBe(3);
  });
});
