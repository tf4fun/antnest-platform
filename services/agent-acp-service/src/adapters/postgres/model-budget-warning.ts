import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { deriveResourceId } from "../../domain/resource-id.js";
import {
  budgetWarningFactSchema,
  budgetWarningNotice,
  type BudgetWarningNotice,
} from "../../domain/model-budget-warning.js";
import { currentModelBudget } from "./model-budget.js";
import { encodeSessionEvent } from "./session-event-codec.js";

type Source = "admission" | "start" | "finish";
type Input = { runId: string; source: Source; ordinal?: number; createdAt: Date };
const receiptSchema = budgetWarningFactSchema.extend({
  organizationId: z.string().min(1),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  source: z.enum(["admission", "start", "finish"]),
  ordinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  createdAt: z.iso.datetime(),
});
const receiptsSchema = z.array(receiptSchema).max(2);
type Receipt = z.infer<typeof receiptSchema>;
type Periods = { day_start: string; month_start: string };
type Run = {
  session_id: string;
  organization_id: string;
  state: string;
  cancel_requested_at: Date | null;
};
type Bucket = {
  period: "daily" | "monthly";
  period_start: string;
  cost_usd_micros: string;
  reserved_cost_usd_micros: string;
  unknown_attempts: string;
  coverage_complete: boolean;
  warning_receipt: unknown;
};

/** Caller owns the original organization -> lease -> Session/Run transaction.
 * Append after its Prompt/start/finish/usage rows, never through another writer.
 */
