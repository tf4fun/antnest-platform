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
    const clientConnect = vi.fn();
    const catalog = new McpToolCatalog({
      runtimeDialer: { connect },
      clientDialer: { connect: clientConnect },
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
    expect(clientConnect).not.toHaveBeenCalled();
    readResource.mockRejectedValueOnce(new Error("cancelled"));
    await expect(catalog.read(runtimeSnapshot(), signal)).rejects.toThrow("cancelled");
    expect(close).toHaveBeenCalledTimes(3);
  });
});
