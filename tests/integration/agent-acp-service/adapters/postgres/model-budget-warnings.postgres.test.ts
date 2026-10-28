import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { modelUsage } from "../../../../../services/agent-acp-service/src/adapters/model/openai-usage.js";
import { createOwnedRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { publicExecutionConfiguration } from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import type { OrganizationBudget } from "../../../../../services/agent-acp-service/src/domain/model-budget.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import {
  type FencingFixture,
  duration,
  registration,
  scope,
  withDatabase,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const organizationId = "organization-1";
const attemptTime = Date.parse("2026-10-25T01:00:00.000Z");
const pricing = {
  currency: "USD" as const,
  inputPerMillion: 1,
  outputPerMillion: 1,
};
type Period = "daily" | "monthly";
type SoftLimits = Partial<Record<Period, number>>;
type Message = {
  id: string;
  session_id: string;
  run_id: string | null;
  sequence: string;
  kind: string;
  visible: boolean;
  context_excluded: boolean;
  payload: { content?: { type: string; text?: string }[] };
};
type Spend = {
  period: Period;
  period_start: string;
  cost_usd_micros: string;
  reserved_cost_usd_micros: string;
};

async function configure(
  db: FencingFixture,
  limits: SoftLimits,
  revision = 1,
): Promise<void> {
  const original = executionConfiguration();
  const budget: OrganizationBudget = {
    revision,
    unknown_cost: "deny",
    run_caps: {},
    daily:
      limits.daily === undefined ? {} : { soft_cost_usd_micros: limits.daily },
    monthly:
      limits.monthly === undefined
        ? {}
        : { soft_cost_usd_micros: limits.monthly },
  };
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
    organization_budget: budget,
  };
  await db.observer.query(
    `INSERT INTO execution_configurations(organization_id,revision,configuration) VALUES($1,$2,$3::jsonb)
     ON CONFLICT(organization_id) DO UPDATE SET configuration=EXCLUDED.configuration`,
    [organizationId, configuration.revision, JSON.stringify(configuration)],
  );
}

async function prepare(db: FencingFixture, side: "a" | "b", accepted = true) {
  const session = await db.session(
    scope(`budget-warning-${side}-${randomUUID()}`, organizationId),
  );
  const owner = await db.owner(
    session.binding,
    registration("acp-" + side),
    side,
  );
  const repositories = createOwnedRunRepositories(
    side === "a" ? db.kernelA : db.kernelB,
    owner.authority,
  );
  const input = db.input(session);
  await repositories.runs.createRunIntent(input);
  const acceptance = db.acceptance(session, input.runId);
  acceptance.snapshot.executionSpec.model.pricing = structuredClone(pricing);
  if (accepted)
    expect(await repositories.runs.acceptRun(acceptance)).toBe("accepted");
  return {
    ...repositories,
    session,
    owner,
    input,
    acceptance,
    runId: input.runId,
  };
}

type Run = Awaited<ReturnType<typeof prepare>>;

function start(run: Run, inputTokens: number, ordinal = 1) {
  return {
    runId: run.runId,
    ordinal,
    modelProfileId: run.acceptance.snapshot.modelProfileId,
    providerConnectionId: run.acceptance.snapshot.providerConnectionId,
    model: run.acceptance.snapshot.executionSpec.model.model,
    purpose: "foreground" as const,
    startedAt: new Date(attemptTime + ordinal * 1000),
    reservation: { inputTokens, outputTokens: 0 },
  };
}

function finish(run: Run, inputTokens: number, ordinal = 1) {
  return {
    runId: run.runId,
    ordinal,
    outcome: "completed" as const,
    reason: "completed",
    durationMs: 125,
    outputStarted: true,
    usage: modelUsage(
      { prompt_tokens: inputTokens, completion_tokens: 0 },
      pricing,
    ),
    finishedAt: new Date(attemptTime + ordinal * 1000 + 125),
    contextSize: run.acceptance.snapshot.executionSpec.model.contextWindow,
  };
}

async function messages(db: FencingFixture): Promise<Message[]> {
  return (
    await db.observer.query<Message>(
      `SELECT m.id,m.session_id,m.run_id,m.sequence::text,m.kind,m.visible,m.context_excluded,m.payload
       FROM session_messages m JOIN acp_sessions s ON s.id=m.session_id
       WHERE s.organization_id=$1 ORDER BY m.session_id,m.sequence`,
      [organizationId],
    )
  ).rows;
}

