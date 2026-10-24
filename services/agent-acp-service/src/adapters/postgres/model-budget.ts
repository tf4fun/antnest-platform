import type { PoolClient } from "pg";
import {
  chargeModelUsage,
  knownTokenCount,
  legacyOrganizationBudget,
  ModelBudgetExceededError,
  organizationBudgetSchema,
  priceTokenReservation,
  runBudgetSchema,
  type ModelReservation,
  type OrganizationBudget,
  type RunBudget,
} from "../../domain/model-budget.js";
import type { ModelPricing, ModelUsage } from "../../domain/usage.js";

type RunTotals = {
  input_tokens: string;
  output_tokens: string;
  cost_usd_micros: string;
  reserved_input_tokens: string;
  reserved_output_tokens: string;
  reserved_cost_usd_micros: string;
  unknown_input_attempts: string;
  unknown_output_attempts: string;
  unbounded_cost_attempts: string;
};
type PeriodTotals = {
  period: "daily" | "monthly";
  period_start: string;
  cost_usd_micros: string;
  reserved_cost_usd_micros: string;
  unbounded_cost_attempts: string;
};
type Reservation = {
  organization_id: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cost_usd_micros: string | null;
  cost_unknown: boolean;
  state: string;
  day_start: string;
  month_start: string;
};

export async function currentModelBudget(
  client: PoolClient,
  organizationId: string,
): Promise<OrganizationBudget> {
  const row = await client.query<{ budget: unknown }>(
    "SELECT configuration->'organization_budget' AS budget FROM execution_configurations WHERE organization_id=$1",
    [organizationId],
  );
  const budget = row.rows[0]?.budget;
  return budget === undefined || budget === null
    ? legacyOrganizationBudget
    : organizationBudgetSchema.parse(budget);
}