export async function appendModelBudgetWarnings(
  client: PoolClient,
  input: Input,
): Promise<BudgetWarningNotice[]> {
  if ((input.source === "admission") !== (input.ordinal === undefined))
    throw new Error("Budget warning source is inconsistent");
  const run = required(
    (
      await client.query<Run>(
        "SELECT session_id,organization_id,state,cancel_requested_at FROM runs WHERE id=$1",
        [input.runId],
      )
    ).rows[0],
  );
  if (run.state !== "running") throw new Error("Budget warning requires an accepted Run");
  const receipts: Receipt[] = [];
  const notices: BudgetWarningNotice[] = [];
  const policy = await currentModelBudget(client, run.organization_id);
  if (
    run.cancel_requested_at === null &&
    (policy.daily.soft_cost_usd_micros !== undefined ||
      policy.monthly.soft_cost_usd_micros !== undefined)
  ) {
    const periods =
      input.source === "admission"
        ? required(
            (
              await client.query<Periods>(
                "SELECT moment::date::text AS day_start,date_trunc('month',moment)::date::text AS month_start FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS moment) captured",
              )
            ).rows[0],
          )
        : required(
            (
              await client.query<Periods>(
                "SELECT day_start::text,month_start::text FROM model_budget_reservations WHERE run_id=$1 AND ordinal=$2 AND organization_id=$3",
                [input.runId, input.ordinal, run.organization_id],
              )
            ).rows[0],
          );
    await client.query(
      "INSERT INTO organization_spend(organization_id,period,period_start) VALUES($1,'daily',$2::date),($1,'monthly',$3::date) ON CONFLICT DO NOTHING",
      [run.organization_id, periods.day_start, periods.month_start],
    );
    const buckets = await client.query<Bucket>(
      `SELECT spend.period,spend.period_start::text,spend.cost_usd_micros::text,
       spend.reserved_cost_usd_micros::text,spend.unknown_attempts::text,spend.warning_receipt,
       history.complete_before_cutover OR spend.period_start >= CASE spend.period
         WHEN 'daily' THEN (history.cutover_at AT TIME ZONE 'UTC')::date+1
         ELSE (date_trunc('month',history.cutover_at AT TIME ZONE 'UTC')+interval '1 month')::date
       END AS coverage_complete
       FROM organization_spend spend CROSS JOIN model_budget_history history
       WHERE spend.organization_id=$1 AND ((spend.period='daily' AND spend.period_start=$2::date)
         OR (spend.period='monthly' AND spend.period_start=$3::date))
       ORDER BY spend.period FOR UPDATE OF spend`,
      [run.organization_id, periods.day_start, periods.month_start],
    );
    if (buckets.rows.length !== 2) throw new Error("Budget warning periods are unavailable");
    for (const bucket of buckets.rows) {
      if (bucket.warning_receipt !== null) {
        storedReceipt(bucket, run.organization_id);
        continue;
      }
      const limit = policy[bucket.period].soft_cost_usd_micros;
      const used = BigInt(bucket.cost_usd_micros) + BigInt(bucket.reserved_cost_usd_micros);
      if (limit === undefined || used < BigInt(limit)) continue;
      const receipt = receiptSchema.parse({
        scope: bucket.period === "daily" ? "organization_daily" : "organization_monthly",
        periodStart: bucket.period_start,
        limit: limit.toString(),
        used: used.toString(),
        unknownCost: !bucket.coverage_complete || BigInt(bucket.unknown_attempts) > 0n,
        organizationId: run.organization_id,
        runId: input.runId,
        sessionId: run.session_id,
        source: input.source,
        ordinal: input.ordinal ?? null,
        createdAt: input.createdAt.toISOString(),
      });
      const claimed = await client.query(
        "UPDATE organization_spend SET warning_receipt=$4::jsonb WHERE organization_id=$1 AND period=$2 AND period_start=$3::date AND warning_receipt IS NULL",
        [run.organization_id, bucket.period, bucket.period_start, JSON.stringify(receipt)],
      );
      if (claimed.rowCount !== 1)
        throw new Error("Budget warning claim changed within its organization transaction");
      const notice = fromReceipt(receipt);
      // Read the sequence after the owning operation's original rows. Updating
      // here and inserting the notice share its transaction and rollback.
      const sequence = required(
        (
          await client.query<{ sequence: string }>(
            "UPDATE acp_sessions SET last_message_sequence=last_message_sequence+1,updated_at=$2 WHERE id=$1 RETURNING last_message_sequence::text AS sequence",
            [run.session_id, input.createdAt],
          )
        ).rows[0],
      ).sequence;
      await client.query(
        `INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,context_excluded,payload,created_at)
         VALUES($1,$2,$3,$4::bigint,'agent_message',true,true,$5::jsonb,$6)`,
        [
          notice.messageId,
          run.session_id,
          input.runId,
          sequence,
          JSON.stringify(encodeSessionEvent(notice)),
          input.createdAt,
        ],
      );
      receipts.push(receipt);
      notices.push(notice);
    }
  }
  if (input.source !== "admission") {
    const saved = await client.query(
      "UPDATE model_budget_reservations SET warning_receipts=jsonb_set(warning_receipts,ARRAY[$3::text],$4::jsonb) WHERE run_id=$1 AND ordinal=$2 AND organization_id=$5",
      [input.runId, input.ordinal, input.source, JSON.stringify(receipts), run.organization_id],
    );
    if (saved.rowCount !== 1) throw new Error("Original budget warning receipt is unavailable");
  }
  return notices;
}