async function notices(db: FencingFixture): Promise<Message[]> {
  return (await messages(db)).filter((row) => row.kind === "agent_message");
}

function noticeText(message: Message): string {
  return (
    message.payload.content?.map((block) => block.text ?? "").join(" ") ?? ""
  );
}

function expectWarnings(rows: Message[], limits: SoftLimits): void {
  expect(rows).toHaveLength(Object.keys(limits).length);
  for (const period of ["daily", "monthly"] as const) {
    const limit = limits[period];
    if (limit === undefined) continue;
    const matching = rows.filter((row) =>
      noticeText(row).toLowerCase().includes(period),
    );
    expect(matching).toHaveLength(1);
    const message = matching[0];
    if (message === undefined)
      throw new Error("Expected a persisted soft budget warning");
    expect(message).toMatchObject({
      kind: "agent_message",
      visible: true,
      context_excluded: true,
    });
    expect(noticeText(message)).toMatch(/soft|warning/iu);
    expect(noticeText(message)).toContain(String(limit));
  }
}

async function spending(db: FencingFixture): Promise<Spend[]> {
  return (
    await db.observer.query<Spend>(
      `SELECT period,period_start::text,cost_usd_micros::text,reserved_cost_usd_micros::text
       FROM organization_spend WHERE organization_id=$1 ORDER BY period,period_start`,
      [organizationId],
    )
  ).rows;
}

async function running(db: FencingFixture, run: Run): Promise<void> {
  expect(
    (
      await db.observer.query(
        "SELECT state,error_class FROM runs WHERE id=$1",
        [run.runId],
      )
    ).rows,
  ).toEqual([{ state: "running", error_class: null }]);
}

async function warningSnapshot(db: FencingFixture) {
  const [business, ledger] = await Promise.all([
    db.snapshot(),
    db.observer.query<{ facts: unknown }>(
      `SELECT jsonb_build_object(
         'spend', (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY organization_id,period,period_start),'[]'::jsonb) FROM organization_spend s),
         'reservations', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY run_id,ordinal),'[]'::jsonb) FROM model_budget_reservations r),
         'usage', (SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY run_id),'[]'::jsonb) FROM run_usage u)
       ) AS facts`,
    ),
  ]);
  const row = ledger.rows[0];
  if (row === undefined) throw new Error("Expected durable warning facts");
  return { business, ledger: row.facts };
}

