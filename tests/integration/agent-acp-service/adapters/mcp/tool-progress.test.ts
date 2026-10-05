import { describe, expect, it, vi } from "vitest";

import { OfficialMcpDialer } from "../../../../../services/agent-acp-service/src/adapters/mcp/official-client.js";
import { startProgressFixture } from "../../support/mcp-progress-fixture.js";

describe("Official MCP Tool progress", () => {
  it("requests progress, filters unrelated tokens and delivers before the final HTTP result", async () => {
    const fixture = await startProgressFixture();
    const connection = await new OfficialMcpDialer({
      trust: "runtime",
      connections: fixture.authority.connections,
    }).connect({
      endpoint: fixture.endpoint,
      runtimeBinding: fixture.authority.binding,
      headers: {
        "x-antnest-expected-execution-id":
          fixture.authority.binding.executionId,
      },
      signal: AbortSignal.timeout(5000),
    });
    const progress = vi.fn();
    let settled = false;
    const pending = connection
      .callTool(
        { name: "read", arguments: { path: "file" } },
        AbortSignal.timeout(5000),
        progress,
      )
      .finally(() => {
        settled = true;
      });
    const observed = pending.catch(() => undefined);
    try {
      await fixture.progress(1, "wrong call", true);
      await fixture.progress(2, "partial");
      await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
      expect(progress).toHaveBeenCalledWith({
        progress: 2,
        message: "partial",
      });
      expect(settled).toBe(false);
      fixture.finish();
      expect(await pending).toMatchObject({
        content: [{ type: "text", text: "final result" }],
      });
      expect(fixture.executionIds).toEqual([
        fixture.authority.binding.executionId,
      ]);
    } finally {
      fixture.finish();
      await observed;
      await connection.close();
      await fixture.close();
    }
  });
});
