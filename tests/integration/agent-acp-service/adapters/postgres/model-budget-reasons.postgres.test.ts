import { describe, expect, it } from "vitest";
import { PostgresExecutionAudits } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-audit.js";
import { createOwnedRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { publicExecutionConfiguration } from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import type { OrganizationBudget } from "../../../../../services/agent-acp-service/src/domain/model-budget.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import {
  type FencingFixture,
  duration,
  scope,
  withDatabase,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const organizationId = "organization-1";
const budget = { scope: "run_cost" as const, limit: "10", used: "11" };

async function configure(
  db: FencingFixture,
  overrides: Partial<OrganizationBudget> = {},
): Promise<void> {
  const configuration = {
    ...publicExecutionConfiguration(executionConfiguration()),
    organization_budget: {
      revision: 1,
      unknown_cost: "allow",
      run_caps: {},
      daily: {},
      monthly: {},
      ...overrides,
    },
  };
  await db.observer.query(
    "INSERT INTO execution_configurations(organization_id,revision,configuration) VALUES($1,$2,$3::jsonb)",
    [organizationId, configuration.revision, JSON.stringify(configuration)],
  );
}

async function intent(db: FencingFixture, accepted = true) {
  const session = await db.session(
    scope("budget-reasons-agent", organizationId),
  );
  const owner = await db.owner(session.binding);
  const repositories = createOwnedRunRepositories(db.kernelA, owner.authority);
  const input = db.input(session);
  await repositories.runs.createRunIntent(input);
  const acceptance = db.acceptance(session, input.runId);
  if (accepted)
    expect(await repositories.runs.acceptRun(acceptance)).toBe("accepted");
  return { session, owner, repositories, input, acceptance };
}

async function readRun(db: FencingFixture, runId: string) {
  return (
    await db.observer.query<{
      state: string;
      error_class: string | null;
      budget_reason: unknown;
    }>("SELECT state,error_class,budget_reason FROM runs WHERE id=$1", [runId])
  ).rows;
}

function audit(db: FencingFixture, runId: string) {
  return new PostgresExecutionAudits(db.kernelB).get(
    organizationId,
    runId,
    new AbortController().signal,
  );
}

describe.skipIf(databaseUrl === undefined)(
  "durable model budget reasons in PostgreSQL",
  () => {
    it.each(["daily", "monthly"] as const)(
      "commits the original %s admission reason without a Prompt or model reservation",
      async (period) => {
        await withDatabase(async (db) => {
          await configure(db, {
            [period]: { hard_cost_usd_micros: 10 },
          });
          await db.observer.query(
            `INSERT INTO organization_spend(organization_id,period,period_start,cost_usd_micros)
             SELECT $1,$2,CASE $2 WHEN 'daily' THEN moment::date ELSE date_trunc('month',moment)::date END,10
             FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS moment) captured`,
            [organizationId, period],
          );
          const run = await intent(db, false);
          const reason = {
            scope: "organization_" + period,
            limit: "10",
            used: "10",
          };
          await expect(
            run.repositories.runs.acceptRun(run.acceptance),
          ).rejects.toMatchObject({ code: "budget_exceeded", ...reason });
          expect(await readRun(db, run.input.runId)).toEqual([
            {
              state: "failed",
              error_class: "budget_exceeded",
              budget_reason: reason,
            },
          ]);
          expect(
            (
              await db.observer.query(
                `SELECT pending_user_message_id,execution_snapshot,
                   (SELECT count(*)::int FROM session_messages WHERE run_id=r.id) AS messages,
                   (SELECT count(*)::int FROM model_budget_reservations WHERE run_id=r.id) AS reservations
                 FROM runs r WHERE id=$1`,
                [run.input.runId],
              )
            ).rows,
          ).toEqual([
            {
              pending_user_message_id: null,
              execution_snapshot: null,
              messages: 0,
              reservations: 0,
            },
          ]);
          await expect(audit(db, run.input.runId)).resolves.toMatchObject({
            run_id: run.input.runId,
            state: "failed",
            error_class: "budget_exceeded",
            budget_reason: reason,
          });
        });
      },
      duration,
    );

    it.each(["failed", "unresolved"] as const)(
      "reads back the complete %s budget outcome and rejects changed or missing replay facts",
      async (terminalClass) => {
        await withDatabase(async (db) => {
          await configure(db);
          const run = await intent(db);
          const outcome =
            terminalClass === "failed"
              ? {
                  terminalClass,
                  executorState: "quiescent" as const,
                  toolEffectState: "none" as const,
                  errorClass: "budget_exceeded",
                }
              : {
                  terminalClass,
                  executorState: "quiescent" as const,
                  toolEffectState: "unknown" as const,
                  unknownEffectSource: "runtime_mcp" as const,
                  errorClass: "budget_exceeded",
                };
          const finishedAt = new Date();
          const finish = {
            runId: run.input.runId,
            ...outcome,
            budget: structuredClone(budget),
            finishedAt,
          };
          await run.repositories.executions.finish(finish);
          expect(await readRun(db, run.input.runId)).toEqual([
            {
              state: terminalClass,
              error_class: "budget_exceeded",
              budget_reason: budget,
            },
          ]);
          const fresh = createOwnedRunRepositories(
            db.kernelB,
            run.owner.authority,
          );
          await expect(
            fresh.executions.getRecoveryState(run.input.runId),
          ).resolves.toEqual({
            kind: "terminal",
            outcome: { ...outcome, budget },
          });
          await expect(audit(db, run.input.runId)).resolves.toMatchObject({
            run_id: run.input.runId,
            state: terminalClass,
            error_class: "budget_exceeded",
            budget_reason: budget,
          });
          const committed = await db.snapshot();
          await fresh.executions.finish(structuredClone(finish));
          expect(await db.snapshot()).toBe(committed);
          for (const changed of [
            { ...finish, budget: { ...budget, used: "12" } },
            { runId: run.input.runId, ...outcome, finishedAt },
          ]) {
            await expect(fresh.executions.finish(changed)).rejects.toThrow();
            expect(await db.snapshot()).toBe(committed);
          }
        });
      },
      duration,
    );

    it(
      "keeps legacy failed budget_exceeded outcomes without structured facts compatible",
      async () => {
        await withDatabase(async (db) => {
          await configure(db);
          const run = await intent(db);
          const outcome = {
            terminalClass: "failed" as const,
            executorState: "quiescent" as const,
            toolEffectState: "none" as const,
            errorClass: "budget_exceeded",
          };
          await run.repositories.executions.finish({
            runId: run.input.runId,
            ...outcome,
            finishedAt: new Date(),
          });
          expect(await readRun(db, run.input.runId)).toEqual([
            {
              state: "failed",
              error_class: "budget_exceeded",
              budget_reason: null,
            },
          ]);
          const fresh = createOwnedRunRepositories(
            db.kernelB,
            run.owner.authority,
          );
          await expect(
            fresh.executions.getRecoveryState(run.input.runId),
          ).resolves.toEqual({ kind: "terminal", outcome });
          const legacyAudit = await audit(db, run.input.runId);
          expect(legacyAudit).toMatchObject({ error_class: "budget_exceeded" });
          expect(legacyAudit).not.toHaveProperty("budget_reason");
        });
      },
      duration,
    );

    it(
      "rejects a non-budget terminal error carrying budget facts without writing",
      async () => {
        await withDatabase(async (db) => {
          await configure(db);
          const run = await intent(db);
          const before = await db.snapshot();
          const invalid = {
            runId: run.input.runId,
            terminalClass: "failed" as const,
            executorState: "quiescent" as const,
            toolEffectState: "none" as const,
            errorClass: "model_http_error",
            budget: structuredClone(budget),
            finishedAt: new Date(),
          };
          await expect(
            run.repositories.executions.finish(invalid),
          ).rejects.toThrow();
          expect(await db.snapshot()).toBe(before);
          expect(await readRun(db, run.input.runId)).toEqual([
            { state: "running", error_class: null, budget_reason: null },
          ]);
        });
      },
      duration,
    );

    it(
      "fences an original owner before a budget terminal write",
      async () => {
        await withDatabase(async (db) => {
          await configure(db);
          const run = await intent(db);
          await db.successor(run.owner);
          const before = await db.snapshot();
          const finish = {
            runId: run.input.runId,
            terminalClass: "failed" as const,
            executorState: "quiescent" as const,
            toolEffectState: "none" as const,
            errorClass: "budget_exceeded",
            budget: structuredClone(budget),
            finishedAt: new Date(),
          };
          await expect(
            run.repositories.executions.finish(finish),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await db.snapshot()).toBe(before);
          expect(await readRun(db, run.input.runId)).toEqual([
            { state: "running", error_class: null, budget_reason: null },
          ]);
        });
      },
      duration,
    );
  },
);