describe.skipIf(databaseUrl === undefined)(
  "durable soft model budget warnings in PostgreSQL",
  () => {
    it(
      "warns at reservation equality independently for daily and monthly without stopping the Run",
      async () => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 5, monthly: 9 });
          const run = await prepare(db, "a");
          expect(await notices(db)).toEqual([]);
          const first = start(run, 5);
          await run.events.startModelAttempt(first);
          expectWarnings(await notices(db), { daily: 5 });
          const originalDaily = (await notices(db))[0];
          const firstFinish = finish(run, 5);
          await run.events.finishModelAttempt(firstFinish);
          expectWarnings(await notices(db), { daily: 5 });
          const second = start(run, 4, 2);
          await run.events.startModelAttempt(second);
          const warned = await notices(db);
          expectWarnings(warned, { daily: 5, monthly: 9 });
          expect(warned.find((row) => row.id === originalDaily?.id)).toEqual(
            originalDaily,
          );
          const reserved = await spending(db);
          expect(reserved).toHaveLength(2);
          expect(
            reserved.map((row) => [
              row.period,
              row.cost_usd_micros,
              row.reserved_cost_usd_micros,
            ]),
          ).toEqual([
            ["daily", "5", "4"],
            ["monthly", "5", "4"],
          ]);
          const daily = reserved.find((row) => row.period === "daily");
          const monthly = reserved.find((row) => row.period === "monthly");
          expect(monthly?.period_start).toBe(
            daily?.period_start.slice(0, 7) + "-01",
          );
          const beforeReplay = await db.snapshot();
          await run.events.startModelAttempt(structuredClone(first));
          await run.events.startModelAttempt(structuredClone(second));
          expect(await db.snapshot()).toBe(beforeReplay);
          const secondFinish = finish(run, 4, 2);
          await run.events.finishModelAttempt(firstFinish);
          await run.events.finishModelAttempt(secondFinish);
          const settled = await db.snapshot();
          await run.events.finishModelAttempt(structuredClone(firstFinish));
          await run.events.finishModelAttempt(structuredClone(secondFinish));
          expect(await db.snapshot()).toBe(settled);
          expect(await notices(db)).toEqual(warned);
          expect(
            (await spending(db)).map((row) => [
              row.period,
              row.cost_usd_micros,
              row.reserved_cost_usd_micros,
            ]),
          ).toEqual([
            ["daily", "9", "0"],
            ["monthly", "9", "0"],
          ]);
          await running(db, run);
        });
      },
      duration,
    );

    it(
      "commits one warning per organization bucket when two owned Agents concurrently cross soft limits",
      async () => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 7, monthly: 7 });
          const a = await prepare(db, "a");
          const b = await prepare(db, "b");
          expect(await notices(db)).toEqual([]);
          const started = await Promise.allSettled([
            db.observe(a.events.startModelAttempt(start(a, 4))),
            db.observe(b.events.startModelAttempt(start(b, 4))),
          ]);
          expect(started.map((result) => result.status)).toEqual([
            "fulfilled",
            "fulfilled",
          ]);
          const warnings = await notices(db);
          expectWarnings(warnings, { daily: 7, monthly: 7 });
          expect(new Set(warnings.map((row) => row.run_id)).size).toBe(1);
          for (const warning of warnings)
            expect([a.runId, b.runId]).toContain(warning.run_id);
          expect(
            (await spending(db)).map((row) => [
              row.cost_usd_micros,
              row.reserved_cost_usd_micros,
            ]),
          ).toEqual([
            ["0", "8"],
            ["0", "8"],
          ]);
          expect(
            (
              await db.observer.query(
                "SELECT run_id FROM model_budget_reservations",
              )
            ).rows,
          ).toHaveLength(2);
          await running(db, a);
          await running(db, b);
        });
      },
      duration,
    );

    it(
      "admits above soft spending after the user message and retains deduplication after physical Session purge",
      async () => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 7, monthly: 7 });
          await db.observer.query(
            `INSERT INTO organization_spend(organization_id,period,period_start,cost_usd_micros)
         SELECT $1,'daily',moment::date,7 FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS moment) captured
         UNION ALL
         SELECT $1,'monthly',date_trunc('month',moment)::date,7 FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS moment) captured`,
            [organizationId],
          );
          const run = await prepare(db, "a", false);
          expect(await messages(db)).toEqual([]);
          expect(await run.runs.acceptRun(run.acceptance)).toBe("accepted");
          const accepted = await messages(db);
          const prompt = accepted.find((row) => row.kind === "user_message");
          if (prompt === undefined)
            throw new Error("Expected the original admitted user message");
          expect(prompt.run_id).toBe(run.runId);
          const warnings = accepted.filter(
            (row) => row.kind === "agent_message",
          );
          expectWarnings(warnings, { daily: 7, monthly: 7 });
          for (const warning of warnings) {
            expect(warning.run_id).toBe(run.runId);
            expect(BigInt(warning.sequence) > BigInt(prompt.sequence)).toBe(
              true,
            );
          }
          expect(
            (
              await db.observer.query(
                "SELECT run_id FROM model_budget_reservations",
              )
            ).rows,
          ).toEqual([]);
          expect(
            accepted.filter((row) => row.kind === "model_attempt"),
          ).toEqual([]);
          await running(db, run);
          const originalSpend = await spending(db);
          await run.executions.finish({
            runId: run.runId,
            terminalClass: "completed",
            executorState: "quiescent",
            toolEffectState: "none",
            stopReason: "end_turn",
            finishedAt: new Date(),
          });
          // The historical purge respects the original restrictive Run foreign key.
          await db.observer.query("DELETE FROM runs WHERE id=$1", [run.runId]);
          await db.observer.query("DELETE FROM acp_sessions WHERE id=$1", [
            run.session.sessionId,
          ]);
          expect(
            (
              await db.observer.query("SELECT id FROM runs WHERE id=$1", [
                run.runId,
              ])
            ).rows,
          ).toEqual([]);
          expect(await messages(db)).toEqual([]);
          expect(await spending(db)).toEqual(originalSpend);
          const next = await prepare(db, "b");
          expect(await notices(db)).toEqual([]);
          expect(
            (await messages(db)).map((row) => [row.run_id, row.kind]),
          ).toEqual([[next.runId, "user_message"]]);
          await running(db, next);
          expect(await spending(db)).toEqual(originalSpend);
        });
      },
      duration,
    );

    it(
      "settles against the original UTC buckets and permits a separate warning in the current buckets",
      async () => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 7, monthly: 9 });
          const a = await prepare(db, "a");
          await a.events.startModelAttempt(start(a, 1));
          expect(await notices(db)).toEqual([]);
          // Model a still-owned call spanning a UTC month boundary without changing
          // the database clock or choosing buckets through the public attempt input.
          const original = (
            await db.observer.query<{ day_start: string; month_start: string }>(
              `UPDATE model_budget_reservations
           SET day_start=(date_trunc('month',day_start)-interval '1 day')::date,
               month_start=(date_trunc('month',day_start)-interval '1 month')::date
           WHERE run_id=$1 AND ordinal=1 RETURNING day_start::text,month_start::text`,
              [a.runId],
            )
          ).rows[0];
          if (original === undefined)
            throw new Error("Expected the original reservation buckets");
          await db.observer.query(
            `UPDATE organization_spend SET period_start=CASE period WHEN 'daily' THEN $2::date ELSE $3::date END
         WHERE organization_id=$1`,
            [organizationId, original.day_start, original.month_start],
          );
          await db.observer.query(
            `WITH captured AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS moment)
         INSERT INTO organization_spend(organization_id,period,period_start)
         SELECT $1,'daily',moment::date FROM captured
         UNION ALL SELECT $1,'monthly',date_trunc('month',moment)::date FROM captured`,
            [organizationId],
          );
          await a.events.finishModelAttempt(finish(a, 9));
          expectWarnings(await notices(db), { daily: 7, monthly: 9 });
          const settled = await spending(db);
          expect(settled).toHaveLength(4);
          for (const bucket of settled) {
            const originalStart =
              bucket.period === "daily"
                ? original.day_start
                : original.month_start;
            expect(bucket.cost_usd_micros).toBe(
              bucket.period_start === originalStart ? "9" : "0",
            );
            expect(bucket.reserved_cost_usd_micros).toBe("0");
          }
          const b = await prepare(db, "b");
          expect(await notices(db)).toHaveLength(2);
          await b.events.startModelAttempt(start(b, 9));
          const allWarnings = await notices(db);
          expect(allWarnings).toHaveLength(4);
          expectWarnings(
            allWarnings.filter((row) => row.run_id === a.runId),
            { daily: 7, monthly: 9 },
          );
          expectWarnings(
            allWarnings.filter((row) => row.run_id === b.runId),
            { daily: 7, monthly: 9 },
          );
          await running(db, a);
          await running(db, b);
        });
      },
      duration,
    );

    it(
      "uses the latest soft policy for new work while exact attempt replays do not rejudge a lowered policy",
      async () => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 100, monthly: 100 });
          const run = await prepare(db, "a");
          const originalStart = start(run, 2);
          const originalFinish = finish(run, 2);
          await run.events.startModelAttempt(originalStart);
          await run.events.finishModelAttempt(originalFinish);
          expect(await notices(db)).toEqual([]);
          await configure(db, { daily: 2, monthly: 2 }, 2);
          const beforeReplay = await db.snapshot();
          const originalSpend = await spending(db);
          await run.events.startModelAttempt(structuredClone(originalStart));
          await run.events.finishModelAttempt(structuredClone(originalFinish));
          expect(await db.snapshot()).toBe(beforeReplay);
          expect(await spending(db)).toEqual(originalSpend);
          expect(await notices(db)).toEqual([]);
          await run.events.startModelAttempt(start(run, 0, 2));
          const warnings = await notices(db);
          expectWarnings(warnings, { daily: 2, monthly: 2 });
          await run.events.finishModelAttempt(finish(run, 0, 2));
          expect(await notices(db)).toEqual(warnings);
          expect(await spending(db)).toEqual(originalSpend);
          await running(db, run);
        });
      },
      duration,
    );

    it.each(["malformed", "foreign_organization"] as const)(
      "rejects a %s period marker instead of silently treating its bucket as warned",
      async (corruption) => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 5 });
          const a = await prepare(db, "a");
          await a.events.startModelAttempt(start(a, 5));
          expectWarnings(await notices(db), { daily: 5 });
          const b = await prepare(db, "b");
          const row = (
            await db.observer.query<{
              warning_receipt: Record<string, unknown>;
            }>(
              "SELECT warning_receipt FROM organization_spend WHERE organization_id=$1 AND period='daily'",
              [organizationId],
            )
          ).rows[0];
          if (row === undefined)
            throw new Error("Expected the original warning marker");
          const changed =
            corruption === "malformed"
              ? {}
              : {
                  ...row.warning_receipt,
                  organizationId: "foreign-organization",
                };
          await db.observer.query(
            "UPDATE organization_spend SET warning_receipt=$2::jsonb WHERE organization_id=$1 AND period='daily'",
            [organizationId, JSON.stringify(changed)],
          );
          const before = await warningSnapshot(db);
          await expect(
            b.events.startModelAttempt(start(b, 0)),
          ).rejects.toThrow();
          expect(await warningSnapshot(db)).toEqual(before);
          expect(await notices(db)).toHaveLength(1);
        });
      },
      duration,
    );

    it.each(["start", "finish"] as const)(
      "rejects an emptied %s warning manifest on exact replay without changing original facts",
      async (source) => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 5 });
          const run = await prepare(db, "a");
          const originalStart = start(run, source === "start" ? 5 : 1);
          const started = await run.events.startModelAttempt(originalStart);
          const originalFinish = finish(run, 5);
          const receipt =
            source === "start"
              ? started
              : await run.events.finishModelAttempt(originalFinish);
          expect(receipt.warnings).toHaveLength(1);
          const originalWarnings = await notices(db);
          expectWarnings(originalWarnings, { daily: 5 });
          await db.observer.query(
            "UPDATE model_budget_reservations SET warning_receipts=jsonb_set(warning_receipts,ARRAY[$2::text],'[]'::jsonb) WHERE run_id=$1 AND ordinal=1",
            [run.runId, source],
          );
          const before = await warningSnapshot(db);
          const replay =
            source === "start"
              ? () =>
                  run.events.startModelAttempt(structuredClone(originalStart))
              : () =>
                  run.events.finishModelAttempt(
                    structuredClone(originalFinish),
                  );
          await expect(replay()).rejects.toThrow();
          expect(await warningSnapshot(db)).toEqual(before);
          expect(await notices(db)).toEqual(originalWarnings);
        });
      },
      duration,
    );

    it(
      "rolls back the reservation, hidden start, marker, message and sequence when the original notice INSERT fails",
      async () => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 5 });
          const run = await prepare(db, "a");
          const schema = (
            await db.observer.query<{ schema: string }>(
              "SELECT current_schema() AS schema",
            )
          ).rows[0]?.schema;
          if (
            schema === undefined ||
            !/^acp_run_fencing_[a-f0-9]{32}$/u.test(schema)
          )
            throw new Error(
              "Warning trigger requires the isolated fixture schema",
            );
          const originalStart = start(run, 5);
          const before = await warningSnapshot(db);
          try {
            await db.observer.query(`
          CREATE FUNCTION "${schema}".reject_budget_warning_write() RETURNS trigger
          LANGUAGE plpgsql AS $body$
          BEGIN
            IF NEW.kind='agent_message' AND NEW.context_excluded THEN
              RAISE EXCEPTION 'budget warning insert rollback sentinel';
            END IF;
            RETURN NEW;
          END;
          $body$`);
            await db.observer.query(`
          CREATE TRIGGER reject_budget_warning_write
          BEFORE INSERT ON "${schema}".session_messages FOR EACH ROW
          EXECUTE FUNCTION "${schema}".reject_budget_warning_write()`);
            await expect(
              run.events.startModelAttempt(originalStart),
            ).rejects.toThrow("budget warning insert rollback sentinel");
            expect(await warningSnapshot(db)).toEqual(before);
            expect(await notices(db)).toEqual([]);
            expect((await messages(db)).map((row) => row.kind)).toEqual([
              "user_message",
            ]);
            expect(
              (
                await db.observer.query(
                  "SELECT run_id FROM model_budget_reservations",
                )
              ).rows,
            ).toEqual([]);
            expect(
              (await db.observer.query("SELECT run_id FROM run_usage")).rows,
            ).toEqual([]);
            expect(
              (
                await db.observer.query(
                  "SELECT warning_receipt FROM organization_spend ORDER BY period",
                )
              ).rows,
            ).toEqual([{ warning_receipt: null }, { warning_receipt: null }]);
          } finally {
            await db.observer.query(
              `DROP TRIGGER IF EXISTS reject_budget_warning_write ON "${schema}".session_messages`,
            );
            await db.observer.query(
              `DROP FUNCTION IF EXISTS "${schema}".reject_budget_warning_write()`,
            );
          }
          await run.events.startModelAttempt(originalStart);
          expectWarnings(await notices(db), { daily: 5 });
          await running(db, run);
        });
      },
      duration,
    );

    it(
      "does not claim a warning or alter original facts after the owner's fence is lost",
      async () => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 5 });
          const run = await prepare(db, "a");
          await db.successor(run.owner);
          const before = await warningSnapshot(db);
          await expect(
            run.events.startModelAttempt(start(run, 5)),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await warningSnapshot(db)).toEqual(before);
          expect(await notices(db)).toEqual([]);
          expect(
            (
              await db.observer.query(
                "SELECT warning_receipt FROM organization_spend ORDER BY period",
              )
            ).rows,
          ).toEqual([{ warning_receipt: null }, { warning_receipt: null }]);
        });
      },
      duration,
    );

    it(
      "settles an original cancelled call without claiming a new soft warning",
      async () => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 5 });
          const run = await prepare(db, "a");
          const started = await run.events.startModelAttempt(start(run, 1));
          expect(started.warnings).toEqual([]);
          await run.runs.requestCancellation(run.runId, new Date());
          const receipt = await run.events.finishModelAttempt(finish(run, 5));
          expect(receipt.warnings).toEqual([]);
          expect(await notices(db)).toEqual([]);
          expect(
            (await spending(db)).map((row) => [
              row.cost_usd_micros,
              row.reserved_cost_usd_micros,
            ]),
          ).toEqual([
            ["5", "0"],
            ["5", "0"],
          ]);
          expect(
            (
              await db.observer.query(
                "SELECT warning_receipt FROM organization_spend ORDER BY period",
              )
            ).rows,
          ).toEqual([{ warning_receipt: null }, { warning_receipt: null }]);
        });
      },
      duration,
    );

    it(
      "admits at soft zero under allow while honestly retaining historical unknown cost",
      async () => {
        await withDatabase(async (db) => {
          await configure(db, { daily: 0 });
          await db.observer.query(
            "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{organization_budget,unknown_cost}',$2::jsonb) WHERE organization_id=$1",
            [organizationId, JSON.stringify("allow")],
          );
          await db.observer.query(
            "UPDATE model_budget_history SET complete_before_cutover=false,cutover_at=clock_timestamp()",
          );
          const run = await prepare(db, "a");
          const warnings = await notices(db);
          expectWarnings(warnings, { daily: 0 });
          expect(noticeText(warnings[0]!)).toMatch(/unknown/iu);
          expect(noticeText(warnings[0]!)).toMatch(/known.*reserved/iu);
          expect(noticeText(warnings[0]!)).toContain("USD microdollars");
          expect(
            (await spending(db)).map((row) => [
              row.cost_usd_micros,
              row.reserved_cost_usd_micros,
            ]),
          ).toEqual([
            ["0", "0"],
            ["0", "0"],
          ]);
          expect(
            (
              await db.observer.query(
                "SELECT warning_receipt->'unknownCost' AS unknown_cost FROM organization_spend WHERE period='daily'",
              )
            ).rows,
          ).toEqual([{ unknown_cost: true }]);
          expect(
            (
              await db.observer.query(
                "SELECT run_id FROM model_budget_reservations",
              )
            ).rows,
          ).toEqual([]);
          expect(
            (await db.observer.query("SELECT run_id FROM run_usage")).rows,
          ).toEqual([]);
          expect(
            (await messages(db)).filter((row) => row.kind === "model_attempt"),
          ).toEqual([]);
          await running(db, run);
        });
      },
      duration,
    );
  },
);
