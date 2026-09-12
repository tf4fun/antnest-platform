import { describe, expect, it, vi } from "vitest";
import { TurnRunner } from "../../src/application/turn-runner.js";
import { ContextBuilder } from "../../src/application/context-builder.js";
import { planTool } from "../../src/domain/plan.js";
import type { Authorization } from "../../src/domain/session-configuration.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { RunEventPort } from "../../src/ports/run-events.js";
import { snapshot } from "../support/fixtures.js";
import { runtimeInformation } from "../fixtures/runtime-information.js";

describe("Admitted execution authorization", () => {
  it.each(["chat", "approve", "smart_approve", "auto"] as const)(
    "%s governs remote and local tools at dispatch",
    async (mode) => {
      const call = vi.fn(() =>
        Promise.resolve({
          content: [{ type: "text", text: "done" }],
          isError: false,
          toolEffectState: "settled" as const,
        }),
      );
      const events = {
        agentMessage: vi.fn(),
        agentThought: vi.fn(),
        usage: vi.fn(),
        toolStarted: vi.fn(),
        toolProgress: vi.fn(),
        toolFinished: vi.fn(),
        toolRejected: vi.fn(),
        updatePlan: vi.fn(() => Promise.resolve(true)),
      } satisfies RunEventPort;
      const model = vi
        .fn<ModelPort["complete"]>()
        .mockResolvedValueOnce({
          kind: "tool_calls",
          content: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          calls: [
            { id: "bash", name: "bash", arguments: {} },
            { id: "plan", name: "update_plan", arguments: { entries: [] } },
          ],
        })
        .mockResolvedValue({
          kind: "message",
          content: [{ type: "text", text: "reply" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      const frozen = snapshot();
      frozen.executionSpec.configuration = {
        modelProfileId: "p1",
        modelProfileRevisionId: "r1",
        authorization: { mode, toolRules: [] },
        authorizationRevision: 1,
        digest: "c".repeat(64),
      };
      const runner = new TurnRunner({
        model: { complete: model },
        tools: { call },
        events,
        catalog: [
          planTool,
          {
            source: "runtime",
            sourceId: "runtime",
            name: "bash",
            modelName: "bash",
            description: "Shell",
          },
        ],
      });
      const signal = new AbortController().signal;
      const result = await runner.run({
        runId: "run-1",
        sessionId: "session-1",
        snapshot: frozen,
        credential: "synthetic",
        context: [],
        signal,
        authoritySignal: signal,
      });
      expect(result.terminalClass).toBe("completed");
      expect(call).toHaveBeenCalledTimes(mode === "auto" ? 1 : 0);
      expect(events.updatePlan).toHaveBeenCalledTimes(mode === "auto" ? 1 : 0);
      expect(events.toolRejected).toHaveBeenCalledTimes(mode === "auto" ? 0 : 2);
      expect(model).toHaveBeenCalledTimes(mode === "smart_approve" ? 3 : 2);
      expect(
        model.mock.calls.filter(([request]) => request.purpose === "permission_judge"),
      ).toHaveLength(mode === "smart_approve" ? 1 : 0);
      expect(events.usage).toHaveBeenCalledTimes(mode === "smart_approve" ? 3 : 2);
      expect(events.agentMessage).toHaveBeenCalledTimes(2);
    },
  );

  it("Chat never discovers or advertises tools while retaining Runtime context", async () => {
    const list = vi.fn();
    const builder = new ContextBuilder({
      repository: {
        load: () => Promise.resolve({ checkpoint: null, messages: [] }),
        saveCheckpoint: vi.fn(),
      },
      runtimeInformation: { read: () => Promise.resolve(runtimeInformation()) },
      tools: { list },
      id: () => "id",
      now: () => new Date(),
    });
    const frozen = snapshot();
    frozen.executionSpec.configuration = {
      modelProfileId: "p1",
      modelProfileRevisionId: "r1",
      authorization: { mode: "chat", toolRules: [] } satisfies Authorization,
      authorizationRevision: 1,
      digest: "c".repeat(64),
    };
    const result = await builder.build("session-1", frozen, new AbortController().signal);
    expect(result.tools).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    expect(
      result.messages[0]?.content.some(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.includes("Runtime"),
      ),
    ).toBe(true);
  });
});
