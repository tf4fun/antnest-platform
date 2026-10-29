import { describe, expect, it, vi } from "vitest";
import { ContextBuilder } from "../../src/application/context-builder.js";
import { compactModelContext } from "../../src/application/context-compaction.js";
import { toOpenAIMessages } from "../../src/adapters/model/openai-content.js";
import { emptyRuntimePreparation } from "../fixtures/runtime-information.js";
import { snapshot } from "../support/fixtures.js";

describe("Plan context", () => {
  it.each([
    { plan: [] },
    { plan: [{ content: "private plan", priority: "high" as const, status: "pending" as const }] },
  ])(
    "preserves a labelled Run-start snapshot through real budget-driven compaction: %j",
    async ({ plan }) => {
      const saveCheckpoint = vi.fn();
      const builder = new ContextBuilder({
        ...emptyRuntimePreparation(),
        id: () => "checkpoint",
        now: () => new Date(),
        repository: {
          load: () =>
            Promise.resolve({
              plan,
              checkpoint: null,
              messages: [
                {
                  sequence: 1,
                  kind: "user_message" as const,
                  content: [{ type: "text", text: "Original task" }],
                },
                {
                  sequence: 2,
                  kind: "agent_message" as const,
                  content: [{ type: "text", text: "old history ".repeat(500) }],
                },
                {
                  sequence: 3,
                  kind: "user_message" as const,
                  content: [{ type: "text", text: "latest" }],
                },
              ],
            }),
          saveCheckpoint,
        },
      });
      const execution = snapshot();
      execution.executionSpec.model.contextWindow = 4096;
      execution.executionSpec.model.maxOutputTokens = 128;
      const context = await builder.build(
        "session",
        execution,
        new AbortController().signal,
        "run-1",
      );
      expect(saveCheckpoint).toHaveBeenCalledOnce();
      expect(context.messages[1]).toMatchObject({ role: "assistant" });
      expect(JSON.stringify(context.messages[1])).toContain("plan at Run start");
      expect(JSON.stringify(context.messages[1])).toContain("later successful update_plan");
      expect(context.messages[1]?.content[0]).toHaveProperty(
        "text",
        expect.stringContaining(JSON.stringify(plan)),
      );
      expect(JSON.stringify(context.messages[0])).not.toContain("private plan");
      expect(JSON.stringify(context.messages.at(-1))).toContain("latest");
      expect(
        JSON.stringify(toOpenAIMessages(context.messages, execution.executionSpec.model)),
      ).not.toContain('"pinned"');
      const recompacted = await compactModelContext({
        snapshot: execution,
        messages: context.messages,
        tools: context.tools,
        signal: new AbortController().signal,
        force: true,
      });
      const pinnedPlan = recompacted.messages.find((message) =>
        JSON.stringify(message).includes("plan at Run start"),
      );
      expect(pinnedPlan?.role).toBe("assistant");
      expect(JSON.stringify(recompacted.messages)).toContain("later successful update_plan");
    },
  );
});
