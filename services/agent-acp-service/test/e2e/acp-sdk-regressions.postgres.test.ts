import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/adapters/postgres/migrate.js";
import { PostgresKernel } from "../../src/adapters/postgres/kernel.js";
import { PostgresContextRepository } from "../../src/adapters/postgres/context-repository.js";
import { PostgresExecutionRepository } from "../../src/adapters/postgres/execution-repository.js";
import type { ModelResult } from "../../src/ports/model.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import type { AcpWireClient } from "../support/acp-wire-client.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const answer: ModelResult = {
  kind: "message",
  content: [{ type: "text", text: "safe-answer" }],
  stopReason: "end_turn",
  usage: { inputTokens: 2, outputTokens: 2 },
};
const goodPlan = [{ content: "safe-plan", priority: "high" as const, status: "pending" as const }];
function plan(content: string): ModelResult {
  return {
    kind: "tool_calls",
    content: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    calls: [
      { id: "plan", name: "update_plan", arguments: { entries: [{ ...goodPlan[0], content }] } },
    ],
  };
}
function prompt(client: AcpWireClient, sessionId: string, text: string) {
  return client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
}

describe.skipIf(databaseUrl === undefined)("SDK semantic regressions with durable Sessions", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const kernel = new PostgresKernel(pool);
  const contexts = new PostgresContextRepository(kernel);
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
    app.model.complete.mockReset().mockResolvedValue(answer);
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each(["same", "load", "resume", "fork", "restart"])(
    "refusal excludes the whole turn from %s context while retaining transcript and earlier checkpoint",
    async (restore) => {
      let client = await app.connect(1);
      const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
      app.model.complete.mockResolvedValueOnce(plan("safe-plan"));
      expect((await prompt(client, sessionId, "safe-user")).error).toBeUndefined();
      const throughSequence = (await app.sessions.readOutput(sessionId)).sequence;
      await contexts.saveCheckpoint({
        id: randomUUID(),
        sessionId,
        throughSequence,
        summary: "safe-user safe-answer",
        tokenCount: 4,
        createdAt: new Date(),
      });
      app.model.complete
        .mockResolvedValueOnce(plan("refused-plan-marker"))
        .mockResolvedValueOnce({
          kind: "tool_calls",
          content: [{ type: "text", text: "refused-assistant-marker" }],
          thought: [{ type: "text", text: "refused-thought-marker" }],
          usage: { inputTokens: 1, outputTokens: 1 },
          calls: [{ id: "read", name: "read", arguments: { path: "refused-argument-marker" } }],
        })
        .mockResolvedValueOnce({
          ...answer,
          stopReason: "refusal",
          content: [{ type: "text", text: "refused-answer-marker" }],
        });
      app.tools.call.mockResolvedValueOnce({
        content: [{ type: "text", text: "refused-tool-marker" }],
        isError: false,
        toolEffectState: "settled",
        runtimeCallStopped: true,
      });
      expect((await prompt(client, sessionId, "refused-user-marker")).result).toEqual({
        stopReason: "refusal",
      });
      expect(JSON.stringify(await app.sessions.readOutput(sessionId, 0))).toContain(
        "refused-user-marker",
      );
      expect((await contexts.load(sessionId)).checkpoint?.summary).toBe("safe-user safe-answer");
      let target = sessionId;
      if (restore === "restart") {
        await app.close();
        app = await startBoundaryApplication(pool);
        app.model.complete.mockReset().mockResolvedValue(answer);
        client = await app.connect(1);
        expect(
          (await client.request("session/load", { ...setup, sessionId })).error,
        ).toBeUndefined();
      } else if (restore !== "same") {
        const result = await client.request(`session/${restore}`, { ...setup, sessionId });
        expect(result.error).toBeUndefined();
        if (restore === "fork") target = String(result.result?.sessionId);
      }
      const source = await contexts.load(target);
      expect(source.plan).toEqual(goodPlan);
      expect(JSON.stringify(source)).not.toContain("refused-");
      expect((await prompt(client, target, "allowed-next-user")).result).toEqual({
        stopReason: "end_turn",
      });
      const request = app.model.complete.mock.calls.at(-1)![0];
      expect(JSON.stringify(request.messages)).toContain("safe-user");
      expect(JSON.stringify(request.messages)).toContain("allowed-next-user");
      expect(JSON.stringify(request.messages)).not.toContain("refused-");
    },
  );

  for (const version of [1, 2] as const) {
    for (const method of ["session/close", "session/delete"] as const) {
      it(`v${version}: ${method} cancels active work and releases all observers, keeping unrelated Sessions usable`, async () => {
        const owner = await app.connect(version);
        const observer = await app.connect(version === 1 ? 2 : 1);
        const sessionId = String((await owner.request("session/new", setup)).result?.sessionId);
        const otherId = String((await owner.request("session/new", setup)).result?.sessionId);
        await observer.request(version === 1 ? "session/resume" : "session/load", {
          ...setup,
          sessionId,
        });
        const started = Promise.withResolvers<void>();
        app.model.complete.mockImplementationOnce(async ({ signal }) => {
          started.resolve();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          signal.throwIfAborted();
          return answer;
        });
        const active = prompt(owner, sessionId, "active");
        await started.promise;
        expect((await owner.request(method, { sessionId })).result).toEqual({});
        const response = await active;
        expect(response.result).toEqual(version === 1 ? { stopReason: "cancelled" } : {});
        expect((await pool.query("SELECT state FROM runs")).rows).toEqual([{ state: "cancelled" }]);
        expect((await owner.request(method, { sessionId })).error).toBeUndefined();
        const readCount = () =>
          app.readOutput.mock.calls.filter(([input]) => input.sessionId === sessionId).length;
        const reads = readCount();
        const offset = owner.frames.length;
        app.configuration.agents[0]!.default_authorization.mode = "chat";
        await app.publishConfiguration();
        await expect
          .poll(() =>
            owner.frames
              .slice(offset)
              .some(
                (frame) =>
                  frame.params?.sessionId === otherId &&
                  frame.params.update?.sessionUpdate === "config_option_update",
              ),
          )
          .toBe(true);
        expect(readCount()).toBe(reads);
        expect((await prompt(owner, otherId, "other still usable")).error).toBeUndefined();
        await expect
          .poll(
            async () =>
              (
                await pool.query<{ n: number }>(
                  "SELECT count(*)::int AS n FROM runs WHERE state IN ('admitting','running')",
                )
              ).rows[0]?.n,
          )
          .toBe(0);
        if (method === "session/close") {
          await owner.request(version === 1 ? "session/load" : "session/resume", {
            ...setup,
            sessionId,
          });
          const resumedOffset = owner.frames.length;
          app.configuration.agents[0]!.default_authorization.mode = "auto";
          await app.publishConfiguration();
          await expect
            .poll(() =>
              owner.frames
                .slice(resumedOffset)
                .some(
                  (frame) =>
                    frame.params?.sessionId === sessionId &&
                    frame.params.update?.sessionUpdate === "config_option_update",
                ),
            )
            .toBe(true);
        }
      });
    }
  }

  it.each([true, false])(
    "v1 cancellation preserves unknown effects and independent Runtime stopping evidence=%s",
    async (runtimeCallStopped) => {
      const started = Promise.withResolvers<void>();
      app.model.complete.mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        calls: [{ id: "read", name: "read", arguments: { path: "file" } }],
      });
      app.tools.call.mockImplementationOnce(async ({ signal }) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw Object.assign(new Error("Unknown Tool effects"), {
          effectState: "unknown",
          runtimeCallStopped,
        });
      });
      const owner = await app.connect(1);
      const canceller = await app.connect(1);
      const sessionId = String((await owner.request("session/new", setup)).result?.sessionId);
      const active = prompt(owner, sessionId, "cancel");
      await started.promise;
      canceller.notify("session/cancel", { sessionId });
      expect((await active).result).toEqual({ stopReason: "cancelled" });
      expect(
        (await pool.query("SELECT state, tool_effect_state, error_class FROM runs")).rows,
      ).toEqual([
        {
          state: "unresolved",
          tool_effect_state: "unknown",
          error_class: "cancelled_tool_outcome_unknown",
        },
      ]);
      expect(
        await new PostgresExecutionRepository(kernel).hasUnstoppedRuntimeCalls({
          organizationId: "organization-1",
          agentId: "agent-1",
          runtimeRevision: null,
        }),
      ).toBe(!runtimeCallStopped);
      expect(app.tools.call).toHaveBeenCalledOnce();
      if (!runtimeCallStopped) {
        expect((await prompt(owner, sessionId, "do not replay")).error?.data?.code).toBe(
          "runtime_barrier_required",
        );
        expect(app.tools.call).toHaveBeenCalledOnce();
      }
    },
  );
});