/** Caller holds org, current lease and the original Session/Run, in that order. */
export async function reserveModelBudget(
  client: PoolClient,
  input: {
    runId: string;
    ordinal: number;
    organizationId: string;
    agentId: string;
    runBudget?: RunBudget;
    reservation?: ModelReservation;
    pricing?: ModelPricing;
  },
): Promise<void> {
  const policy = await currentModelBudget(client, input.organizationId);
  const frozen = runBudgetSchema.parse(input.runBudget ?? {});
  const bounds = input.reservation ?? {};
  const tokensIn = knownTokenCount(bounds.inputTokens);
  const tokensOut = knownTokenCount(bounds.outputTokens);
  if (
    (bounds.inputTokens !== undefined && tokensIn === null) ||
    (bounds.outputTokens !== undefined && tokensOut === null)
  )
    throw new TypeError("Invalid model budget reservation");
  const cost = priceTokenReservation(bounds, input.pricing);
  if (cost === null && policy.unknown_cost === "deny")
    throw new ModelBudgetExceededError("unknown_cost", null, null);

  await client.query(
    "INSERT INTO run_usage(run_id,organization_id,agent_id) VALUES($1,$2,$3) ON CONFLICT(run_id) DO NOTHING",
    [input.runId, input.organizationId, input.agentId],
  );
  const totals = (
    await client.query<RunTotals>(
      "SELECT input_tokens::text,output_tokens::text,cost_usd_micros::text,reserved_input_tokens::text,reserved_output_tokens::text,reserved_cost_usd_micros::text,unknown_input_attempts::text,unknown_output_attempts::text,unbounded_cost_attempts::text FROM run_usage WHERE run_id=$1 AND organization_id=$2 AND agent_id=$3 FOR UPDATE",
      [input.runId, input.organizationId, input.agentId],
    )
  ).rows[0];
  if (totals === undefined) throw new Error("Model budget Run identity changed");
  limit(
    "run_input",
    minimum(frozen.max_input_tokens, policy.run_caps.max_input_tokens),
    BigInt(totals.input_tokens) + BigInt(totals.reserved_input_tokens),
    BigInt(totals.unknown_input_attempts) > 0n ? null : tokensIn,
  );
  limit(
    "run_output",
    minimum(frozen.max_output_tokens, policy.run_caps.max_output_tokens),
    BigInt(totals.output_tokens) + BigInt(totals.reserved_output_tokens),
    BigInt(totals.unknown_output_attempts) > 0n ? null : tokensOut,
  );
  limit(
    "run_cost",
    minimum(frozen.max_cost_usd_micros, policy.run_caps.max_cost_usd_micros),
    BigInt(totals.cost_usd_micros) + BigInt(totals.reserved_cost_usd_micros),
    policy.unknown_cost === "deny" && BigInt(totals.unbounded_cost_attempts) > 0n
      ? null
      : (cost ?? 0n),
  );
  const period = (
    await client.query<{ day_start: string; month_start: string }>(
      "SELECT moment::date::text AS day_start,date_trunc('month',moment)::date::text AS month_start FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS moment) AS captured",
    )
  ).rows[0];
  if (period === undefined) throw new Error("Model budget clock is unavailable");
  await client.query(
    "INSERT INTO organization_spend(organization_id,period,period_start) VALUES($1,'daily',$2::date),($1,'monthly',$3::date) ON CONFLICT DO NOTHING",
    [input.organizationId, period.day_start, period.month_start],
  );
  const buckets = await client.query<PeriodTotals>(
    "SELECT period,period_start::text,cost_usd_micros::text,reserved_cost_usd_micros::text,unbounded_cost_attempts::text FROM organization_spend WHERE organization_id=$1 AND ((period='daily' AND period_start=$2::date) OR (period='monthly' AND period_start=$3::date)) ORDER BY period FOR UPDATE",
    [input.organizationId, period.day_start, period.month_start],
  );
  if (buckets.rows.length !== 2) throw new Error("Model budget periods are incomplete");
  for (const bucket of buckets.rows)
    limit(
      bucket.period === "daily" ? "organization_daily" : "organization_monthly",
      policy[bucket.period].hard_cost_usd_micros,
      BigInt(bucket.cost_usd_micros) + BigInt(bucket.reserved_cost_usd_micros),
      policy.unknown_cost === "deny" && BigInt(bucket.unbounded_cost_attempts) > 0n
        ? null
        : (cost ?? 0n),
    );
  await client.query(
    `INSERT INTO model_budget_reservations(run_id,ordinal,organization_id,agent_id,policy_revision,input_tokens,output_tokens,cost_usd_micros,state,cost_unknown,day_start,month_start)
     VALUES($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,'reserved',$9,$10::date,$11::date)`,
    [
      input.runId,
      input.ordinal,
      input.organizationId,
      input.agentId,
      policy.revision,
      text(tokensIn),
      text(tokensOut),
      text(cost),
      cost === null,
      period.day_start,
      period.month_start,
    ],
  );
  await client.query(
    "UPDATE run_usage SET reserved_input_tokens=reserved_input_tokens+$2::numeric,reserved_output_tokens=reserved_output_tokens+$3::numeric,reserved_cost_usd_micros=reserved_cost_usd_micros+$4::numeric,unknown_attempts=unknown_attempts+$5,unbounded_cost_attempts=unbounded_cost_attempts+$5,unknown_input_attempts=unknown_input_attempts+$6,unknown_output_attempts=unknown_output_attempts+$7 WHERE run_id=$1",
    [
      input.runId,
      text(tokensIn ?? 0n),
      text(tokensOut ?? 0n),
      text(cost ?? 0n),
      cost === null ? 1 : 0,
      tokensIn === null ? 1 : 0,
      tokensOut === null ? 1 : 0,
    ],
  );
  await client.query(
    "UPDATE organization_spend SET reserved_cost_usd_micros=reserved_cost_usd_micros+$4::numeric,unknown_attempts=unknown_attempts+$5,unbounded_cost_attempts=unbounded_cost_attempts+$5 WHERE organization_id=$1 AND ((period='daily' AND period_start=$2::date) OR (period='monthly' AND period_start=$3::date))",
    [
      input.organizationId,
      period.day_start,
      period.month_start,
      text(cost ?? 0n),
      cost === null ? 1 : 0,
    ],
  );
}

