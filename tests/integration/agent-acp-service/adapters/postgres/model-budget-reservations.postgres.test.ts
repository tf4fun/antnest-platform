import { describe, expect, it } from "vitest";
import { modelUsage } from "../../../../../services/agent-acp-service/src/adapters/model/openai-usage.js";
import { createOwnedRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { publicExecutionConfiguration } from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import {
  type FencingFixture,
  registration,
  scope,
  withDatabase,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const organizationId = "organization-1";
const attemptTime = Date.parse("2026-10-25T01:00:00.000Z");

function start(runId: string, ordinal = 1, inputTokens = 7) {
  const model = executionConfiguration().models[0]!;
  return {
    runId,
    ordinal,
    modelProfileId: model.model_profile_id,
    providerConnectionId: model.connection_id,
    model: model.model,
    purpose: "foreground" as const,
    startedAt: new Date(attemptTime + ordinal * 1000),
    reservation: { inputTokens, outputTokens: 0 },
  };
}

function finish(runId: string) {
  return {
    runId,
    ordinal: 1,
    outcome: "completed" as const,
    reason: "completed",
    durationMs: 125,
    outputStarted: true,
    usage: modelUsage(
      { prompt_tokens: 2, completion_tokens: 1 },
      {
        currency: "USD",
        inputPerMillion: 1,
        outputPerMillion: 1,
      },
    ),
    finishedAt: new Date(attemptTime + 1125),
    contextSize: 64_000,
  };
}

async function configure(fixture: FencingFixture): Promise<void> {
  const original = executionConfiguration();
  const configuration = {
    ...publicExecutionConfiguration({
      ...original,
      models: original.models.map((model) => ({
        ...model,
        pricing: {
          currency: "USD" as const,
          input_per_million: 1,
          output_per_million: 1,
        },
      })),
    }),
    organization_budget: {
      revision: 1,
      unknown_cost: "deny",
      run_caps: {},
      daily: { hard_cost_usd_micros: 10 },
      monthly: { hard_cost_usd_micros: 10 },
    },
  };
  await fixture.observer.query(
    "INSERT INTO execution_configurations(organization_id,revision,configuration) VALUES($1,$2,$3::jsonb)",
    [organizationId, configuration.revision, JSON.stringify(configuration)],
  );
}

async function accept(fixture: FencingFixture, side: "a" | "b") {
  const session = await fixture.session(
    scope("model-budget-agent-" + side, organizationId),
  );
  const owner = await fixture.owner(
    session.binding,
    registration("acp-" + side),
    side,
  );
  const repositories = createOwnedRunRepositories(
    side === "a" ? fixture.kernelA : fixture.kernelB,
    owner.authority,
  );
  const input = fixture.input(session);
  await repositories.runs.createRunIntent(input);
  const acceptance = fixture.acceptance(session, input.runId);
  acceptance.snapshot.executionSpec.model.pricing = {
    currency: "USD",
    inputPerMillion: 1,
    outputPerMillion: 1,
  };
  expect(await repositories.runs.acceptRun(acceptance)).toBe("accepted");
  return { ...repositories, session, owner, runId: input.runId };
}

type ReservationRow = {
  run_id: string;
  ordinal: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd_micros: string;
  state: string;
  day_start: string;
  month_start: string;
};
type UsageRow = {
  run_id: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd_micros: string;
  reserved_input_tokens: string;
  reserved_output_tokens: string;
  reserved_cost_usd_micros: string;
  unknown_attempts: string;
};
type SpendRow = {
  organization_id: string;
  period: string;
  period_start: string;
  cost_usd_micros: string;
  reserved_cost_usd_micros: string;
  unknown_attempts: string;
};
type AuditRow = {
  run_id: string;
  kind: string;
  visible: boolean;
  context_excluded: boolean;
  payload: Record<string, unknown>;
};

async function ledger(fixture: FencingFixture) {
  const [reservations, usage, spend] = await Promise.all([
    fixture.observer.query<ReservationRow>(
      "SELECT run_id,ordinal::text,input_tokens::text,output_tokens::text,cost_usd_micros::text,state,day_start::text,month_start::text FROM model_budget_reservations ORDER BY run_id,ordinal",
    ),
    fixture.observer.query<UsageRow>(
      "SELECT run_id,input_tokens::text,output_tokens::text,cost_usd_micros::text,reserved_input_tokens::text,reserved_output_tokens::text,reserved_cost_usd_micros::text,unknown_attempts::text FROM run_usage ORDER BY run_id",
    ),
    fixture.observer.query<SpendRow>(
      "SELECT organization_id,period,period_start::text,cost_usd_micros::text,reserved_cost_usd_micros::text,unknown_attempts::text FROM organization_spend ORDER BY organization_id,period,period_start",
    ),
  ]);
  return {
    reservations: reservations.rows,
    usage: usage.rows,
    spend: spend.rows,
  };
}

async function audits(fixture: FencingFixture) {
  return (
    await fixture.observer.query<AuditRow>(
      "SELECT run_id,kind,visible,context_excluded,payload FROM session_messages WHERE kind IN ('model_attempt','usage') ORDER BY session_id,sequence",
    )
  ).rows;
}

function expectOrganizationSpend(
  rows: SpendRow[],
  reservation: ReservationRow,
  cost: string,
  reserved: string,
): void {
  expect(reservation.day_start).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  expect(reservation.month_start).toBe(
    reservation.day_start.slice(0, 7) + "-01",
  );
  expect(rows).toEqual([
    {
      organization_id: organizationId,
      period: "daily",
      period_start: reservation.day_start,
      cost_usd_micros: cost,
      reserved_cost_usd_micros: reserved,
      unknown_attempts: "0",
    },
    {
      organization_id: organizationId,
      period: "monthly",
      period_start: reservation.month_start,
      cost_usd_micros: cost,
      reserved_cost_usd_micros: reserved,
      unknown_attempts: "0",
    },
  ]);
}

describe.skipIf(databaseUrl === undefined)(
  "owned model budget reservations in PostgreSQL",
  () => {
    it.each([
      null,
      { unexpected: true },
      { exceeded: { scope: "run_cost", limit: "1", used: "-1" } },
    ])(
      "rejects an incomplete or malformed committed settlement receipt %j without charging again",
      async (settlement) => {
        await withDatabase(async (db) => {
          await configure(db);
          const a = await accept(db, "a");
          await a.events.startModelAttempt(start(a.runId));
          const original = finish(a.runId);
          await a.events.finishModelAttempt(original);
          await db.observer.query(
            "UPDATE model_budget_reservations SET settlement=$2::jsonb WHERE run_id=$1",
            [a.runId, settlement === null ? null : JSON.stringify(settlement)],
          );
          const before = await ledger(db);
          const business = await db.snapshot();
          await expect(a.events.finishModelAttempt(original)).rejects.toThrow();
          expect(await ledger(db)).toEqual(before);
          expect(await db.snapshot()).toBe(business);
        });
      },
    );

    it("returns a token overspend receipt after committing the original consumption", async () => {
      await withDatabase(async (db) => {
        await configure(db);
        const a = await accept(db, "a");
        await db.observer.query(
          `UPDATE execution_configurations SET configuration=jsonb_set(configuration,
           '{organization_budget,run_caps}', '{"max_input_tokens":7}'::jsonb) WHERE organization_id=$1`,
          [organizationId],
        );
        await a.events.startModelAttempt(start(a.runId));
        const original = {
          ...finish(a.runId),
          usage: modelUsage(
            { prompt_tokens: 8, completion_tokens: 0 },
            { currency: "USD", inputPerMillion: 1, outputPerMillion: 1 },
          ),
        };
        const receipt = await a.events.finishModelAttempt(original);
        expect(receipt.settlement).toEqual({
          exceeded: { scope: "run_input", limit: "7", used: "8" },
        });
        const stored = await ledger(db);
        expect(stored.usage[0]).toMatchObject({
          input_tokens: "8",
          cost_usd_micros: "8",
          reserved_input_tokens: "0",
        });
        expect(await a.events.finishModelAttempt(original)).toEqual(receipt);
        expect(await ledger(db)).toEqual(stored);
      });
    });

    it.each(["allow", "deny"] as const)(
      "retains unknown consumption under the latest %s policy",
      async (policy) => {
        await withDatabase(async (db) => {
          await configure(db);
          const a = await accept(db, "a");
          await a.events.startModelAttempt(start(a.runId));
          await db.observer.query(
            "UPDATE execution_configurations SET configuration=jsonb_set(configuration, '{organization_budget,unknown_cost}', $2::jsonb) WHERE organization_id=$1",
            [organizationId, JSON.stringify(policy)],
          );
          const receipt = await a.events.finishModelAttempt({
            ...finish(a.runId),
            usage: {},
          });
          expect(receipt.settlement).toEqual(
            policy === "allow"
              ? {}
              : {
                  exceeded: { scope: "unknown_cost", limit: null, used: null },
                },
          );
          const stored = await ledger(db);
          expect(stored.usage[0]).toMatchObject({
            cost_usd_micros: "0",
            reserved_cost_usd_micros: "7",
            unknown_attempts: "1",
          });
          expect(stored.reservations[0]?.state).toBe("unresolved");
        });
      },
    );

    it("keeps a crossed-period overspend and its exact replay decision in the original buckets", async () => {
      await withDatabase(async (db) => {
        await configure(db);
        const a = await accept(db, "a");
        await a.events.startModelAttempt(start(a.runId));
        await db.observer.query(
          "UPDATE model_budget_reservations SET day_start='2000-01-31',month_start='2000-01-01' WHERE run_id=$1",
          [a.runId],
        );
        await db.observer.query(
          "UPDATE organization_spend SET period_start=CASE period WHEN 'daily' THEN '2000-01-31'::date ELSE '2000-01-01'::date END WHERE organization_id=$1",
          [organizationId],
        );
        const original = {
          ...finish(a.runId),
          usage: modelUsage(
            { prompt_tokens: 11, completion_tokens: 0 },
            { currency: "USD", inputPerMillion: 1, outputPerMillion: 1 },
          ),
        };
        const receipt = await a.events.finishModelAttempt(original);
        expect(receipt.settlement).toEqual({
          exceeded: { scope: "organization_daily", limit: "10", used: "11" },
        });
        const stored = await ledger(db);
        expect(stored.spend).toHaveLength(2);
        for (const bucket of stored.spend) {
          expect(bucket).toMatchObject({
            cost_usd_micros: "11",
            reserved_cost_usd_micros: "0",
          });
          expect(bucket.period_start).toBe(
            bucket.period === "daily" ? "2000-01-31" : "2000-01-01",
          );
        }
        await db.observer.query(
          "UPDATE execution_configurations SET configuration=jsonb_set(configuration, '{organization_budget,daily}', '{}'::jsonb) WHERE organization_id=$1",
          [organizationId],
        );
        expect(await a.events.finishModelAttempt(original)).toEqual(receipt);
        expect(await ledger(db)).toEqual(stored);
      });
    });

    it.each([
      {
        name: "current daily",
        cutoff: "current",
        daily: true,
        monthly: true,
        denied: "organization_daily",
      },
      {
        name: "current monthly",
        cutoff: "current",
        daily: false,
        monthly: true,
        denied: "organization_monthly",
      },
      {
        name: "next complete day",
        cutoff: "previous_day",
        daily: true,
        monthly: false,
        denied: undefined,
      },
      {
        name: "next complete month",
        cutoff: "previous_month",
        daily: true,
        monthly: true,
        denied: undefined,
      },
    ] as const)(
      "enforces historical coverage only for the $name budget bucket",
      async (scenario) => {
        await withDatabase(async (fixture) => {
          await configure(fixture);
          const a = await accept(fixture, "a");
          // A fresh schema has a proven empty prehistory. Simulate an old-schema
          // cutover without inventing charges or attempts for purged history.
          expect(
            (
              await fixture.observer.query(
                "SELECT complete_before_cutover FROM model_budget_history",
              )
            ).rows,
          ).toEqual([{ complete_before_cutover: true }]);
          await fixture.observer.query(
            `UPDATE model_budget_history SET complete_before_cutover=false,cutover_at=CASE $1
           WHEN 'previous_day' THEN (date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second') AT TIME ZONE 'UTC'
           WHEN 'previous_month' THEN (date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second') AT TIME ZONE 'UTC'
           ELSE clock_timestamp() END`,
            [scenario.cutoff],
          );
          const policy = {
            revision: 2,
            unknown_cost: "deny",
            run_caps: {},
            daily: scenario.daily ? { hard_cost_usd_micros: 10 } : {},
            monthly: scenario.monthly ? { hard_cost_usd_micros: 10 } : {},
          };
          await fixture.observer.query(
            "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{organization_budget}',$2::jsonb) WHERE organization_id=$1",
            [organizationId, JSON.stringify(policy)],
          );
          const history = (
            await fixture.observer.query("SELECT * FROM model_budget_history")
          ).rows;
          const before = await ledger(fixture);
          const original = await fixture.snapshot();
          if (scenario.denied !== undefined) {
            await expect(
              a.events.startModelAttempt(start(a.runId)),
            ).rejects.toMatchObject({
              code: "budget_exceeded",
              scope: scenario.denied,
              retryable: false,
            });
            expect(await ledger(fixture)).toEqual(before);
            expect(await fixture.snapshot()).toBe(original);
            expect(await audits(fixture)).toEqual([]);
            // An explicit allow policy keeps the history gap, not a fake zero
            // charge or a fabricated unknown physical attempt.
            await fixture.observer.query(
              "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{organization_budget}',$2::jsonb) WHERE organization_id=$1",
              [
                organizationId,
                JSON.stringify({
                  ...policy,
                  revision: 3,
                  unknown_cost: "allow",
                }),
              ],
            );
          }
          await a.events.startModelAttempt(start(a.runId));
          const held = await ledger(fixture);
          expect(held.reservations).toHaveLength(1);
          expect(held.spend.every((row) => row.unknown_attempts === "0")).toBe(
            true,
          );
          expectOrganizationSpend(held.spend, held.reservations[0]!, "0", "7");
          expect(
            (await fixture.observer.query("SELECT * FROM model_budget_history"))
              .rows,
          ).toEqual(history);
        });
      },
    );

    it.each(["start", "finish"] as const)(
      "rolls back budget %s when the original lease expires while waiting for the Session",
      async (phase) => {
        await withDatabase(async (fixture) => {
          await configure(fixture);
          const a = await accept(fixture, "a");
          if (phase === "finish")
            await a.events.startModelAttempt(start(a.runId));
          await fixture.observer.query(
            "UPDATE agent_leases SET expires_at=clock_timestamp()+interval '3 seconds' WHERE organization_id=$1 AND agent_id=$2",
            [organizationId, a.owner.authority.fence.agentId],
          );
          const before = await ledger(fixture);
          const original = await fixture.snapshot();
          const held = await fixture.holdSession(a.session.sessionId);
          const operation =
            phase === "start"
              ? a.events.startModelAttempt(start(a.runId))
              : a.events.finishModelAttempt(finish(a.runId));
          const pending = fixture.observe(
            operation.then(
              () => ({ status: "fulfilled" as const }),
              (reason: unknown) => ({ status: "rejected" as const, reason }),
            ),
          );
          await fixture.waitForBlockedWriter();
          await expect
            .poll(
              async () =>
                (
                  await fixture.observer.query<{ expired: boolean }>(
                    "SELECT expires_at<=clock_timestamp() AS expired FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                    [organizationId, a.owner.authority.fence.agentId],
                  )
                ).rows[0]?.expired,
              { timeout: 7000, interval: 100 },
            )
            .toBe(true);
          await fixture.release(held);
          expect(await pending).toMatchObject({
            status: "rejected",
            reason: { name: "AgentOwnershipLostError" },
          });
          expect(await ledger(fixture)).toEqual(before);
          expect(await fixture.snapshot()).toBe(original);
        });
      },
    );

    it("preserves the monetary reservation when the adapter cannot validate the cache usage receipt", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        const a = await accept(fixture, "a");
        const b = await accept(fixture, "b");
        await a.events.startModelAttempt(start(a.runId));
        const usage = modelUsage(
          {
            prompt_tokens: 2,
            completion_tokens: 1,
            cache_creation_input_tokens: -1,
          },
          {
            currency: "USD",
            inputPerMillion: 1,
            outputPerMillion: 1,
          },
        );
        expect(usage.cost).toBeUndefined();
        const completed = { ...finish(a.runId), usage };
        const receipt = await a.events.finishModelAttempt(completed);
        const saved = await ledger(fixture);
        expect(saved.reservations[0]).toMatchObject({
          state: "unresolved",
          cost_usd_micros: "7",
        });
        expect(saved.usage[0]).toMatchObject({
          input_tokens: "2",
          output_tokens: "1",
          cost_usd_micros: "0",
          reserved_cost_usd_micros: "7",
          unknown_attempts: "1",
        });
        expect(
          saved.spend.every(
            (row) =>
              row.cost_usd_micros === "0" &&
              row.reserved_cost_usd_micros === "7" &&
              row.unknown_attempts === "1",
          ),
        ).toBe(true);
        expect(await a.events.finishModelAttempt(completed)).toEqual(receipt);
        await expect(
          b.events.startModelAttempt(start(b.runId)),
        ).rejects.toMatchObject({
          code: "budget_exceeded",
          scope: "organization_daily",
        });
        expect(await ledger(fixture)).toEqual(saved);
        // Unknown cost with a finite retained bound still leaves the remainder
        // available; it must not be mistaken for unbounded historic consumption.
        await b.events.startModelAttempt(start(b.runId, 1, 3));
        expect(
          (await ledger(fixture)).spend.every(
            (row) =>
              row.reserved_cost_usd_micros === "10" &&
              row.unknown_attempts === "1",
          ),
        ).toBe(true);
      });
    });

    it("replaces an unbounded estimate with a valid original receipt before applying a later deny policy", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        await fixture.observer.query(
          "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{organization_budget,unknown_cost}','\"allow\"'::jsonb)",
        );
        const a = await accept(fixture, "a");
        const b = await accept(fixture, "b");
        const { reservation: _reservation, ...unbounded } = start(a.runId);
        void _reservation;
        await a.events.startModelAttempt(unbounded);
        await a.events.finishModelAttempt(finish(a.runId));
        await fixture.observer.query(
          "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{organization_budget,unknown_cost}','\"deny\"'::jsonb)",
        );
        await b.events.startModelAttempt(start(b.runId));
        const saved = await ledger(fixture);
        expect(
          saved.spend.every(
            (row) =>
              row.cost_usd_micros === "3" &&
              row.reserved_cost_usd_micros === "7" &&
              row.unknown_attempts === "0",
          ),
        ).toBe(true);
      });
    });

    it("does not treat old unbounded unknown spend as zero after the organization tightens its policy", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        await fixture.observer.query(
          "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{organization_budget,unknown_cost}','\"allow\"'::jsonb)",
        );
        const a = await accept(fixture, "a");
        const b = await accept(fixture, "b");
        const { reservation: _reservation, ...unbounded } = start(a.runId);
        void _reservation;
        await a.events.startModelAttempt(unbounded);
        await a.events.finishModelAttempt({ ...finish(a.runId), usage: {} });
        await fixture.observer.query(
          "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{organization_budget,unknown_cost}','\"deny\"'::jsonb)",
        );
        const before = await ledger(fixture);
        await expect(
          b.events.startModelAttempt(start(b.runId)),
        ).rejects.toMatchObject({
          code: "budget_exceeded",
          scope: "organization_daily",
        });
        expect(await ledger(fixture)).toEqual(before);
      });
    });

    it("retains unknown consumption across repository restart instead of releasing the original reservation", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        const a = await accept(fixture, "a");
        const b = await accept(fixture, "b");
        await a.events.startModelAttempt(start(a.runId));
        const unknown = {
          ...finish(a.runId),
          outcome: "cancelled" as const,
          reason: "cancelled",
          usage: {},
        };
        const receipt = await a.events.finishModelAttempt(unknown);
        const saved = await ledger(fixture);
        expect(saved.reservations[0]).toMatchObject({
          state: "unresolved",
          cost_usd_micros: "7",
        });
        expect(saved.usage[0]).toMatchObject({
          cost_usd_micros: "0",
          reserved_cost_usd_micros: "7",
          reserved_input_tokens: "7",
          unknown_attempts: "1",
        });
        expect(
          saved.spend.every(
            (row) =>
              row.cost_usd_micros === "0" &&
              row.reserved_cost_usd_micros === "7" &&
              row.unknown_attempts === "1",
          ),
        ).toBe(true);
        const restarted = createOwnedRunRepositories(
          fixture.kernelB,
          a.owner.authority,
        );
        expect(await restarted.events.finishModelAttempt(unknown)).toEqual(
          receipt,
        );
        await expect(
          b.events.startModelAttempt(start(b.runId)),
        ).rejects.toMatchObject({ code: "budget_exceeded" });
        expect(await ledger(fixture)).toEqual(saved);
      });
    });

    it("cannot forget unbounded unknown token usage when a later policy introduces a hard token cap", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        await fixture.observer.query(
          "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{organization_budget,unknown_cost}','\"allow\"'::jsonb)",
        );
        const a = await accept(fixture, "a");
        const { reservation: _reservation, ...unbounded } = start(a.runId);
        void _reservation;
        await a.events.startModelAttempt(unbounded);
        await a.events.finishModelAttempt({
          ...finish(a.runId),
          usage: {
            cost: { amount: 0, currency: "USD", source: "provider_reported" },
          },
        });
        await fixture.observer.query(
          "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{organization_budget,run_caps}','{\"max_input_tokens\":10}'::jsonb)",
        );
        const before = await ledger(fixture);
        await expect(
          a.events.startModelAttempt(start(a.runId, 2, 1)),
        ).rejects.toMatchObject({
          code: "budget_exceeded",
          scope: "run_input",
        });
        expect(await ledger(fixture)).toEqual(before);
      });
    });

    it("admits only one concurrent seven-micro reservation under shared ten-micro UTC caps", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        const runs = [await accept(fixture, "a"), await accept(fixture, "b")];
        const starts = runs.map((run) => start(run.runId));
        const tasks = runs.map((run, index) =>
          run.events.startModelAttempt(starts[index]!),
        );
        // The aggregate owns both original transactions, including the expected
        // rejected start, without turning that rejection into a cleanup failure.
        const outcomes = await fixture.observe(Promise.allSettled(tasks));
        expect(
          outcomes.filter((outcome) => outcome.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          outcomes.filter((outcome) => outcome.status === "rejected"),
        ).toHaveLength(1);
        expect(
          outcomes.find((outcome) => outcome.status === "rejected"),
        ).toMatchObject({
          status: "rejected",
          reason: { code: "budget_exceeded", retryable: false },
        });
        const winnerIndex = outcomes.findIndex(
          (outcome) => outcome.status === "fulfilled",
        );
        const winner = runs[winnerIndex]!;
        const loser = runs[1 - winnerIndex]!;
        const rows = await audits(fixture);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          run_id: winner.runId,
          kind: "model_attempt",
          visible: false,
          context_excluded: true,
          payload: { kind: "model_attempt", phase: "start", ordinal: 1 },
        });
        expect(rows.filter((row) => row.run_id === loser.runId)).toEqual([]);
        expect(rows.filter((row) => row.kind === "usage")).toEqual([]);
        const held = await ledger(fixture);
        expect(held.reservations).toHaveLength(1);
        expect(held.reservations[0]).toMatchObject({
          run_id: winner.runId,
          ordinal: "1",
          input_tokens: "7",
          output_tokens: "0",
          cost_usd_micros: "7",
        });
        expectOrganizationSpend(held.spend, held.reservations[0]!, "0", "7");
        const before = await fixture.snapshot();
        await expect(
          winner.events.startModelAttempt(starts[winnerIndex]!),
        ).resolves.toEqual({ warnings: [] });
        expect(await ledger(fixture)).toEqual(held);
        expect(await fixture.snapshot()).toBe(before);
        const conflict = {
          ...starts[winnerIndex]!,
          reservation: { inputTokens: 8, outputTokens: 0 },
        };
        await expect(
          winner.events.startModelAttempt(conflict),
        ).rejects.toThrow();
        expect(await ledger(fixture)).toEqual(held);
        expect(await fixture.snapshot()).toBe(before);
      });
    });

    it("settles known usage once and preserves the original organization buckets for later reservations", async () => {
      await withDatabase(async (fixture) => {
        await configure(fixture);
        const a = await accept(fixture, "a");
        const b = await accept(fixture, "b");
        await a.events.startModelAttempt(start(a.runId));
        const original = await ledger(fixture);
        expect(original.reservations).toHaveLength(1);
        const reservation = original.reservations[0]!;
        const completed = finish(a.runId);
        const receipt = await a.events.finishModelAttempt(completed);
        const settled = await ledger(fixture);
        expect(settled.reservations).toHaveLength(1);
        expect(settled.usage).toEqual([
          {
            run_id: a.runId,
            input_tokens: "2",
            output_tokens: "1",
            cost_usd_micros: "3",
            reserved_input_tokens: "0",
            reserved_output_tokens: "0",
            reserved_cost_usd_micros: "0",
            unknown_attempts: "0",
          },
        ]);
        expectOrganizationSpend(settled.spend, reservation, "3", "0");
        const beforeReplay = await fixture.snapshot();
        expect(await a.events.finishModelAttempt(completed)).toEqual(receipt);
        expect(await ledger(fixture)).toEqual(settled);
        expect(await fixture.snapshot()).toBe(beforeReplay);
        const facts = await audits(fixture);
        expect(
          facts
            .filter((row) => row.kind === "model_attempt")
            .map((row) => [row.payload.ordinal, row.payload.phase]),
        ).toEqual([
          [1, "start"],
          [1, "finish"],
        ]);
        expect(facts.filter((row) => row.kind === "usage")).toHaveLength(1);

        await b.events.startModelAttempt(start(b.runId));
        const combined = await ledger(fixture);
        expect(combined.reservations).toHaveLength(2);
        expect(
          combined.reservations.find((row) => row.run_id === b.runId),
        ).toMatchObject({
          ordinal: "1",
          input_tokens: "7",
          output_tokens: "0",
          cost_usd_micros: "7",
          day_start: reservation.day_start,
          month_start: reservation.month_start,
        });
        expectOrganizationSpend(combined.spend, reservation, "3", "7");
        const full = await fixture.snapshot();
        const extra = start(a.runId, 2, 1);
        await expect(a.events.startModelAttempt(extra)).rejects.toMatchObject({
          code: "budget_exceeded",
          retryable: false,
        });
        expect(await ledger(fixture)).toEqual(combined);
        expect(await fixture.snapshot()).toBe(full);
        const finalFacts = await audits(fixture);
        expect(
          finalFacts.filter(
            (row) => row.run_id === a.runId && row.kind === "model_attempt",
          ),
        ).toHaveLength(2);
        expect(
          finalFacts.filter(
            (row) => row.run_id === b.runId && row.kind === "model_attempt",
          ),
        ).toHaveLength(1);
        expect(finalFacts.filter((row) => row.kind === "usage")).toHaveLength(
          1,
        );
      });
    });

    it.each([
      { name: "finite", outcome: "cancelled" },
      { name: "unpriced-unbounded", outcome: "failed" },
    ] as const)(
      "settles trustworthy no-dispatch proof once for a $name reservation",
      async (scenario) => {
        await withDatabase(async (fixture) => {
          await configure(fixture);
          await fixture.observer.query(
            "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{organization_budget,unknown_cost}','\"allow\"'::jsonb)",
          );
          const session = await fixture.session(
            scope("model-budget-no-dispatch", organizationId),
          );
          const owner = await fixture.owner(
            session.binding,
            registration("acp-a"),
          );
          const repositories = createOwnedRunRepositories(
            fixture.kernelA,
            owner.authority,
          );
          const intent = fixture.input(session);
          await repositories.runs.createRunIntent(intent);
          const acceptance = fixture.acceptance(session, intent.runId);
          if (scenario.name === "finite") {
            acceptance.snapshot.executionSpec.model.pricing = {
              currency: "USD",
              inputPerMillion: 1,
              outputPerMillion: 1,
            };
          } else {
            delete acceptance.snapshot.executionSpec.model.pricing;
          }
          expect(await repositories.runs.acceptRun(acceptance)).toBe(
            "accepted",
          );
          const startFirst = start(intent.runId);
          if (scenario.name === "finite") {
            await repositories.events.startModelAttempt(startFirst);
          } else {
            const { reservation, ...unbounded } = startFirst;
            expect(reservation).toEqual({ inputTokens: 7, outputTokens: 0 });
            await repositories.events.startModelAttempt(unbounded);
          }
          const held = await ledger(fixture);
          expect(held.reservations).toHaveLength(1);
          expect(held.reservations[0]).toMatchObject({
            state: "reserved",
            input_tokens: scenario.name === "finite" ? "7" : null,
            output_tokens: scenario.name === "finite" ? "0" : null,
            cost_usd_micros: scenario.name === "finite" ? "7" : null,
          });
          const fullAccounting = async (): Promise<
            Record<string, string[]>
          > => {
            const values: Record<string, string[]> = {};
            for (const table of [
              "run_usage",
              "organization_spend",
              "model_budget_reservations",
            ]) {
              const rows = await fixture.observer.query<{ value: string }>(
                "SELECT to_jsonb(stored)::text AS value FROM " +
                  table +
                  " AS stored ORDER BY to_jsonb(stored)::text",
              );
              values[table] = rows.rows.map((row) => row.value);
            }
            return values;
          };
          const stopped = {
            ...finish(intent.runId),
            outcome: scenario.outcome,
            reason:
              scenario.outcome === "cancelled"
                ? "cancelled"
                : "provider_unavailable",
            outputStarted: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            notDispatched: true as const,
          };
          const invalid = [
            {
              name: "nonzero input",
              value: { ...stopped, usage: { inputTokens: 1, outputTokens: 0 } },
            },
            {
              name: "nonzero output",
              value: { ...stopped, usage: { inputTokens: 0, outputTokens: 1 } },
            },
            {
              name: "cost receipt",
              value: {
                ...stopped,
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cost: {
                    amount: 0,
                    currency: "USD" as const,
                    source: "provider_reported" as const,
                  },
                },
              },
            },
            {
              name: "completed outcome",
              value: { ...stopped, outcome: "completed" as const },
            },
            {
              name: "output started",
              value: { ...stopped, outputStarted: true },
            },
            { name: "HTTP status", value: { ...stopped, status: 429 } },
          ];
          const beforeInvalid = await fullAccounting();
          const beforeBusiness = await fixture.snapshot();
          for (const conflict of invalid) {
            await expect(
              repositories.events.finishModelAttempt(conflict.value),
              conflict.name,
            ).rejects.toThrow();
            expect(await fullAccounting()).toEqual(beforeInvalid);
            expect(await fixture.snapshot()).toBe(beforeBusiness);
          }
          const receipt = await repositories.events.finishModelAttempt(stopped);
          expect(receipt.event).toMatchObject({
            kind: "usage",
            measurement: { inputTokens: 0, outputTokens: 0 },
          });
          const settled = await ledger(fixture);
          expect(settled.reservations[0]).toMatchObject({ state: "settled" });
          expect(settled.usage).toEqual([
            {
              run_id: intent.runId,
              input_tokens: "0",
              output_tokens: "0",
              cost_usd_micros: "0",
              reserved_input_tokens: "0",
              reserved_output_tokens: "0",
              reserved_cost_usd_micros: "0",
              unknown_attempts: "0",
            },
          ]);
          expectOrganizationSpend(
            settled.spend,
            held.reservations[0]!,
            "0",
            "0",
          );
          expect(
            (
              await fixture.observer.query<{
                unknown_input_attempts: string;
                unknown_output_attempts: string;
                unbounded_cost_attempts: string;
              }>(
                "SELECT unknown_input_attempts::text,unknown_output_attempts::text,unbounded_cost_attempts::text FROM run_usage WHERE run_id=$1",
                [intent.runId],
              )
            ).rows,
          ).toEqual([
            {
              unknown_input_attempts: "0",
              unknown_output_attempts: "0",
              unbounded_cost_attempts: "0",
            },
          ]);
          expect(
            (
              await fixture.observer.query<{ cost_unknown: boolean }>(
                "SELECT cost_unknown FROM model_budget_reservations WHERE run_id=$1 AND ordinal=1",
                [intent.runId],
              )
            ).rows,
          ).toEqual([{ cost_unknown: false }]);
          const settledAccounting = await fullAccounting();
          const settledBusiness = await fixture.snapshot();
          expect(await repositories.events.finishModelAttempt(stopped)).toEqual(
            receipt,
          );
          expect(await fullAccounting()).toEqual(settledAccounting);
          expect(await fixture.snapshot()).toBe(settledBusiness);
          const { notDispatched, ...withoutProof } = stopped;
          expect(notDispatched).toBe(true);
          await expect(
            repositories.events.finishModelAttempt(withoutProof),
          ).rejects.toThrow(/receipt identity conflict/u);
          expect(await fullAccounting()).toEqual(settledAccounting);
          expect(await fixture.snapshot()).toBe(settledBusiness);
          const facts = await audits(fixture);
          expect(facts.map((row) => [row.kind, row.payload.phase])).toEqual([
            ["model_attempt", "start"],
            ["model_attempt", "finish"],
            ["usage", undefined],
          ]);
          expect(facts[1]!.payload).toMatchObject({
            notDispatched: true,
            usage: { inputTokens: 0, outputTokens: 0 },
            outcome: scenario.outcome,
            outputStarted: false,
          });
          expect(facts[1]!.payload).not.toHaveProperty("status");

          const next = start(intent.runId, 2);
          if (scenario.name === "finite") {
            await repositories.events.startModelAttempt(next);
          } else {
            const { reservation, ...unbounded } = next;
            expect(reservation).toEqual({ inputTokens: 7, outputTokens: 0 });
            await repositories.events.startModelAttempt(unbounded);
          }
          const ordinary = {
            ...withoutProof,
            ordinal: 2,
            finishedAt: new Date(attemptTime + 2125),
          };
          await repositories.events.finishModelAttempt(ordinary);
          const unresolved = await ledger(fixture);
          expect(
            unresolved.reservations.find((row) => row.ordinal === "2"),
          ).toMatchObject({ state: "unresolved" });
          const ordinaryAccounting = await fullAccounting();
          const ordinaryBusiness = await fixture.snapshot();
          await expect(
            repositories.events.finishModelAttempt({
              ...ordinary,
              notDispatched: true,
            }),
          ).rejects.toThrow(/receipt identity conflict/u);
          expect(await fullAccounting()).toEqual(ordinaryAccounting);
          expect(await fixture.snapshot()).toBe(ordinaryBusiness);
        });
      },
    );
  },
);
