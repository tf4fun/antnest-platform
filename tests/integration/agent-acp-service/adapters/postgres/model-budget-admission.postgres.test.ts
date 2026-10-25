import { describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PromptCoordinator } from "../../../../../services/agent-acp-service/src/application/prompt-coordinator.js";
import { createOwnedRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { modelUsage } from "../../../../../services/agent-acp-service/src/adapters/model/openai-usage.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import {
  ModelBudgetExceededError,
  type OrganizationBudget,
} from "../../../../../services/agent-acp-service/src/domain/model-budget.js";
import { publicExecutionConfiguration } from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { lockRuntimeBarrierOrganization } from "../../../../../services/agent-acp-service/src/adapters/postgres/runtime-barrier.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { localExecution } from "../../../../../services/agent-acp-service/test/support/local-execution.js";
import {
  type FencingFixture,
  scope,
  withDatabase,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const organizationId = "organization-1";

function policy(
  overrides: Partial<OrganizationBudget> = {},
): OrganizationBudget {
  return {
    revision: 1,
    unknown_cost: "deny",
    run_caps: {},
    daily: { hard_cost_usd_micros: 10 },
    monthly: {},
    ...overrides,
  };
}

async function configure(
  fixture: FencingFixture,
  budget = policy(),
): Promise<void> {
  const configuration = {
    ...publicExecutionConfiguration(executionConfiguration()),
    organization_budget: budget,
  };
  await fixture.observer.query(
    `INSERT INTO execution_configurations(organization_id,revision,configuration) VALUES($1,$2,$3::jsonb)
     ON CONFLICT(organization_id) DO UPDATE SET configuration=EXCLUDED.configuration`,
    [organizationId, configuration.revision, JSON.stringify(configuration)],
  );
}

async function spend(
  fixture: FencingFixture,
  period: "daily" | "monthly",
  used: number,
  reserved = 0,
  unknown = 0,
): Promise<void> {
  await fixture.observer.query(
    `INSERT INTO organization_spend(organization_id,period,period_start,cost_usd_micros,reserved_cost_usd_micros,unbounded_cost_attempts)
     SELECT $1,$2,CASE $2 WHEN 'daily' THEN moment::date ELSE date_trunc('month',moment)::date END,$3,$4,$5
     FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS moment) captured`,
    [organizationId, period, used, reserved, unknown],
  );
}

async function intent(fixture: FencingFixture) {
  const session = await fixture.session(
    scope("budget-admission-agent", organizationId),
  );
  const owner = await fixture.owner(session.binding);
  const input = fixture.input(session);
  await owner.runs.createRunIntent(input);
  return {
    session,
    owner,
    input,
    acceptance: fixture.acceptance(session, input.runId),
  };
}

async function admissionFacts(fixture: FencingFixture, runId: string) {
  const row = (
    await fixture.observer.query<{
      state: string;
      error_class: string | null;
      pending_user_message_id: string | null;
      execution_snapshot: unknown;
      last_message_sequence: string;
      append_version: string;
      messages: number;
      reservations: number;
    }>(
      `SELECT r.state,r.error_class,r.pending_user_message_id,r.execution_snapshot,
       s.last_message_sequence::text,s.append_version::text,
       (SELECT count(*)::int FROM session_messages WHERE run_id=r.id) AS messages,
       (SELECT count(*)::int FROM model_budget_reservations WHERE run_id=r.id) AS reservations
     FROM runs r JOIN acp_sessions s ON s.id=r.session_id WHERE r.id=$1`,
      [runId],
    )
  ).rows[0];
  if (row === undefined)
    throw new Error("Original admission facts are missing");
  return row;
}

describe.skipIf(databaseUrl === undefined)(
  "model budget Run admission in PostgreSQL",
  () => {
    it.each([
      { period: "daily" as const, used: 10, reserved: 0 },
      { period: "monthly" as const, used: 7, reserved: 3 },
    ])(
      "durably rejects the original intent when $period spending and reservations exhaust the cap",
      async ({ period, used, reserved }) => {
        await withDatabase(async (fixture) => {
          await configure(
            fixture,
            policy({ daily: {}, [period]: { hard_cost_usd_micros: 10 } }),
          );
          await spend(fixture, period, used, reserved);
          const test = await intent(fixture);
          await expect(
            test.owner.runs.acceptRun(test.acceptance),
          ).rejects.toMatchObject({
            code: "budget_exceeded",
            scope: "organization_" + period,
            limit: "10",
            used: "10",
          });
          expect(await admissionFacts(fixture, test.input.runId)).toEqual({
            state: "failed",
            error_class: "budget_exceeded",
            pending_user_message_id: null,
            execution_snapshot: null,
            last_message_sequence: "0",
            append_version: "1",
            messages: 0,
            reservations: 0,
          });
          expect(
            (
              await fixture.observer.query(
                "SELECT cost_usd_micros::text,reserved_cost_usd_micros::text FROM organization_spend",
              )
            ).rows,
          ).toEqual([
            {
              cost_usd_micros: String(used),
              reserved_cost_usd_micros: String(reserved),
            },
          ]);
          // The failed intent remains durable, but no longer occupies the Agent slot.
          await configure(
            fixture,
            policy({
              revision: 2,
              daily: {},
              [period]: { hard_cost_usd_micros: 11 },
            }),
          );
          const next = fixture.input(test.session);
          await test.owner.runs.createRunIntent(next);
          expect(
            await test.owner.runs.acceptRun(
              fixture.acceptance(test.session, next.runId),
            ),
          ).toBe("accepted");
        });
      },
    );

    it("uses the latest durable organization policy instead of the captured Run policy", async () => {
      await withDatabase(async (fixture) => {
        await configure(
          fixture,
          policy({ daily: { hard_cost_usd_micros: 20 } }),
        );
        await spend(fixture, "daily", 10);
        const test = await intent(fixture);
        await configure(fixture, policy({ revision: 2 }));
        await expect(
          test.owner.runs.acceptRun(test.acceptance),
        ).rejects.toBeInstanceOf(ModelBudgetExceededError);
        expect((await admissionFacts(fixture, test.input.runId)).state).toBe(
          "failed",
        );
      });
    });

    it("blocks another Agent after an actual attempt settlement exhausts organization spending", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        const first = await intent(fixture);
        const pricing = {
          currency: "USD" as const,
          inputPerMillion: 1,
          outputPerMillion: 1,
        };
        first.acceptance.snapshot.executionSpec.model.pricing = pricing;
        expect(await first.owner.runs.acceptRun(first.acceptance)).toBe(
          "accepted",
        );
        const events = createOwnedRunRepositories(
          fixture.kernelA,
          first.owner.authority,
        ).events;
        const startedAt = new Date();
        await events.startModelAttempt({
          runId: first.input.runId,
          ordinal: 1,
          modelProfileId: first.acceptance.snapshot.modelProfileId,
          providerConnectionId: first.acceptance.snapshot.providerConnectionId,
          model: first.acceptance.snapshot.executionSpec.model.model,
          purpose: "foreground",
          startedAt,
          reservation: { inputTokens: 10, outputTokens: 0 },
        });
        await events.finishModelAttempt({
          runId: first.input.runId,
          ordinal: 1,
          outcome: "completed",
          reason: "completed",
          durationMs: 1,
          outputStarted: false,
          usage: modelUsage(
            { prompt_tokens: 10, completion_tokens: 0 },
            pricing,
          ),
          finishedAt: new Date(startedAt.getTime() + 1),
          contextSize: 64000,
        });
        const other = await fixture.session(
          scope("other-budget-agent", organizationId),
        );
        const owner = await fixture.owner(other.binding, undefined, "b");
        const next = fixture.input(other);
        await owner.runs.createRunIntent(next);
        await expect(
          owner.runs.acceptRun(fixture.acceptance(other, next.runId)),
        ).rejects.toMatchObject({
          code: "budget_exceeded",
          scope: "organization_daily",
          used: "10",
        });
        expect(
          (
            await fixture.observer.query(
              "SELECT cost_usd_micros::text,reserved_cost_usd_micros::text FROM organization_spend ORDER BY period",
            )
          ).rows,
        ).toEqual([
          { cost_usd_micros: "10", reserved_cost_usd_micros: "0" },
          { cost_usd_micros: "10", reserved_cost_usd_micros: "0" },
        ]);
        expect((await admissionFacts(fixture, next.runId)).state).toBe(
          "failed",
        );
      });
    });

    it.each(["unbounded_attempt", "history_gap"] as const)(
      "denies a capped period with %s under deny policy without inventing a charge",
      async (kind) => {
        await withDatabase(async (fixture) => {
          await configure(fixture);
          if (kind === "unbounded_attempt")
            await spend(fixture, "daily", 0, 0, 1);
          else
            await fixture.observer.query(
              "UPDATE model_budget_history SET complete_before_cutover=false,cutover_at=clock_timestamp()",
            );
          const test = await intent(fixture);
          await expect(
            test.owner.runs.acceptRun(test.acceptance),
          ).rejects.toMatchObject({
            code: "budget_exceeded",
            scope: "organization_daily",
          });
          expect((await admissionFacts(fixture, test.input.runId)).state).toBe(
            "failed",
          );
          expect(
            (
              await fixture.observer.query(
                "SELECT count(*)::int AS count FROM run_usage",
              )
            ).rows,
          ).toEqual([{ count: 0 }]);
          expect(
            (
              await fixture.observer.query(
                "SELECT COALESCE(sum(cost_usd_micros),0)::text AS cost FROM organization_spend",
              )
            ).rows,
          ).toEqual([{ cost: "0" }]);
        });
      },
    );

    it("allow permits uncertain history but never waives a known exhausted cap", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture, policy({ unknown_cost: "allow" }));
        await fixture.observer.query(
          "UPDATE model_budget_history SET complete_before_cutover=false,cutover_at=clock_timestamp()",
        );
        await spend(fixture, "daily", 10, 0, 1);
        const test = await intent(fixture);
        await expect(
          test.owner.runs.acceptRun(test.acceptance),
        ).rejects.toMatchObject({
          code: "budget_exceeded",
          scope: "organization_daily",
          used: "10",
        });
      });
    });

    it("commits cancellation ahead of budget rejection", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        await spend(fixture, "daily", 10);
        const test = await intent(fixture);
        await test.owner.runs.requestCancellation(test.input.runId, new Date());
        expect(await test.owner.runs.acceptRun(test.acceptance)).toBe(
          "cancelled",
        );
        expect(await admissionFacts(fixture, test.input.runId)).toMatchObject({
          state: "cancelled",
          error_class: null,
          messages: 0,
          reservations: 0,
        });
      });
    });

    it("treats a zero organization hard cap as a closed admission gate", async () => {
      await withDatabase(async (fixture) => {
        await configure(
          fixture,
          policy({ daily: { hard_cost_usd_micros: 0 } }),
        );
        const test = await intent(fixture);
        // An individual zero-price model does not prove every future fallback,
        // judge and Provider receipt in this whole Run will be free.
        test.acceptance.snapshot.executionSpec.model.pricing = {
          currency: "USD",
          inputPerMillion: 0,
          outputPerMillion: 0,
        };
        await expect(
          test.owner.runs.acceptRun(test.acceptance),
        ).rejects.toMatchObject({
          code: "budget_exceeded",
          scope: "organization_daily",
          limit: "0",
          used: "0",
        });
      });
    });

    it.each(["allow_unknown", "soft_only", "no_policy", "old_period"] as const)(
      "does not invent an admission hard cap for $0",
      async (scenario) => {
        await withDatabase(async (fixture) => {
          if (scenario !== "no_policy")
            await configure(
              fixture,
              policy({
                unknown_cost: scenario === "allow_unknown" ? "allow" : "deny",
                daily:
                  scenario === "soft_only"
                    ? { soft_cost_usd_micros: 0 }
                    : { hard_cost_usd_micros: 10 },
              }),
            );
          if (scenario === "allow_unknown" || scenario === "soft_only") {
            await fixture.observer.query(
              "UPDATE model_budget_history SET complete_before_cutover=false,cutover_at=clock_timestamp()",
            );
            await spend(fixture, "daily", 0, 0, 1);
          }
          if (scenario === "old_period") {
            await spend(fixture, "daily", 1000);
            await fixture.observer.query(
              "UPDATE organization_spend SET period_start=period_start-1",
            );
          }
          const test = await intent(fixture);
          expect(await test.owner.runs.acceptRun(test.acceptance)).toBe(
            "accepted",
          );
          expect(
            (await admissionFacts(fixture, test.input.runId)).messages,
          ).toBe(1);
        });
      },
    );

    it("joins a real budget rejection before releasing the original Runtime pin", async () => {
      await withDatabase(async (fixture) => {
        const local = await localExecution();
        await configure(fixture);
        await spend(fixture, "daily", 10);
        const session = await fixture.session(scope("agent-1", organizationId));
        const owner = await fixture.owner(session.binding);
        const recoveryRequired = vi.fn();
        let runId: string | undefined;
        const coordinator = new PromptCoordinator({
          repository: owner.runs,
          directory: local.directory,
          protection: {
            hasUnstoppedRuntimeCalls: () => Promise.resolve(false),
          },
          runTimeoutMs: 60000,
          recoveryRequired,
          id: (kind) => {
            const id = randomUUID();
            if (kind === "run") runId = id;
            return id;
          },
          now: () => new Date(),
        });
        try {
          await expect(
            coordinator.accept({
              binding: session.binding,
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "Do not dispatch over budget" }],
            }),
          ).rejects.toMatchObject({
            code: "budget_exceeded",
            scope: "organization_daily",
          });
          expect(runId).toBeDefined();
          expect(await admissionFacts(fixture, runId!)).toMatchObject({
            state: "failed",
            error_class: "budget_exceeded",
            messages: 0,
            reservations: 0,
          });
          expect(recoveryRequired).not.toHaveBeenCalled();
          const closed = executionConfiguration();
          closed.revision++;
          closed.agents[0]!.accepting_runs = false;
          delete closed.agents[0]!.runtime!.credential;
          await local.directory.apply(closed);
          expect(readdirSync(local.connections.directory)).toEqual([]);
        } finally {
          if (runId !== undefined) local.directory.releaseRuntimeRun(runId);
        }
      });
    });

    it("rolls back a planned budget rejection if its original lease expires while waiting for the Session", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        await spend(fixture, "daily", 10);
        const test = await intent(fixture);
        await fixture.observer.query(
          "UPDATE agent_leases SET expires_at=clock_timestamp()+interval '1 second' WHERE organization_id=$1 AND agent_id=$2",
          [organizationId, test.session.binding.agentId],
        );
        const held = await fixture.holdSession(test.session.sessionId);
        const accepting = test.owner.runs.acceptRun(test.acceptance).then(
          () => {
            throw new Error("Expired owner unexpectedly committed admission");
          },
          (error: unknown) => {
            expect(error).toBeInstanceOf(AgentOwnershipLostError);
          },
        );
        void accepting.catch(() => undefined);
        try {
          await fixture.waitForBlockedWriter();
          await expect
            .poll(
              async () =>
                (
                  await fixture.observer.query<{ expired: boolean }>(
                    "SELECT expires_at<=clock_timestamp() AS expired FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                    [organizationId, test.session.binding.agentId],
                  )
                ).rows[0]?.expired,
              { timeout: 3000 },
            )
            .toBe(true);
        } finally {
          await fixture.release(held);
          await accepting;
        }
        expect(await admissionFacts(fixture, test.input.runId)).toMatchObject({
          state: "admitting",
          error_class: null,
          pending_user_message_id: test.input.userMessageId,
          messages: 0,
        });
      });
    });

    it("waits for an original organization writer and observes its committed spending", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        await spend(fixture, "daily", 9);
        const test = await intent(fixture);
        const writer = await fixture.observer.connect();
        let accepting: Promise<unknown> | undefined;
        try {
          await writer.query("BEGIN");
          await lockRuntimeBarrierOrganization(writer, organizationId);
          await writer.query(
            "UPDATE organization_spend SET cost_usd_micros=10 WHERE organization_id=$1",
            [organizationId],
          );
          accepting = test.owner.runs.acceptRun(test.acceptance).then(
            () => {
              throw new Error(
                "Exhausted organization unexpectedly admitted a Run",
              );
            },
            (error: unknown) => {
              expect(error).toMatchObject({
                code: "budget_exceeded",
                scope: "organization_daily",
                used: "10",
              });
            },
          );
          // Observe the same operation before waiting so a failed expectation never detaches it.
          void accepting.catch(() => undefined);
          await fixture.waitForBlockedWriter();
          await writer.query("COMMIT");
          await accepting;
          expect((await admissionFacts(fixture, test.input.runId)).state).toBe(
            "failed",
          );
        } finally {
          await writer.query("ROLLBACK");
          writer.release();
          if (accepting !== undefined) await accepting;
        }
      });
    });
  },
);
