import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresExecutionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-repository.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresRunEventRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-event-repository.js";
import { PostgresRunRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { PostgresTemporarySkills } from "../../../../../services/agent-acp-service/src/adapters/postgres/temporary-skills.js";
import type { ContentBlock } from "../../../../../services/agent-acp-service/src/domain/types.js";
import type { ModelUsage } from "../../../../../services/agent-acp-service/src/domain/usage.js";
import type {
  FinishToolAttemptInput,
  RunEventRepository,
  StartToolAttemptInput,
} from "../../../../../services/agent-acp-service/src/ports/run-event-repository.js";
import {
  binding,
  snapshot,
} from "../../../../../services/agent-acp-service/test/support/fixtures.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const acceptedAt = new Date("2026-09-14T00:00:01Z");
const eventAt = new Date("2026-09-14T00:00:02Z");
const finishedAt = new Date("2026-09-14T00:00:03Z");
const simpleKinds = ["message", "thought", "rejected", "usage"] as const;
type SimpleKind = (typeof simpleKinds)[number];

function text(value: string): ContentBlock[] {
  return [{ type: "text", text: value }];
}

describe.skipIf(databaseUrl === undefined)(
  "committed Run event replay in PostgreSQL",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const kernel = new PostgresKernel(pool);
    const sessions = new PostgresSessionRepository(
      kernel,
      new SecretBox(randomBytes(32)),
    );
    const runs = new PostgresRunRepository(kernel);
    const events = new PostgresRunEventRepository(kernel);
    const executions = new PostgresExecutionRepository(kernel);
    const temporarySkills = new PostgresTemporarySkills(kernel);

    beforeEach(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
    });
    afterAll(async () => {
      await pool.end();
    });

    async function accept(
      runtimeRevision?: string,
      agentId = binding().agentId,
    ) {
      const sessionId = randomUUID();
      const runId = randomUUID();
      const revisionId = randomUUID();
      await sessions.create({
        sessionId,
        binding: { ...binding(), agentId },
        cwd: "/workspace",
        mcpRevisionId: revisionId,
        mcpSources: [],
      });
      await runs.createRunIntent({
        runId,
        requestId: randomUUID(),
        sessionId,
        expectedAccessRevision: "access-1",
        userMessageId: randomUUID(),
        prompt: text("write the report"),
        createdAt: new Date("2026-09-14T00:00:00Z"),
      });
      const frozen = snapshot();
      frozen.clientMcpRevisionId = revisionId;
      if (runtimeRevision !== undefined)
        frozen.runtime.revision = runtimeRevision;
      expect(
        await runs.acceptRun({
          runId,
          snapshot: frozen,
          environmentFact: null,
          acceptedAt,
        }),
      ).toBe("accepted");
      return { sessionId, runId, snapshot: frozen };
    }

    async function stored(sessionId: string) {
      return {
        session: (
          await pool.query(
            "SELECT to_jsonb(acp_sessions) AS record FROM acp_sessions WHERE id = $1",
            [sessionId],
          )
        ).rows,
        runs: (
          await pool.query(
            "SELECT to_jsonb(runs) AS record FROM runs WHERE session_id = $1 ORDER BY id",
            [sessionId],
          )
        ).rows,
        messages: (
          await pool.query(
            "SELECT to_jsonb(session_messages) AS record FROM session_messages WHERE session_id = $1 ORDER BY sequence",
            [sessionId],
          )
        ).rows,
        attempts: (
          await pool.query(
            `SELECT to_jsonb(attempt) AS record FROM tool_attempts attempt
             JOIN runs run ON run.id = attempt.run_id
             WHERE run.session_id = $1 ORDER BY attempt.id`,
            [sessionId],
          )
        ).rows,
      };
    }

    async function expectSequence(sessionId: string, expected: number) {
      expect(
        (
          await pool.query(
            "SELECT last_message_sequence::int AS sequence FROM acp_sessions WHERE id = $1",
            [sessionId],
          )
        ).rows,
      ).toEqual([{ sequence: expected }]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS total FROM session_messages WHERE session_id = $1",
            [sessionId],
          )
        ).rows,
      ).toEqual([{ total: expected }]);
    }

    function simpleInput(runId: string) {
      const usage: ModelUsage = {
        inputTokens: 100,
        outputTokens: 10,
        cost: { amount: 0.03, currency: "USD", source: "provider_reported" },
      };
      return {
        id: randomUUID(),
        runId,
        createdAt: eventAt,
        content: text("original event"),
        responseId: "response-original",
        call: {
          id: "rejected-call",
          name: "restricted-tool",
          arguments: { target: "original" },
        },
        message: "Tool is not available",
        usage,
        contextSize: 64000,
      };
    }

    function writeSimple(
      repository: PostgresRunEventRepository,
      kind: SimpleKind,
      input: ReturnType<typeof simpleInput>,
    ) {
      switch (kind) {
        case "message":
          return repository.appendAgentMessage(input);
        case "thought":
          return repository.appendAgentThought(input);
        case "rejected":
          return repository.appendRejectedToolCall(input);
        case "usage":
          return repository.appendUsage(input);
      }
    }

    // These cases await a real commit and then repeat its fixed request. They
    // specify repository replay, not real network commit-response loss.
    it.each(simpleKinds)(
      "returns the original %s receipt without appending or charging again",
      async (kind) => {
        const { sessionId, runId } = await accept();
        const input = simpleInput(runId);
        const original = await writeSimple(events, kind, input);
        const before = await stored(sessionId);
        const reopened = new PostgresRunEventRepository(kernel);
        await expect(writeSimple(reopened, kind, input)).resolves.toEqual(
          original,
        );
        expect(await stored(sessionId)).toEqual(before);
        await expectSequence(sessionId, 2);
        expect(
          (
            await pool.query(
              "SELECT created_at FROM session_messages WHERE id = $1",
              [input.id],
            )
          ).rows,
        ).toEqual([{ created_at: eventAt }]);
        if (kind === "usage")
          expect(original).toMatchObject({
            kind: "usage",
            cost: { amount: 0.03, currency: "USD" },
            measurement: input.usage,
          });
      },
    );

    it.each(simpleKinds)(
      "rejects changed %s payload for the same ID without changing history",
      async (kind) => {
        const { sessionId, runId } = await accept();
        const input = simpleInput(runId);
        await writeSimple(events, kind, input);
        const before = await stored(sessionId);
        await expect(
          writeSimple(events, kind, {
            ...input,
            content: text("different event"),
            message: "Different rejection",
            call: { ...input.call, arguments: { target: "different" } },
            usage: { ...input.usage, outputTokens: 11 },
          }),
        ).rejects.toThrow();
        expect(await stored(sessionId)).toEqual(before);
      },
    );

    it.each(simpleKinds)(
      "rejects a %s receipt ID belonging to another Run without changing either Run",
      async (kind) => {
        const originalRun = await accept();
        const otherRun = await accept(undefined, "independent-receipt-agent");
        const input = simpleInput(originalRun.runId);
        await writeSimple(events, kind, input);
        const originalState = await stored(originalRun.sessionId);
        const otherState = await stored(otherRun.sessionId);
        await expect(
          writeSimple(events, kind, { ...input, runId: otherRun.runId }),
        ).rejects.toThrow();
        expect(await stored(originalRun.sessionId)).toEqual(originalState);
        expect(await stored(otherRun.sessionId)).toEqual(otherState);
      },
    );

    function startInput(runId: string): StartToolAttemptInput {
      return {
        id: randomUUID(),
        runId,
        toolCallId: randomUUID(),
        tool: {
          source: "runtime",
          sourceId: "runtime",
          name: "bash",
          modelName: "runtime_bash",
          description: "Run a workspace command",
        },
        presentation: { title: "Run report command", toolKind: "execute" },
        arguments: { command: "write report" },
        requestDigest: "a".repeat(64),
        createdAt: eventAt,
      };
    }

    function finishInput(start: StartToolAttemptInput): FinishToolAttemptInput {
      return {
        id: randomUUID(),
        runId: start.runId,
        toolCallId: start.toolCallId,
        status: "completed",
        content: text("report written"),
        resultSummary: text("original summary"),
        toolEffectState: "settled",
        runtimeCallStopped: true,
        rawOutput: { result: "original output" },
        file: {
          path: "/workspace/report.txt",
          change: { before: null, after: "report" },
        },
        createdAt: finishedAt,
      };
    }

    async function attempt(runId: string) {
      return (
        await pool.query<Record<string, unknown>>(
          `SELECT source, source_id, tool_name, request_digest, state,
                  tool_effect_state, runtime_call_stopped, result_summary,
                  started_at, finished_at
             FROM tool_attempts WHERE run_id = $1 ORDER BY id`,
          [runId],
        )
      ).rows;
    }

    it("confirms one committed Tool start with its original digest and source", async () => {
      const { sessionId, runId } = await accept();
      const input = startInput(runId);
      const original = await events.startToolAttempt(input);
      const before = await stored(sessionId);
      await expect(events.startToolAttempt(input)).resolves.toEqual(original);
      expect(await stored(sessionId)).toEqual(before);
      expect(await attempt(runId)).toEqual([
        expect.objectContaining({
          source: "runtime",
          source_id: "runtime",
          tool_name: "bash",
          request_digest: input.requestDigest,
          state: "in_progress",
          tool_effect_state: "none",
          runtime_call_stopped: false,
          started_at: eventAt,
        }),
      ]);
      await expectSequence(sessionId, 2);
    });

    it("confirms one committed Tool finish without rewriting effect or stopping evidence", async () => {
      const { sessionId, runId } = await accept();
      const start = startInput(runId);
      await events.startToolAttempt(start);
      const input = finishInput(start);
      const original = await events.finishToolAttempt(input);
      const before = await stored(sessionId);
      await expect(events.finishToolAttempt(input)).resolves.toEqual(original);
      expect(await stored(sessionId)).toEqual(before);
      expect(await attempt(runId)).toEqual([
        expect.objectContaining({
          source: "runtime",
          source_id: "runtime",
          request_digest: start.requestDigest,
          state: "completed",
          tool_effect_state: "settled",
          runtime_call_stopped: true,
          result_summary: input.resultSummary,
          started_at: eventAt,
          finished_at: finishedAt,
        }),
      ]);
      expect(original).toMatchObject({
        rawOutput: input.rawOutput,
        file: input.file,
      });
      await expectSequence(sessionId, 3);
    });

    it("returns committed progress after its Tool attempt has finished", async () => {
      const { sessionId, runId } = await accept();
      const start = startInput(runId);
      await events.startToolAttempt(start);
      const input = {
        id: randomUUID(),
        runId,
        toolCallId: start.toolCallId,
        content: text("halfway through the report"),
        createdAt: new Date("2026-09-14T00:00:02.500Z"),
      };
      const original = await events.appendToolProgress(input);
      await events.finishToolAttempt(finishInput(start));
      const before = await stored(sessionId);
      await expect(events.appendToolProgress(input)).resolves.toEqual(original);
      expect(await stored(sessionId)).toEqual(before);
      await expectSequence(sessionId, 4);
    });

    function planInput(
      runId: string,
    ): Parameters<RunEventRepository["appendPlan"]>[0] {
      return {
        id: randomUUID(),
        runId,
        createdAt: eventAt,
        events: [
          {
            kind: "plan",
            entries: [
              { content: "Write report", priority: "high", status: "pending" },
            ],
          },
          {
            kind: "tool_call",
            initial: true,
            toolCallId: "plan-call",
            title: "Update plan",
            toolKind: "other",
            modelName: "update_plan",
            arguments: { task: "Write report" },
            status: "completed",
            content: text("Plan updated."),
          },
        ],
      };
    }

    it("confirms both committed plan events without consuming two more sequences", async () => {
      const { sessionId, runId } = await accept();
      const input = planInput(runId);
      expect(await events.appendPlan(input)).toBe(true);
      const before = await stored(sessionId);
      await expect(events.appendPlan(input)).resolves.toBe(true);
      expect(await stored(sessionId)).toEqual(before);
      await expectSequence(sessionId, 3);
      expect(
        (
          await pool.query(
            "SELECT kind, created_at FROM session_messages WHERE session_id = $1 AND sequence > 1 ORDER BY sequence",
            [sessionId],
          )
        ).rows,
      ).toEqual([
        { kind: "plan", created_at: eventAt },
        { kind: "tool_call", created_at: eventAt },
      ]);
    });

    it.each(["digest", "source", "source_id"] as const)(
      "rejects a changed Tool start %s even when the public event payload matches",
      async (field) => {
        const { sessionId, runId } = await accept();
        const input = startInput(runId);
        await events.startToolAttempt(input);
        const before = await stored(sessionId);
        const changed = structuredClone(input);
        if (field === "digest") changed.requestDigest = "b".repeat(64);
        else if (field === "source") changed.tool.source = "client";
        else changed.tool.sourceId = "another-runtime";
        await expect(events.startToolAttempt(changed)).rejects.toThrow();
        expect(await stored(sessionId)).toEqual(before);
      },
    );

    it.each(["effect", "stopped", "summary"] as const)(
      "rejects a changed Tool finish %s without rewriting its committed receipt",
      async (field) => {
        const { sessionId, runId } = await accept();
        const start = startInput(runId);
        await events.startToolAttempt(start);
        const input = finishInput(start);
        await events.finishToolAttempt(input);
        const before = await stored(sessionId);
        const changed = structuredClone(input);
        if (field === "effect") changed.toolEffectState = "unknown";
        else if (field === "stopped") changed.runtimeCallStopped = false;
        else changed.resultSummary = text("different summary");
        await expect(events.finishToolAttempt(changed)).rejects.toThrow();
        expect(await stored(sessionId)).toEqual(before);
      },
    );

    it("rejects a changed plan payload without changing either stored event", async () => {
      const { sessionId, runId } = await accept();
      const input = planInput(runId);
      await events.appendPlan(input);
      const before = await stored(sessionId);
      const changed = structuredClone(input);
      changed.events[0].entries[0]!.content = "Different plan";
      await expect(events.appendPlan(changed)).rejects.toThrow();
      expect(await stored(sessionId)).toEqual(before);
    });

    it.each(["tool_finished", "run_terminal"] as const)(
      "confirms the original Tool start after %s while rejecting a new receipt ID",
      async (stage) => {
        const { sessionId, runId } = await accept();
        const input = startInput(runId);
        const original = await events.startToolAttempt(input);
        await events.finishToolAttempt(finishInput(input));
        if (stage === "run_terminal")
          await executions.finish({
            runId,
            terminalClass: "completed",
            executorState: "quiescent",
            toolEffectState: "settled",
            stopReason: "end_turn",
            finishedAt: new Date("2026-09-14T00:00:04Z"),
          });
        const before = await stored(sessionId);
        await expect(events.startToolAttempt(input)).resolves.toEqual(original);
        expect(await stored(sessionId)).toEqual(before);
        await expect(
          events.startToolAttempt({
            ...input,
            id: randomUUID(),
            toolCallId:
              stage === "run_terminal" ? randomUUID() : input.toolCallId,
          }),
        ).rejects.toThrow();
        expect(await stored(sessionId)).toEqual(before);
        await expectSequence(sessionId, 3);
      },
    );

    it.each(["cancel_requested", "run_terminal"] as const)(
      "confirms a committed plan as true after %s without appending again",
      async (stage) => {
        const { sessionId, runId } = await accept();
        const input = planInput(runId);
        expect(await events.appendPlan(input)).toBe(true);
        await runs.requestCancellation(runId, finishedAt);
        if (stage === "run_terminal")
          await executions.finish({
            runId,
            terminalClass: "cancelled",
            executorState: "quiescent",
            toolEffectState: "none",
            finishedAt: new Date("2026-09-14T00:00:04Z"),
          });
        const before = await stored(sessionId);
        await expect(events.appendPlan(input)).resolves.toBe(true);
        expect(await stored(sessionId)).toEqual(before);
        await expectSequence(sessionId, 3);
      },
    );

    it.each(simpleKinds)(
      "rejects a changed %s timestamp for the same receipt ID",
      async (kind) => {
        const { sessionId, runId } = await accept();
        const input = simpleInput(runId);
        await writeSimple(events, kind, input);
        const before = await stored(sessionId);
        await expect(
          writeSimple(events, kind, {
            ...input,
            createdAt: new Date(input.createdAt.getTime() + 1),
          }),
        ).rejects.toThrow();
        expect(await stored(sessionId)).toEqual(before);
        await expectSequence(sessionId, 2);
      },
    );

    it("retains the original load_skill finish identity after real cleanup advances stopping evidence", async () => {
      const {
        sessionId,
        runId,
        snapshot: frozen,
      } = await accept(`rtv_${"a".repeat(32)}`);
      const signal = new AbortController().signal;
      const scope = await temporarySkills.reserve({
        runId,
        snapshot: frozen,
        signal,
      });
      const start = startInput(runId);
      start.tool = {
        source: "agent",
        sourceId: "skill_registry",
        name: "load_skill",
        modelName: "load_skill",
        description: "Load a temporary Skill",
      };
      await events.startToolAttempt(start);
      const input = { ...finishInput(start), runtimeCallStopped: false };
      const original = await events.finishToolAttempt(input);
      expect(await attempt(runId)).toEqual([
        expect.objectContaining({
          state: "completed",
          source: "agent",
          source_id: "skill_registry",
          tool_name: "load_skill",
          tool_effect_state: "settled",
          runtime_call_stopped: false,
        }),
      ]);
      await temporarySkills.released(scope);
      expect(await temporarySkills.forRun(runId, signal)).toBeNull();
      expect(await attempt(runId)).toEqual([
        expect.objectContaining({ runtime_call_stopped: true }),
      ]);
      const before = await stored(sessionId);
      const releasedBefore = (
        await pool.query(
          "SELECT to_jsonb(temporary_skill_scopes) AS record FROM temporary_skill_scopes WHERE run_id = $1",
          [runId],
        )
      ).rows;
      await expect(events.finishToolAttempt(input)).resolves.toEqual(original);
      expect(await stored(sessionId)).toEqual(before);
      await expect(
        events.finishToolAttempt({ ...input, runtimeCallStopped: true }),
      ).rejects.toThrow();
      expect(await stored(sessionId)).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(temporary_skill_scopes) AS record FROM temporary_skill_scopes WHERE run_id = $1",
            [runId],
          )
        ).rows,
      ).toEqual(releasedBefore);
      await expectSequence(sessionId, 3);
    });

    it("commits one message for concurrent identical requests and joins both callers", async () => {
      const { sessionId, runId } = await accept();
      const input = simpleInput(runId);
      const results = await Promise.allSettled([
        events.appendAgentMessage(input),
        events.appendAgentMessage(input),
      ]);
      expect(results.map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      const [first, second] = results;
      if (first.status !== "fulfilled" || second.status !== "fulfilled")
        throw new Error(
          "Concurrent message callers did not both confirm the receipt",
        );
      expect(second.value).toEqual(first.value);
      expect(first.value).toMatchObject({
        kind: "agent_message",
        messageId: input.id,
        content: input.content,
      });
      await expectSequence(sessionId, 2);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS total FROM session_messages WHERE id = $1",
            [input.id],
          )
        ).rows,
      ).toEqual([{ total: 1 }]);
    });

    it("replays encoded Tool arguments and results containing NUL and a lone surrogate", async () => {
      const { sessionId, runId } = await accept();
      const unusual = "NUL \u0000 and lone surrogate \ud800";
      const start = startInput(runId);
      start.arguments = { command: unusual };
      const originalStart = await events.startToolAttempt(start);
      const input = finishInput(start);
      input.rawOutput = { result: unusual };
      input.file = {
        path: "/workspace/report.txt",
        change: { before: null, after: unusual },
      };
      const originalFinish = await events.finishToolAttempt(input);
      const before = await stored(sessionId);
      await expect(events.startToolAttempt(start)).resolves.toEqual(
        originalStart,
      );
      await expect(events.finishToolAttempt(input)).resolves.toEqual(
        originalFinish,
      );
      expect(originalStart).toMatchObject({ arguments: { command: unusual } });
      expect(originalFinish).toMatchObject({
        rawOutput: input.rawOutput,
        file: input.file,
      });
      expect(await stored(sessionId)).toEqual(before);
      await expectSequence(sessionId, 3);
    });

    it.each(["plan", "tool_call"] as const)(
      "rejects an incomplete plan receipt missing %s without repairing history",
      async (missingKind) => {
        const { sessionId, runId } = await accept();
        const input = planInput(runId);
        expect(await events.appendPlan(input)).toBe(true);
        await expectSequence(sessionId, 3);
        // Both events normally commit together. Deliberately remove one to
        // exercise fail-closed handling of an incomplete historical receipt.
        const removed = await pool.query(
          "DELETE FROM session_messages WHERE run_id = $1 AND kind = $2 RETURNING id",
          [runId, missingKind],
        );
        expect(removed.rowCount).toBe(1);
        const before = await stored(sessionId);
        expect(before.messages).toHaveLength(2);

        await expect(events.appendPlan(input)).rejects.toThrow(
          "Plan receipt is incomplete",
        );
        expect(await stored(sessionId)).toEqual(before);
      },
    );

    it.each([false, true])(
      "rejects an unknown historical finish receipt when current stopped is %s without backfilling it",
      async (runtimeCallStopped) => {
        const { sessionId, runId } = await accept();
        const start = startInput(runId);
        await events.startToolAttempt(start);
        const input = { ...finishInput(start), runtimeCallStopped };
        await events.finishToolAttempt(input);
        // Migration leaves the original finish input unknown for historical rows.
        const historical = await pool.query(
          `UPDATE tool_attempts SET finish_runtime_call_stopped = NULL
           WHERE run_id = $1 AND tool_call_id = $2
           RETURNING finish_runtime_call_stopped, runtime_call_stopped`,
          [runId, start.toolCallId],
        );
        expect(historical.rows).toEqual([
          {
            finish_runtime_call_stopped: null,
            runtime_call_stopped: runtimeCallStopped,
          },
        ]);
        const before = await stored(sessionId);

        await expect(events.finishToolAttempt(input)).rejects.toThrow(
          "Tool finish receipt identity conflict",
        );
        expect(await stored(sessionId)).toEqual(before);
        await expectSequence(sessionId, 3);
      },
    );

    it("returns an earlier usage receipt after a later measurement without changing the accumulated cost or sequence", async () => {
      const { sessionId, runId } = await accept();
      const first = simpleInput(runId);
      const second = {
        ...simpleInput(runId),
        createdAt: finishedAt,
        usage: {
          inputTokens: 200,
          outputTokens: 20,
          cost: {
            amount: 0.04,
            currency: "USD" as const,
            source: "provider_reported" as const,
          },
        },
      };
      const originalFirst = await events.appendUsage(first);
      const originalSecond = await events.appendUsage(second);
      expect(originalFirst).toMatchObject({
        kind: "usage",
        measurement: first.usage,
        cost: { amount: 0.03, currency: "USD" },
      });
      expect(originalSecond).toMatchObject({
        kind: "usage",
        measurement: second.usage,
        cost: { currency: "USD" },
      });
      if (originalSecond.kind !== "usage")
        throw new Error("Expected usage receipt");
      expect(originalSecond.cost?.amount).toBeCloseTo(0.07, 12);
      const before = await stored(sessionId);
      const reopened = new PostgresRunEventRepository(kernel);

      await expect(reopened.appendUsage(first)).resolves.toEqual(originalFirst);
      expect(await stored(sessionId)).toEqual(before);
      await expectSequence(sessionId, 3);
    });
  },
);