/** Exact replay reads only the original manifest and matching durable messages. */
export async function storedModelBudgetWarnings(
  client: PoolClient,
  input: {
    runId: string;
    sessionId: string;
    organizationId: string;
    ordinal: number;
    source: "start" | "finish";
  },
): Promise<BudgetWarningNotice[]> {
  const row = required(
    (
      await client.query<Periods & { receipts: unknown }>(
        "SELECT day_start::text,month_start::text,warning_receipts->$3::text AS receipts FROM model_budget_reservations WHERE run_id=$1 AND ordinal=$2 AND organization_id=$4",
        [input.runId, input.ordinal, input.source, input.organizationId],
      )
    ).rows[0],
  );
  const receipts = receiptsSchema.parse(row.receipts);
  const buckets = await client.query<Pick<Bucket, "period" | "period_start" | "warning_receipt">>(
    `SELECT period,period_start::text,warning_receipt FROM organization_spend
     WHERE organization_id=$1 AND ((period='daily' AND period_start=$2::date)
       OR (period='monthly' AND period_start=$3::date)) ORDER BY period`,
    [input.organizationId, row.day_start, row.month_start],
  );
  if (buckets.rows.length !== 2) throw new Error("Original budget warning periods are unavailable");
  const originalReceipts: Receipt[] = [];
  for (const bucket of buckets.rows) {
    if (bucket.warning_receipt === null) continue;
    const receipt = storedReceipt(bucket, input.organizationId);
    if (
      receipt.runId === input.runId &&
      receipt.sessionId === input.sessionId &&
      receipt.source === input.source &&
      receipt.ordinal === input.ordinal
    )
      originalReceipts.push(receipt);
  }
  if (!isDeepStrictEqual(receipts, originalReceipts))
    throw new Error("Original budget warning manifest is incomplete or changed");
  const notices: BudgetWarningNotice[] = [];
  const seen = new Set<string>();
  for (const receipt of receipts) {
    const period = receipt.scope === "organization_daily" ? "daily" : "monthly";
    if (
      receipt.runId !== input.runId ||
      receipt.sessionId !== input.sessionId ||
      receipt.organizationId !== input.organizationId ||
      receipt.source !== input.source ||
      receipt.ordinal !== input.ordinal ||
      receipt.periodStart !== (period === "daily" ? row.day_start : row.month_start) ||
      seen.has(period)
    )
      throw new Error("Budget warning receipt identity conflict");
    seen.add(period);
    const notice = fromReceipt(receipt);
    const original = await client.query(
      `SELECT m.id FROM session_messages m JOIN organization_spend spend
         ON spend.organization_id=$4 AND spend.period=$5 AND spend.period_start=$6::date
       WHERE m.id=$1 AND m.run_id=$2 AND m.session_id=$3
         AND m.kind='agent_message' AND m.visible AND m.context_excluded
         AND m.payload=$7::jsonb AND m.created_at=$8::timestamptz
         AND spend.warning_receipt=$9::jsonb`,
      [
        notice.messageId,
        input.runId,
        input.sessionId,
        input.organizationId,
        period,
        receipt.periodStart,
        JSON.stringify(encodeSessionEvent(notice)),
        receipt.createdAt,
        JSON.stringify(receipt),
      ],
    );
    if (original.rowCount !== 1) throw new Error("Original budget warning message is unavailable");
    notices.push(notice);
  }
  return notices;
}

function storedReceipt(
  bucket: Pick<Bucket, "period" | "period_start" | "warning_receipt">,
  organizationId: string,
): Receipt {
  const receipt = receiptSchema.parse(bucket.warning_receipt);
  if (
    receipt.organizationId !== organizationId ||
    receipt.scope !== (bucket.period === "daily" ? "organization_daily" : "organization_monthly") ||
    receipt.periodStart !== bucket.period_start ||
    (receipt.source === "admission") !== (receipt.ordinal === null)
  )
    throw new Error("Budget warning period marker identity conflict");
  // Markers outlive purged Runs/Sessions; validate their own identity without
  // reacquiring another Session's lock or requiring its deleted message.
  return receipt;
}

function fromReceipt(receipt: Receipt): BudgetWarningNotice {
  const messageId = deriveResourceId(
    "message",
    "model-budget-warning",
    JSON.stringify([receipt.organizationId, receipt.scope, receipt.periodStart]),
  );
  return budgetWarningNotice(messageId, {
    scope: receipt.scope,
    periodStart: receipt.periodStart,
    limit: receipt.limit,
    used: receipt.used,
    unknownCost: receipt.unknownCost,
  });
}

function required<T>(row: T | undefined): T {
  if (row === undefined) throw new Error("Original budget warning facts are unavailable");
  return row;
}
