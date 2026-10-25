import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresExecutionAudits } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-audit.js";
import { createOwnedRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { RunWriteAuthority } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-write-authority.js";
import { PostgresSessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { deriveResourceId } from "../../../../../services/agent-acp-service/src/domain/resource-id.js";
import type { ModelUsage } from "../../../../../services/agent-acp-service/src/domain/usage.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import {
  type FencingFixture,
  scope,
  withDatabase,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const attemptTime = Date.parse("2026-10-25T01:00:00.000Z");
const failedUsage: ModelUsage = {
  inputTokens: 40,
  outputTokens: 0,
  cost: { amount: 0.002, currency: "USD", source: "provider_reported" },
};
const completedUsage: ModelUsage = {
  inputTokens: 60,
  outputTokens: 4,
  cost: { amount: 0.003, currency: "USD", source: "provider_reported" },
};

function start(runId: string, ordinal: number) {
  const model = executionConfiguration().models[0]!;
  return {
    runId,
    ordinal,
    modelProfileId: model.model_profile_id,
    providerConnectionId: model.connection_id,
    model: model.model,
    purpose: "foreground" as const,
    startedAt: new Date(attemptTime + ordinal * 1000),
  };
}

function finish(runId: string, ordinal: number, usage = failedUsage) {
  return {
    runId,
    ordinal,
    outcome: "failed" as const,
    reason: "rate_limited",
    durationMs: 125,
    outputStarted: false,
    usage,
    status: 429,
    finishedAt: new Date(attemptTime + ordinal * 1000 + 125),
    contextSize: 64_000,
  };
}

async function accept(
  fixture: FencingFixture,
  maximum?: number,
  failover?: "never" | "before_output",
) {
  const session = await fixture.session(scope("model-attempt-agent"));
  const owner = await fixture.owner(session.binding);
  const repositories = createOwnedRunRepositories(
    fixture.kernelA,
    owner.authority,
  );
  const input = fixture.input(session);
  await repositories.runs.createRunIntent(input);
  const acceptance = fixture.acceptance(session, input.runId);
  if (maximum !== undefined)
    acceptance.snapshot.executionSpec.maxModelRequests = maximum;
  const fallback = {
    modelProfileId: "fallback-profile",
    providerConnectionId: "fallback-provider",
    model: {
      ...acceptance.snapshot.executionSpec.model,
      baseUrl: "https://fallback.example.test/v1",
      model: "fallback-model",
      contextWindow: 32_000,
      maxOutputTokens: 1024,
      pricing: {
        currency: "USD" as const,
        inputPerMillion: 3,
        outputPerMillion: 4,
      },
    },
  };
  if (failover !== undefined) {
    acceptance.snapshot.executionSpec.modelFailover = failover;
    acceptance.snapshot.executionSpec.fallbackModels = [fallback];
  }
  expect(await repositories.runs.acceptRun(acceptance)).toBe("accepted");
  return { ...repositories, session, owner, runId: input.runId, fallback };
}

type MessageRow = {
  id: string;
  sequence: string;
  kind: string;
  visible: boolean;
  context_excluded: boolean;
  payload: Record<string, unknown>;
};

async function messages(fixture: FencingFixture, sessionId: string) {
  return (
    await fixture.observer.query<MessageRow>(
      `SELECT m.id, m.sequence::text, m.kind, m.visible,
              m.context_excluded, m.payload
         FROM session_messages m WHERE m.session_id=$1
         ORDER BY m.sequence`,
      [sessionId],
    )
  ).rows;
}

describe.skipIf(databaseUrl === undefined)(
  "owned model attempt facts in PostgreSQL",
  () => {
    it("keeps hidden attempt starts from changing public Session metadata", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture);
        const metadata = async () =>
          (
            await fixture.observer.query<{
              updated_at: Date;
              last_message_sequence: string;
            }>(
              "SELECT updated_at,last_message_sequence::text FROM acp_sessions WHERE id=$1",
              [run.session.sessionId],
            )
          ).rows[0]!;
        const before = await metadata();
        await run.events.startModelAttempt(start(run.runId, 1));
        const after = await metadata();
        expect(after.updated_at).toEqual(before.updated_at);
        expect(BigInt(after.last_message_sequence)).toBe(
          BigInt(before.last_message_sequence) + 1n,
        );
        expect(
          (await messages(fixture, run.session.sessionId)).at(-1),
        ).toMatchObject({
          kind: "model_attempt",
          visible: false,
          context_excluded: true,
        });
      });
    });

    it("allows frozen fallback identity and atomically records its own context and usage", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture, 5, "before_output");
        await run.events.startModelAttempt(start(run.runId, 1));
        await run.events.finishModelAttempt(finish(run.runId, 1));
        const second = {
          ...start(run.runId, 2),
          modelProfileId: run.fallback.modelProfileId,
          providerConnectionId: run.fallback.providerConnectionId,
          model: run.fallback.model.model,
        };
        const before = await fixture.snapshot();
        for (const changed of [
          { modelProfileId: "unknown-fallback" },
          { providerConnectionId: start(run.runId, 1).providerConnectionId },
          { model: "unfrozen-fallback-model" },
        ]) {
          await expect(
            run.events.startModelAttempt({ ...second, ...changed }),
          ).rejects.toThrow();
          expect(await fixture.snapshot()).toBe(before);
        }
        await run.events.startModelAttempt(second);
        const pending = await fixture.snapshot();
        await expect(
          run.events.finishModelAttempt(finish(run.runId, 2, completedUsage)),
        ).rejects.toThrow();
        expect(await fixture.snapshot()).toBe(pending);
        const completed = {
          ...finish(run.runId, 2, completedUsage),
          contextSize: 32_000,
          outcome: "completed" as const,
          reason: "completed",
          status: 200,
        };
        const receipt = await run.events.finishModelAttempt(completed);
        expect(receipt.event).toMatchObject({
          kind: "usage",
          size: 32_000,
          measurement: completedUsage,
          cost: { amount: 0.005, currency: "USD" },
        });
        expect(await run.events.finishModelAttempt(completed)).toEqual(receipt);
        const rows = await messages(fixture, run.session.sessionId);
        const audits = rows.filter((row) => row.kind === "model_attempt");
        expect(audits).toHaveLength(4);
        expect(audits[2]?.payload).toMatchObject({
          phase: "start",
          ordinal: 2,
          modelProfileId: second.modelProfileId,
          providerConnectionId: second.providerConnectionId,
          model: second.model,
        });
        expect(audits[3]?.payload).toMatchObject({
          phase: "finish",
          contextSize: 32_000,
        });
        expect(
          audits.every((row) => !row.visible && row.context_excluded),
        ).toBe(true);
        expect(rows.filter((row) => row.kind === "usage")).toHaveLength(2);
      });
    });

    it("rejects a configured fallback when the frozen policy is never", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture, 5, "never");
        const before = await fixture.snapshot();
        await expect(
          run.events.startModelAttempt({
            ...start(run.runId, 1),
            modelProfileId: run.fallback.modelProfileId,
            providerConnectionId: run.fallback.providerConnectionId,
            model: run.fallback.model.model,
          }),
        ).rejects.toThrow();
        expect(await fixture.snapshot()).toBe(before);
      });
    });

    it("keeps attempt ordinals above the PostgreSQL int32 boundary exact", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture, Number.MAX_SAFE_INTEGER);
        await run.events.startModelAttempt(start(run.runId, 1));
        await run.events.finishModelAttempt(finish(run.runId, 1));
        const previous = 2_147_483_648;
        // Seed a high-water mark instead of making billions of provider calls.
        // The actual repository must still require the exact predecessor receipt.
        for (const phase of ["start", "finish"] as const) {
          await fixture.observer.query(
            `UPDATE session_messages
                SET id=$1, payload=jsonb_set(payload,'{ordinal}',$2::jsonb)
              WHERE run_id=$3 AND kind='model_attempt' AND payload->>'phase'=$4`,
            [
              deriveResourceId(
                "message",
                "model-attempt",
                `${run.runId}:${previous}:${phase}`,
              ),
              JSON.stringify(previous),
              run.runId,
              phase,
            ],
          );
        }
        const next = start(run.runId, previous + 1);
        await expect(
          run.events.startModelAttempt(next),
        ).resolves.toBeUndefined();
        const rows = await messages(fixture, run.session.sessionId);
        expect(
          rows
            .filter((row) => row.kind === "model_attempt")
            .map((row) => row.payload.ordinal),
        ).toEqual([previous, previous, previous + 1]);
      });
    });

    it("admits only the frozen model and the next attempt after its predecessor finishes", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture);
        const before = await fixture.snapshot();
        for (const changed of [
          { modelProfileId: "newer-profile" },
          { providerConnectionId: "other-provider" },
          { model: "newer-model" },
          { ordinal: 2 },
        ]) {
          await expect(
            run.events.startModelAttempt({
              ...start(run.runId, 1),
              ...changed,
            }),
          ).rejects.toThrow();
          expect(await fixture.snapshot()).toBe(before);
        }
        await run.events.startModelAttempt(start(run.runId, 1));
        const started = await fixture.snapshot();
        await expect(
          run.events.startModelAttempt(start(run.runId, 2)),
        ).rejects.toThrow();
        expect(await fixture.snapshot()).toBe(started);
        await run.events.finishModelAttempt(finish(run.runId, 1));
        await expect(
          run.events.startModelAttempt(start(run.runId, 2)),
        ).resolves.toBeUndefined();
      });
    });

    it("persists failed and successful attempts with per-call usage, excluding their audit facts from replay, context and forks", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture);
        const originalContext = await run.contexts.load(run.session.sessionId);
        const first = start(run.runId, 1);
        const second = start(run.runId, 2);
        const failed = finish(run.runId, 1);
        const completed = {
          ...finish(run.runId, 2, completedUsage),
          outcome: "completed" as const,
          reason: "completed",
          outputStarted: true,
          status: 200,
        };
        await run.events.startModelAttempt(first);
        const { event: failedReceipt } =
          await run.events.finishModelAttempt(failed);
        await run.events.startModelAttempt(second);
        const { event: completedReceipt } =
          await run.events.finishModelAttempt(completed);

        expect(failedReceipt).toMatchObject({
          kind: "usage",
          measurement: failedUsage,
          cost: { amount: 0.002, currency: "USD" },
        });
        expect(completedReceipt).toMatchObject({
          kind: "usage",
          measurement: completedUsage,
          cost: { amount: 0.005, currency: "USD" },
        });
        const rows = await messages(fixture, run.session.sessionId);
        const attempts = rows.filter((row) => row.kind === "model_attempt");
        expect(attempts).toHaveLength(4);
        expect(new Set(attempts.map((row) => row.id)).size).toBe(4);
        expect(
          attempts.map((row) => [row.payload.ordinal, row.payload.phase]),
        ).toEqual([
          [1, "start"],
          [1, "finish"],
          [2, "start"],
          [2, "finish"],
        ]);
        for (const row of attempts) {
          expect(row.visible).toBe(false);
          expect(row.context_excluded).toBe(true);
        }
        for (const [index, input] of [first, second].entries())
          expect(attempts[index * 2]?.payload).toMatchObject({
            phase: "start",
            ordinal: input.ordinal,
            modelProfileId: input.modelProfileId,
            providerConnectionId: input.providerConnectionId,
            model: input.model,
            purpose: input.purpose,
            startedAt: input.startedAt.toISOString(),
          });
        for (const [index, input] of [failed, completed].entries())
          expect(attempts[index * 2 + 1]?.payload).toMatchObject({
            phase: "finish",
            ordinal: input.ordinal,
            outcome: input.outcome,
            reason: input.reason,
            durationMs: input.durationMs,
            outputStarted: input.outputStarted,
            usage: input.usage,
            status: input.status,
            finishedAt: input.finishedAt.toISOString(),
            contextSize: input.contextSize,
          });
        expect(
          rows.filter((row) => row.kind === "usage").map((row) => row.payload),
        ).toEqual([failedReceipt, completedReceipt]);

        const audits = new PostgresExecutionAudits(fixture.kernelA);
        const auditEvents = await audits.events(
          {
            organizationId: run.session.binding.organizationId,
            runId: run.runId,
            limit: 100,
          },
          new AbortController().signal,
        );
        expect(
          auditEvents
            ?.filter((event) => event.kind === "model_attempt")
            .map((event) => event.payload),
        ).toEqual(attempts.map((row) => row.payload));
        expect(
          await audits.get(
            run.session.binding.organizationId,
            run.runId,
            new AbortController().signal,
          ),
        ).toMatchObject({ usage_measurements: [failedUsage, completedUsage] });

        const sessions = new PostgresSessionRepository(
          fixture.kernelA,
          fixture.secretBox,
          RunWriteAuthority.owned(run.owner.authority),
        );
        const replay = await sessions.replay(run.session.sessionId);
        expect(replay.filter((event) => event.kind === "usage")).toEqual([
          failedReceipt,
          completedReceipt,
        ]);
        expect(JSON.stringify(replay)).not.toContain("model_attempt");
        expect(await run.contexts.load(run.session.sessionId)).toEqual(
          originalContext,
        );

        await run.executions.finish({
          runId: run.runId,
          terminalClass: "completed",
          executorState: "quiescent",
          toolEffectState: "none",
          stopReason: "end_turn",
          finishedAt: new Date(attemptTime + 4000),
        });
        const forkId = randomUUID();
        await sessions.fork({
          sourceSessionId: run.session.sessionId,
          sessionId: forkId,
          mcpRevisionId: randomUUID(),
          mcpSources: [],
          createdAt: new Date(attemptTime + 5000),
        });
        expect(
          (await messages(fixture, forkId)).filter(
            (row) => row.kind === "model_attempt",
          ),
        ).toEqual([]);
        expect(await run.contexts.load(forkId)).toEqual(originalContext);
        expect(JSON.stringify(await sessions.replay(forkId))).not.toContain(
          "model_attempt",
        );
        expect(
          (await messages(fixture, run.session.sessionId)).filter(
            (row) => row.kind === "model_attempt",
          ),
        ).toEqual(attempts);
      });
    });

    it("replays exact start and finish tuples after later usage without another charge or sequence", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture);
        const input = start(run.runId, 1);
        const result = finish(run.runId, 1);
        await run.events.startModelAttempt(input);
        const original = await run.events.finishModelAttempt(result);
        await run.events.startModelAttempt(start(run.runId, 2));
        await run.events.finishModelAttempt(
          finish(run.runId, 2, completedUsage),
        );
        const before = await fixture.snapshot();
        const reopened = createOwnedRunRepositories(
          fixture.kernelB,
          run.owner.authority,
        ).events;
        const starts = await Promise.allSettled([
          reopened.startModelAttempt(structuredClone(input)),
          run.events.startModelAttempt(structuredClone(input)),
        ]);
        for (const repeated of starts)
          expect(repeated.status).toBe("fulfilled");
        const finishes = await Promise.allSettled([
          reopened.finishModelAttempt(structuredClone(result)),
          run.events.finishModelAttempt(structuredClone(result)),
        ]);
        for (const repeated of finishes)
          expect(repeated).toEqual({ status: "fulfilled", value: original });
        expect(await fixture.snapshot()).toBe(before);
        expect(
          (await messages(fixture, run.session.sessionId)).filter(
            (row) => row.kind === "usage",
          ),
        ).toHaveLength(2);
      });
    });

    it("rejects missing starts and conflicting immutable start or finish facts without writes", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture);
        const absent = await fixture.snapshot();
        await expect(
          run.events.finishModelAttempt(finish(run.runId, 1)),
        ).rejects.toThrow();
        expect(await fixture.snapshot()).toBe(absent);
        const input = start(run.runId, 1);
        await run.events.startModelAttempt(input);
        const started = await fixture.snapshot();
        for (const changed of [
          { modelProfileId: "other-model-profile" },
          { providerConnectionId: "other-provider" },
          { model: "other-model" },
          { purpose: "permission_judge" as const },
          { startedAt: new Date(input.startedAt.getTime() + 1) },
        ]) {
          await expect(
            run.events.startModelAttempt({ ...input, ...changed }),
          ).rejects.toThrow();
          expect(await fixture.snapshot()).toBe(started);
        }
        const result = finish(run.runId, 1);
        await run.events.finishModelAttempt(result);
        const finished = await fixture.snapshot();
        for (const changed of [
          { outcome: "cancelled" as const },
          { reason: "other-reason" },
          { durationMs: result.durationMs + 1 },
          { outputStarted: true },
          { usage: { ...failedUsage, inputTokens: 41 } },
          { status: 503 },
          { finishedAt: new Date(result.finishedAt.getTime() + 1) },
          { contextSize: result.contextSize + 1 },
        ]) {
          await expect(
            run.events.finishModelAttempt({ ...result, ...changed }),
          ).rejects.toThrow();
          expect(await fixture.snapshot()).toBe(finished);
        }
      });
    });

    it("rolls back both the finish fact and usage when either real insert fails", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture);
        await run.events.startModelAttempt(start(run.runId, 1));
        const before = await fixture.snapshot();
        // Exercise either insertion order without replacing the repository or
        // its transaction: PostgreSQL rejects the actual finish/usage INSERT.
        for (const condition of [
          "NEW.kind = 'usage'",
          "NEW.kind = 'model_attempt' AND NEW.payload->>'phase' = 'finish'",
        ]) {
          await fixture.observer.query(`
            CREATE FUNCTION reject_model_attempt_write() RETURNS trigger
            LANGUAGE plpgsql AS $body$
            BEGIN
              IF ${condition} THEN
                RAISE EXCEPTION 'model attempt atomic rollback sentinel';
              END IF;
              RETURN NEW;
            END;
            $body$`);
          try {
            await fixture.observer.query(`
              CREATE TRIGGER reject_model_attempt_write
              BEFORE INSERT ON session_messages FOR EACH ROW
              EXECUTE FUNCTION reject_model_attempt_write()`);
            await expect(
              run.events.finishModelAttempt(finish(run.runId, 1)),
            ).rejects.toThrow("model attempt atomic rollback sentinel");
            expect(await fixture.snapshot()).toBe(before);
          } finally {
            await fixture.observer.query(
              "DROP TRIGGER IF EXISTS reject_model_attempt_write ON session_messages",
            );
            await fixture.observer.query(
              "DROP FUNCTION reject_model_attempt_write()",
            );
          }
        }
        await run.events.finishModelAttempt(finish(run.runId, 1));
        const rows = await messages(fixture, run.session.sessionId);
        expect(rows.filter((row) => row.kind === "model_attempt")).toHaveLength(
          2,
        );
        expect(rows.filter((row) => row.kind === "usage")).toHaveLength(1);
      });
    });

    it("retains unknown usage separately from a known zero-cost permission-judge attempt", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture);
        await run.events.startModelAttempt(start(run.runId, 1));
        const unknown = await run.events.finishModelAttempt(
          finish(run.runId, 1, {}),
        );
        const knownZero: ModelUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cost: { amount: 0, currency: "USD", source: "provider_reported" },
        };
        await run.events.startModelAttempt({
          ...start(run.runId, 2),
          purpose: "permission_judge",
        });
        const zero = await run.events.finishModelAttempt({
          ...finish(run.runId, 2, knownZero),
          outcome: "completed",
          reason: "completed",
          status: 200,
        });
        expect(unknown.event).toEqual({
          kind: "usage",
          used: 0,
          size: 64_000,
          measurement: {},
        });
        expect(zero.event).toEqual({
          kind: "usage",
          used: 0,
          size: 64_000,
          measurement: knownZero,
          cost: { amount: 0, currency: "USD" },
        });
        const rows = await messages(fixture, run.session.sessionId);
        expect(
          rows
            .filter(
              (row) =>
                row.kind === "model_attempt" && row.payload.phase === "finish",
            )
            .map((row) => row.payload.usage),
        ).toEqual([{}, knownZero]);
        expect(
          rows.find(
            (row) =>
              row.kind === "model_attempt" &&
              row.payload.phase === "start" &&
              row.payload.ordinal === 2,
          )?.payload.purpose,
        ).toBe("permission_judge");
      });
    });

    it("rejects new writes and exact receipts after the original Run fence expires", async () => {
      await withDatabase(async (fixture) => {
        const run = await accept(fixture);
        const first = start(run.runId, 1);
        const completed = finish(run.runId, 1);
        await run.events.startModelAttempt(first);
        await run.events.finishModelAttempt(completed);
        await run.events.startModelAttempt(start(run.runId, 2));
        await fixture.observer.query(
          `UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second'
           WHERE organization_id=$1 AND agent_id=$2`,
          [run.session.binding.organizationId, run.session.binding.agentId],
        );
        for (const operation of [
          () => run.events.startModelAttempt(first),
          () => run.events.finishModelAttempt(completed),
          () => run.events.startModelAttempt(start(run.runId, 3)),
          () => run.events.finishModelAttempt(finish(run.runId, 2)),
        ])
          await fixture.denied(operation);
      });
    });
  },
);
