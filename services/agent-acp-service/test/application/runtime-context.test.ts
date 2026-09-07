import { describe, expect, it, vi } from "vitest";
import { ContextBuilder } from "../../src/application/context-builder.js";
import { runtimeContext } from "../../src/application/runtime-context.js";
import type { RuntimeInformationPort } from "../../src/ports/runtime-information.js";
import { runtimeInformation, runtimeSnapshot } from "../fixtures/runtime-information.js";

describe("Runtime context preparation", () => {
  it("preserves workspace guidance and complete skill entries when the catalog exceeds the budget", () => {
    const info = runtimeInformation();
    info.skills = Array.from({ length: 64 }, (_, index) => ({
      source: "system" as const,
      name: `skill-${index}`,
      description: "x".repeat(512),
      path: { root: "system_skills" as const, path: `skill-${index}/SKILL.md` },
    }));
    const text = runtimeContext(info, 16384);
    expect(text).toContain('"root":"workspace","path":"AGENTS.md"');
    expect(text).toContain("Use the company style guide");
    expect(text).toContain("Runtime information truncated");
    expect(text.length).toBeLessThanOrEqual(16384);
    const skillLines = text.split("\n").filter((line) => line.startsWith('{"source":'));
    expect(skillLines.length).toBeGreaterThan(0);
    expect(skillLines.length).toBeLessThan(64);
    for (const line of skillLines)
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
  });

  it("refreshes guidance, summary paths and tool schemas per Run without storing them", async () => {
    const info = runtimeInformation();
    const read = vi.fn<RuntimeInformationPort["read"]>().mockResolvedValue(info);
    const list = vi.fn().mockResolvedValue([
      {
        source: "runtime",
        sourceId: "runtime",
        name: "mcp__documents__search",
        modelName: "mcp__documents__search",
        description: "Search documents",
        inputSchema: { type: "object" },
      },
    ]);
    const saveCheckpoint = vi.fn();
    const builder = new ContextBuilder({
      repository: {
        load: vi.fn().mockResolvedValue({
          checkpoint: null,
          messages: [
            { sequence: 1, kind: "user_message", content: [{ type: "text", text: "hello" }] },
          ],
        }),
        saveCheckpoint,
      },
      runtimeInformation: { read },
      tools: { list },
      id: () => "checkpoint",
      now: () => new Date(),
    });
    const first = await builder.build("session", runtimeSnapshot(), new AbortController().signal);
    expect(JSON.stringify(first.messages)).toContain("Workspace guidance");
    expect(JSON.stringify(first.messages)).toContain("Use the company style guide");
    expect(JSON.stringify(first.messages)).toContain("documents/SKILL.md");
    expect(first.tools[0]?.modelName).toBe("mcp__documents__search");
    info.instructions = {
      path: { root: "workspace", path: "AGENTS.md" },
      content: "Updated guidance",
      truncated: false,
    };
    const second = await builder.build("session", runtimeSnapshot(), new AbortController().signal);
    expect(JSON.stringify(second.messages)).toContain("Updated guidance");
    expect(read).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
    expect(saveCheckpoint).not.toHaveBeenCalled();
  });

  it("budgets tool definitions and large Runtime information before sending the newest prompt", async () => {
    const info = runtimeInformation();
    if (info.instructions !== null) info.instructions.content = "x".repeat(16000);
    const snapshot = runtimeSnapshot();
    snapshot.executionSpec.model.contextWindow = 2048;
    snapshot.executionSpec.model.maxOutputTokens = 256;
    const builder = new ContextBuilder({
      repository: {
        load: vi.fn().mockResolvedValue({
          checkpoint: null,
          messages: [
            {
              sequence: 1,
              kind: "user_message",
              content: [{ type: "text", text: "Keep this question" }],
            },
          ],
        }),
        saveCheckpoint: vi.fn(),
      },
      runtimeInformation: { read: vi.fn().mockResolvedValue(info) },
      tools: { list: vi.fn().mockResolvedValue([]) },
      id: () => "checkpoint",
      now: () => new Date(),
    });
    const result = await builder.build("session", snapshot, new AbortController().signal);
    expect(JSON.stringify(result.messages)).toContain("Runtime information truncated");
    expect(JSON.stringify(result.messages.at(-1))).toContain("Keep this question");
    expect(JSON.stringify(result.messages).length).toBeLessThan(6000);
  });

  it("rejects a tool catalog that leaves no prompt capacity", async () => {
    const snapshot = runtimeSnapshot();
    snapshot.executionSpec.model.contextWindow = 1024;
    snapshot.executionSpec.model.maxOutputTokens = 128;
    const builder = new ContextBuilder({
      repository: {
        load: vi.fn().mockResolvedValue({ checkpoint: null, messages: [] }),
        saveCheckpoint: vi.fn(),
      },
      runtimeInformation: { read: vi.fn().mockResolvedValue(runtimeInformation()) },
      tools: {
        list: vi.fn().mockResolvedValue([
          {
            name: "large",
            modelName: "large",
            source: "runtime",
            sourceId: "runtime",
            description: "x".repeat(8000),
          },
        ]),
      },
      id: () => "checkpoint",
      now: () => new Date(),
    });
    await expect(
      builder.build("session", snapshot, new AbortController().signal),
    ).rejects.toMatchObject({ code: "context_budget_exhausted" });
  });
});
