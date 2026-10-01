import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OfficialMcpDialer } from "../../../../../services/agent-acp-service/src/adapters/mcp/official-client.js";
import { McpToolCatalog } from "../../../../../services/agent-acp-service/src/adapters/mcp/tool-catalog.js";
import { ToolPreflight } from "../../../../../services/agent-acp-service/src/application/tool-preflight.js";
import { snapshot } from "../../../../../services/agent-acp-service/test/support/fixtures.js";
import { startProgressFixture } from "../../support/mcp-progress-fixture.js";

describe("Official MCP flat read inputs", () => {
  it("uses the published string schema for model calls and internal Skill reads", async () => {
    const fixture = await startProgressFixture({
      inputSchema: z.strictObject({
        path: z.string().min(1),
        offset: z.int().min(1).default(1),
        limit: z.int().min(1).max(20000).default(2000),
      }),
      structuredContent: {
        content: "---\nname: inspect-first\n---\n",
        truncated: false,
        next_offset: null,
        effect_state: "settled",
      },
    });
    try {
      fixture.finish();
      const catalog = new McpToolCatalog({
        runtimeDialer: new OfficialMcpDialer({ trust: "runtime" }),
        revisions: { getClientMcpRevision: () => Promise.resolve([]) },
      });
      const execution = snapshot();
      execution.runtime.mcpEndpoint = fixture.endpoint.href;
      const signal = AbortSignal.timeout(5000);
      const tools = await catalog.list(execution, signal);
      expect(tools[0]?.inputSchema?.properties).toMatchObject({
        path: { type: "string" },
      });
      const check = new ToolPreflight().inspect(
        [{ id: "read", name: "read", arguments: { path: "demo/check.md" } }],
        tools,
      );
      expect(check.kind).toBe("ready");
      if (check.kind !== "ready" || !check.calls[0])
        throw new Error("flat read was rejected");
      await catalog.call({
        runId: "run",
        snapshot: execution,
        tool: check.calls[0].tool,
        arguments: check.calls[0].call.arguments,
        signal,
      });
      await catalog.readPersonalSkill(
        execution.runtime,
        ".antnest/skills/inspect-first",
        signal,
      );
      expect(fixture.receivedArguments).toEqual([
        { path: "demo/check.md", offset: 1, limit: 2000 },
        {
          path: ".antnest/skills/inspect-first/SKILL.md",
          offset: 1,
          limit: 16385,
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
