import { describe, expect, it } from "vitest";

import { OfficialMcpDialer } from "../../../src/adapters/mcp/official-client.js";
import { McpToolCatalog } from "../../../src/adapters/mcp/tool-catalog.js";
import { startProgressFixture } from "../../support/mcp-progress-fixture.js";
import { snapshot } from "../../support/fixtures.js";

describe("Official MCP presentation metadata", () => {
  it.each([false, true])(
    "consumes namespaced file facts only on successful SDK results (error=%s)",
    async (isError) => {
      const fixture = await startProgressFixture({
        toolName: "write",
        meta: {
          "io.antnest.runtime/file": {
            path: "/home/agent/a.txt",
            diff: { oldText: null, newText: "CONTENT-ONLY-IN-DIFF" },
          },
          unrelated: "ignored",
        },
        structuredContent: { bytes_written: 20, effect_state: "settled" },
      });
      try {
        fixture.finish(isError);
        const catalog = new McpToolCatalog({
          runtimeDialer: new OfficialMcpDialer({ trust: "runtime" }),
          revisions: { getClientMcpRevision: () => Promise.resolve([]) },
        });
        const execution = snapshot();
        execution.runtime.mcpEndpoint = fixture.endpoint.href;
        const tool = (await catalog.list(execution, AbortSignal.timeout(5000)))[0]!;
        const result = await catalog.call({
          runId: "run",
          snapshot: execution,
          tool,
          arguments: { path: "ignored" },
          signal: AbortSignal.timeout(5000),
        });
        expect(result.isError).toBe(isError);
        expect(result.file).toEqual(
          isError
            ? undefined
            : {
                path: "/home/agent/a.txt",
                change: { before: null, after: "CONTENT-ONLY-IN-DIFF" },
              },
        );
        expect(JSON.stringify(result.content)).not.toContain("CONTENT-ONLY-IN-DIFF");
        expect(JSON.stringify(result.structuredContent)).not.toContain("CONTENT-ONLY-IN-DIFF");
        expect(result).not.toHaveProperty("meta");
        expect(fixture.executionIds).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );
  it("preserves tools/list title through the SDK and catalog without executing the Tool", async () => {
    const fixture = await startProgressFixture({ title: "Read company document" });
    try {
      const catalog = new McpToolCatalog({
        runtimeDialer: new OfficialMcpDialer({ trust: "runtime" }),
        revisions: { getClientMcpRevision: () => Promise.resolve([]) },
      });
      const execution = snapshot();
      execution.runtime.mcpEndpoint = fixture.endpoint.href;
      const tools = await catalog.list(execution, AbortSignal.timeout(5000));
      expect(tools[0]).toMatchObject({
        name: "read",
        modelName: "read",
        title: "Read company document",
        source: "runtime",
      });
      expect(fixture.executionIds).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
