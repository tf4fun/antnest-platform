import { describe, expect, it, vi } from "vitest";
import {
  parseRuntimeInformation,
  RUNTIME_INFORMATION_URI,
} from "../../../src/adapters/mcp/runtime-information.js";
import { McpToolCatalog, type McpConnection } from "../../../src/adapters/mcp/tool-catalog.js";
import { runtimeInformation, runtimeSnapshot } from "../../fixtures/runtime-information.js";

function resource() {
  const { executionId, ...information } = runtimeInformation();
  return {
    contents: [
      {
        uri: RUNTIME_INFORMATION_URI,
        mimeType: "application/json",
        text: JSON.stringify({ execution_id: executionId, ...information }),
      },
    ],
  };
}

describe("Runtime information resource", () => {
  it.each(["system_skills", "workspace"] as const)(
    "reads a complete selected Skill from %s using the execution fence",
    async (root) => {
      const callTool = vi.fn().mockResolvedValue({
        content: [],
        isError: false,
        structuredContent: {
          content: "# Skill",
          truncated: false,
          effect_state: "settled",
          next_offset: null,
        },
      });
      const close = vi.fn().mockResolvedValue(undefined);
      const connect = vi.fn().mockResolvedValue({ callTool, close });
      const catalog = new McpToolCatalog({
        runtimeDialer: { connect },
        revisions: { getClientMcpRevision: vi.fn() },
      });
      const path = root === "workspace" ? ".antnest/skills/review/SKILL.md" : "review/SKILL.md";
      const signal = new AbortController().signal;
      await expect(
        catalog.readSkill(runtimeSnapshot().runtime, { root, path }, signal),
      ).resolves.toBe("# Skill");
      expect(callTool).toHaveBeenCalledWith(
        {
          name: "read",
          arguments: {
            path: `${root === "workspace" ? "/workspace" : "/skills"}/${path}`,
            offset: 1,
            limit: 16_385,
          },
        },
        signal,
      );
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { "x-antnest-expected-execution-id": "runtime-execution-1" },
        }),
      );
      callTool.mockResolvedValueOnce({
        content: [],
        isError: false,
        structuredContent: { content: "partial", truncated: true, effect_state: "settled" },
      });
      await expect(
        catalog.readSkill(runtimeSnapshot().runtime, { root, path }, signal),
      ).rejects.toThrow("incomplete");
      expect(close).toHaveBeenCalledTimes(2);
    },
  );
  it("validates execution identity and excludes deployment configuration", () => {
    expect(parseRuntimeInformation(resource(), "runtime-execution-1")).toEqual(
      runtimeInformation(),
    );
    expect(() => parseRuntimeInformation(resource(), "other-execution")).toThrow(
      "admitted execution",
    );
    const invalid = resource();
    const body = JSON.parse(invalid.contents[0]!.text) as Record<string, unknown>;
    body.mcp_servers = [{ env: { TOKEN: "not-context" } }];
    invalid.contents[0]!.text = JSON.stringify(body);
    expect(() => parseRuntimeInformation(invalid, "runtime-execution-1")).toThrow(
      "resource contract",
    );
  });

  it("rejects malformed, wrong-URI, blob and oversized resource responses", () => {
    const valid = resource();
    for (const invalid of [
      { contents: [] },
      { contents: [{ ...valid.contents[0], uri: "file:///workspace/AGENTS.md" }] },
      { contents: [{ uri: RUNTIME_INFORMATION_URI, mimeType: "application/json", blob: "e30=" }] },
      { contents: [{ ...valid.contents[0], text: "{" }] },
      { contents: [{ ...valid.contents[0], text: "x".repeat(1024 * 1024 + 1) }] },
    ])
      expect(() => parseRuntimeInformation(invalid, "runtime-execution-1")).toThrow(
        "resource contract",
      );
  });

  it("uses the admitted Runtime endpoint and fence for every read and closes connections", async () => {
    const readResource = vi.fn<McpConnection["readResource"]>().mockResolvedValue(resource());
    const close = vi.fn<McpConnection["close"]>().mockResolvedValue();
    const connect = vi.fn().mockResolvedValue({ readResource, close });
    const catalog = new McpToolCatalog({
      runtimeDialer: { connect },
      revisions: { getClientMcpRevision: vi.fn() },
    });
    const signal = new AbortController().signal;
    for (let i = 0; i < 2; i++)
      await expect(catalog.read(runtimeSnapshot(), signal)).resolves.toEqual(runtimeInformation());
    expect(connect).toHaveBeenCalledWith({
      endpoint: new URL(runtimeSnapshot().runtime.mcpEndpoint),
      headers: { "x-antnest-expected-execution-id": "runtime-execution-1" },
      signal,
    });
    expect(readResource).toHaveBeenCalledWith(RUNTIME_INFORMATION_URI, signal);
    expect(close).toHaveBeenCalledTimes(2);
    readResource.mockRejectedValueOnce(new Error("cancelled"));
    await expect(catalog.read(runtimeSnapshot(), signal)).rejects.toThrow("cancelled");
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("reads the current learning binding instead of the source Run snapshot", async () => {
    const current = { executionId: "current-execution", mcpEndpoint: "http://current.test/mcp" };
    const { executionId: sourceExecutionId, ...information } = runtimeInformation();
    expect(sourceExecutionId).not.toBe(current.executionId);
    const readResource = vi.fn<McpConnection["readResource"]>().mockResolvedValue({
      contents: [
        {
          uri: RUNTIME_INFORMATION_URI,
          mimeType: "application/json",
          text: JSON.stringify({ ...information, execution_id: current.executionId }),
        },
      ],
    });
    const close = vi.fn<McpConnection["close"]>().mockResolvedValue();
    const connect = vi.fn().mockResolvedValue({ readResource, close });
    const catalog = new McpToolCatalog({
      runtimeDialer: { connect },
      revisions: { getClientMcpRevision: vi.fn() },
    });
    const signal = new AbortController().signal;
    await expect(catalog.readBinding(current, signal)).resolves.toMatchObject({
      executionId: current.executionId,
    });
    expect(connect).toHaveBeenCalledWith({
      endpoint: new URL(current.mcpEndpoint),
      headers: { "x-antnest-expected-execution-id": current.executionId },
      signal,
    });
    expect(close).toHaveBeenCalledOnce();
    readResource.mockResolvedValueOnce(resource());
    await expect(catalog.readBinding(current, signal)).rejects.toThrow("admitted execution");
  });

  it("reads a bounded personal Skill directly from the current Runtime binding", async () => {
    const current = { executionId: "current-execution", mcpEndpoint: "http://current.test/mcp" };
    const callTool = vi.fn<McpConnection["callTool"]>().mockResolvedValue({
      content: [],
      isError: false,
      structuredContent: {
        content: '---\nname: "inspect-first"\n---\n',
        truncated: false,
        effect_state: "settled",
        effect_source: null,
      },
    });
    const close = vi.fn<McpConnection["close"]>().mockResolvedValue();
    const connect = vi.fn().mockResolvedValue({ callTool, close });
    const catalog = new McpToolCatalog({
      runtimeDialer: { connect },
      revisions: { getClientMcpRevision: vi.fn() },
    });
    const signal = new AbortController().signal;
    await expect(
      catalog.readPersonalSkill(current, ".antnest/skills/inspect-first", signal),
    ).resolves.toBe('---\nname: "inspect-first"\n---\n');
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "read",
        arguments: {
          path: ".antnest/skills/inspect-first/SKILL.md",
          offset: 1,
          limit: 16385,
        },
      },
      signal,
    );
    expect(connect).toHaveBeenCalledWith({
      endpoint: new URL(current.mcpEndpoint),
      headers: { "x-antnest-expected-execution-id": current.executionId },
      signal,
    });
    expect(close).toHaveBeenCalledOnce();
    callTool.mockResolvedValueOnce({
      content: [],
      isError: false,
      structuredContent: { content: "partial", truncated: true, effect_state: "settled" },
    });
    await expect(
      catalog.readPersonalSkill(current, ".antnest/skills/inspect-first", signal),
    ).rejects.toThrow("incomplete");
  });
});