/** Called in the same transaction as the original hidden finish and usage receipt. */
export async function settleModelBudget(
  client: PoolClient,
  input: {
    runId: string;
    ordinal: number;
    organizationId: string;
    usage: ModelUsage;
    pricing?: ModelPricing;
  },
): Promise<void> {
  const reservation = (
    await client.query<Reservation>(
      "SELECT organization_id,input_tokens::text,output_tokens::text,cost_usd_micros::text,cost_unknown,state,day_start::text,month_start::text FROM model_budget_reservations WHERE run_id=$1 AND ordinal=$2 FOR UPDATE",
      [input.runId, input.ordinal],
    )
  ).rows[0];
  if (
    reservation === undefined ||
    reservation.organization_id !== input.organizationId ||
    reservation.state !== "reserved"
  )
    throw new Error("Original model budget reservation is unavailable");
  const tokensIn = knownTokenCount(input.usage.inputTokens);
  const tokensOut = knownTokenCount(input.usage.outputTokens);
  const cost = chargeModelUsage(input.usage, input.pricing);
  const unknownDelta = Number(cost === null) - Number(reservation.cost_unknown);
  const resolvedUnboundedCost = reservation.cost_usd_micros === null && cost !== null ? 1 : 0;
  const releaseIn = tokensIn === null ? "0" : (reservation.input_tokens ?? "0");
  const releaseOut = tokensOut === null ? "0" : (reservation.output_tokens ?? "0");
  const releaseCost = cost === null ? "0" : (reservation.cost_usd_micros ?? "0");
  const updated = await client.query(
    `UPDATE run_usage SET input_tokens=input_tokens+$2::numeric,output_tokens=output_tokens+$3::numeric,cost_usd_micros=cost_usd_micros+$4::numeric,
     reserved_input_tokens=reserved_input_tokens-$5::numeric,reserved_output_tokens=reserved_output_tokens-$6::numeric,reserved_cost_usd_micros=reserved_cost_usd_micros-$7::numeric,unknown_attempts=unknown_attempts+$8,
     unknown_input_attempts=unknown_input_attempts-$10,unknown_output_attempts=unknown_output_attempts-$11,unbounded_cost_attempts=unbounded_cost_attempts-$12
     WHERE run_id=$1 AND organization_id=$9`,
    [
      input.runId,
      text(tokensIn ?? 0n),
      text(tokensOut ?? 0n),
      text(cost ?? 0n),
      releaseIn,
      releaseOut,
      releaseCost,
      unknownDelta,
      input.organizationId,
      reservation.input_tokens === null && tokensIn !== null ? 1 : 0,
      reservation.output_tokens === null && tokensOut !== null ? 1 : 0,
      resolvedUnboundedCost,
    ],
  );
  if (updated.rowCount !== 1) throw new Error("Model usage ledger is unavailable");
  const buckets = await client.query(
    "UPDATE organization_spend SET cost_usd_micros=cost_usd_micros+$4::numeric,reserved_cost_usd_micros=reserved_cost_usd_micros-$5::numeric,unknown_attempts=unknown_attempts+$6,unbounded_cost_attempts=unbounded_cost_attempts-$7 WHERE organization_id=$1 AND ((period='daily' AND period_start=$2::date) OR (period='monthly' AND period_start=$3::date))",
    [
      input.organizationId,
      reservation.day_start,
      reservation.month_start,
      text(cost ?? 0n),
      releaseCost,
      unknownDelta,
      resolvedUnboundedCost,
    ],
  );
  if (buckets.rowCount !== 2) throw new Error("Original model budget periods are unavailable");
  await client.query(
    "UPDATE model_budget_reservations SET state=$3,cost_unknown=$4,settled_at=clock_timestamp() WHERE run_id=$1 AND ordinal=$2",
    [
      input.runId,
      input.ordinal,
      tokensIn === null || tokensOut === null || cost === null ? "unresolved" : "settled",
      cost === null,
    ],
  );
}

function minimum(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined ? right : right === undefined ? left : Math.min(left, right);
}

function limit(
  scope: ModelBudgetExceededError["scope"],
  cap: number | undefined,
  used: bigint,
  additional: bigint | null,
): void {
  if (cap !== undefined && (additional === null || used + additional > BigInt(cap)))
    throw new ModelBudgetExceededError(scope, cap.toString(), used.toString());
}

function text(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}
