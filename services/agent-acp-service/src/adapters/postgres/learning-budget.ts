import { isDeepStrictEqual } from "node:util";

import type { LearningTaskClaim } from "../../domain/learning-scan.js";
import { learningPolicySchema, type LearningPolicy } from "../../domain/learning-policy.js";
import type { ModelCallBudget } from "../../domain/learning-budget.js";
import type { LearningReviewDecision } from "../../domain/learning-review-proposal.js";
import type { PostgresKernel } from "./kernel.js";

export type { ModelCallBudget } from "../../domain/learning-budget.js";

type TaskRow = {
  organization_id: string;
  agent_id: string;
  owner_principal_id: string;
  state: string;
  claim_id: string | null;
  generation: number;
  model_calls: number;
  frozen_policy: unknown;
};

type CallRow = {
  call_index: number;
  request_id: string;
  claim_id: string;
  generation: number;
  reserved_input_tokens: number;
  reserved_output_tokens: number;
  reserved_duration_ms: number;
  state: "reserved" | "settled" | "unknown";
  actual_input_tokens: number | null;
  actual_output_tokens: number | null;
  actual_duration_ms: number | null;
  review_decision: unknown;
};

const MAX_INPUT = 16_000;
const MAX_OUTPUT = 4_000;
const MAX_TIME_MS = 90_000;

export class PostgresLearningBudget {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async reserve(
    claim: LearningTaskClaim,
    currentPolicy: LearningPolicy,
    requestId: string,
    budget: ModelCallBudget,
  ): Promise<{ callIndex: number; state: CallRow["state"]; dispatch: boolean }> {
    checkRequestId(requestId);
    checkReservation(budget);
    return this.kernel.transaction(async (client) => {
      const result = await client.query<TaskRow>(
        `SELECT organization_id,agent_id,owner_principal_id,state,claim_id,generation,
                model_calls,frozen_policy
         FROM learning_tasks WHERE id=$1 FOR UPDATE`,
        [claim.taskId],
      );
      const task = result.rows[0];
      if (task === undefined || !sameScope(task, claim))
        throw new Error("Learning budget task scope is unavailable");
      const existing = await client.query<CallRow>(
        "SELECT * FROM learning_model_calls WHERE task_id=$1 AND request_id=$2",
        [claim.taskId, requestId],
      );
      if (existing.rows[0] !== undefined) {
        const call = existing.rows[0];
        if (!sameClaim(call, claim) || !sameBudget(call, budget))
          throw new Error("Learning model request receipt conflict");
        return { callIndex: call.call_index, state: call.state, dispatch: false };
      }
      if (
        task.state !== "running" ||
        task.claim_id !== claim.claimId ||
        task.generation !== claim.generation ||
        task.model_calls >= 2
      )
        throw new Error("Learning model call is not admitted");
      const policy = learningPolicySchema.parse(task.frozen_policy);
      const current = learningPolicySchema.parse(currentPolicy);
      if (
        policy.mode !== "automatic" ||
        current.mode !== "automatic" ||
        policy.organization_id !== claim.organizationId ||
        policy.agent_id !== claim.agentId ||
        policy.owner_principal_id !== claim.ownerId ||
        !isDeepStrictEqual(current, policy)
      )
        throw new Error("Learning model call policy changed or is invalid");
      const totals = await client.query<{
        input_tokens: number;
        output_tokens: number;
        duration_ms: number;
        in_flight: boolean;
      }>(
        `SELECT COALESCE(sum(CASE WHEN state='settled'
                  THEN actual_input_tokens ELSE reserved_input_tokens END),0)::integer AS input_tokens,
                COALESCE(sum(CASE WHEN state='settled'
                  THEN actual_output_tokens ELSE reserved_output_tokens END),0)::integer AS output_tokens,
                COALESCE(sum(CASE WHEN state='settled'
                  THEN actual_duration_ms ELSE reserved_duration_ms END),0)::integer AS duration_ms,
                COALESCE(bool_or(state<>'settled'),false) AS in_flight
         FROM learning_model_calls WHERE task_id=$1`,
        [claim.taskId],
      );
      const used = totals.rows[0]!;
      if (
        used.in_flight ||
        used.input_tokens + budget.inputTokens > MAX_INPUT ||
        used.output_tokens + budget.outputTokens > MAX_OUTPUT ||
        used.duration_ms + budget.durationMs > MAX_TIME_MS
      )
        throw new Error("Learning model call budget is exhausted or unresolved");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [2_026_092_903]);
      const booked = await client.query<{ at: string }>("SELECT clock_timestamp()::text AS at");
      const bookingAt = booked.rows[0]!.at;
      const daily = await client.query<{ input_tokens: string; output_tokens: string }>(
        `SELECT COALESCE(sum(CASE WHEN call.state='settled'
                  THEN call.actual_input_tokens ELSE call.reserved_input_tokens END),0)::text
                  AS input_tokens,
                COALESCE(sum(CASE WHEN call.state='settled'
                  THEN call.actual_output_tokens ELSE call.reserved_output_tokens END),0)::text
                  AS output_tokens
         FROM learning_model_calls call JOIN learning_tasks spent ON spent.id=call.task_id
         WHERE spent.organization_id=$1 AND spent.agent_id=$2
           AND call.created_at >=
             (date_trunc('day',$3::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
           AND call.created_at <
             (date_trunc('day',$3::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
               + interval '1 day'`,
        [claim.organizationId, claim.agentId, bookingAt],
      );
      const dailyInput = Number(daily.rows[0]!.input_tokens);
      const dailyOutput = Number(daily.rows[0]!.output_tokens);
      if (
        !Number.isSafeInteger(dailyInput) ||
        !Number.isSafeInteger(dailyOutput) ||
        dailyInput + budget.inputTokens > policy.limits.daily_model_input_tokens ||
        dailyOutput + budget.outputTokens > policy.limits.daily_model_output_tokens
      )
        throw new Error("Learning Agent daily model budget is exhausted");
      const callIndex = task.model_calls + 1;
      await client.query(
        `INSERT INTO learning_model_calls
          (task_id,call_index,request_id,claim_id,generation,reserved_input_tokens,
           reserved_output_tokens,reserved_duration_ms,state,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9)`,
        [
          claim.taskId,
          callIndex,
          requestId,
          claim.claimId,
          claim.generation,
          budget.inputTokens,
          budget.outputTokens,
          budget.durationMs,
          bookingAt,
        ],
      );
      await client.query(
        "UPDATE learning_tasks SET model_calls=model_calls+1,updated_at=now() WHERE id=$1",
        [claim.taskId],
      );
      return { callIndex, state: "reserved", dispatch: true };
    });
  }

  public async settle(
    claim: LearningTaskClaim,
    requestId: string,
    actual: ModelCallBudget,
  ): Promise<void> {
    return this.settleInternal(claim, requestId, actual);
  }

  public async settleReview(
    claim: LearningTaskClaim,
    requestId: string,
    actual: ModelCallBudget,
    decision: LearningReviewDecision,
  ): Promise<void> {
    const serialized = JSON.stringify(decision);
    if (Buffer.byteLength(serialized) > 24 * 1024)
      throw new Error("Invalid learning review decision");
    return this.settleInternal(claim, requestId, actual, serialized);
  }

  public async readReview(claim: LearningTaskClaim, requestId: string): Promise<unknown> {
    checkRequestId(requestId);
    const result = await this.kernel.read<
      Pick<TaskRow, "organization_id" | "agent_id" | "owner_principal_id"> &
        Pick<CallRow, "claim_id" | "generation" | "state" | "review_decision">
    >(
      `SELECT task.organization_id,task.agent_id,task.owner_principal_id,
              call.claim_id,call.generation,call.state,call.review_decision
       FROM learning_model_calls call JOIN learning_tasks task ON task.id=call.task_id
       WHERE call.task_id=$1 AND call.request_id=$2`,
      [claim.taskId, requestId],
    );
    const row = result.rows[0];
    if (row === undefined || !sameScope(row, claim) || !sameClaim(row, claim))
      throw new Error("Learning model request is unavailable");
    return row.state === "settled" ? row.review_decision : null;
  }

  public async markUnknown(claim: LearningTaskClaim, requestId: string): Promise<void> {
    checkRequestId(requestId);
    await this.kernel.transaction(async (client) => {
      const result = await client.query<
        Pick<TaskRow, "organization_id" | "agent_id" | "owner_principal_id"> &
          Pick<CallRow, "claim_id" | "generation" | "state">
      >(
        `SELECT task.organization_id,task.agent_id,task.owner_principal_id,
                call.claim_id,call.generation,call.state
         FROM learning_model_calls call JOIN learning_tasks task ON task.id=call.task_id
         WHERE call.task_id=$1 AND call.request_id=$2 FOR UPDATE OF call`,
        [claim.taskId, requestId],
      );
      const row = result.rows[0];
      if (row === undefined || !sameScope(row, claim) || !sameClaim(row, claim))
        throw new Error("Learning model request is unavailable");
      if (row.state === "settled")
        throw new Error("Settled learning model usage cannot become unknown");
      if (row.state === "reserved")
        await client.query(
          "UPDATE learning_model_calls SET state='unknown' WHERE task_id=$1 AND request_id=$2",
          [claim.taskId, requestId],
        );
    });
  }

  private async settleInternal(
    claim: LearningTaskClaim,
    requestId: string,
    actual: ModelCallBudget,
    decisionJson?: string,
  ): Promise<void> {
    checkRequestId(requestId);
    for (const value of [actual.inputTokens, actual.outputTokens, actual.durationMs])
      if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)
        throw new Error("Invalid actual learning model usage");
    await this.kernel.transaction(async (client) => {
      const taskResult = await client.query<TaskRow>(
        `SELECT organization_id,agent_id,owner_principal_id,state,claim_id,generation,
                model_calls,frozen_policy
         FROM learning_tasks WHERE id=$1 FOR UPDATE`,
        [claim.taskId],
      );
      if (taskResult.rows[0] === undefined || !sameScope(taskResult.rows[0], claim))
        throw new Error("Learning budget task scope is unavailable");
      const result = await client.query<CallRow>(
        "SELECT * FROM learning_model_calls WHERE task_id=$1 AND request_id=$2 FOR UPDATE",
        [claim.taskId, requestId],
      );
      const call = result.rows[0];
      if (call === undefined || !sameClaim(call, claim))
        throw new Error("Learning model request is unavailable");
      if (call.state === "settled") {
        if (
          call.actual_input_tokens !== actual.inputTokens ||
          call.actual_output_tokens !== actual.outputTokens ||
          call.actual_duration_ms !== actual.durationMs ||
          !isDeepStrictEqual(
            call.review_decision,
            decisionJson === undefined ? null : JSON.parse(decisionJson),
          )
        )
          throw new Error("Learning model usage receipt conflict");
        return;
      }
      await client.query(
        `UPDATE learning_model_calls
         SET state='settled',actual_input_tokens=$3,actual_output_tokens=$4,
             actual_duration_ms=$5,review_decision=$6::jsonb,settled_at=now()
         WHERE task_id=$1 AND request_id=$2`,
        [
          claim.taskId,
          requestId,
          actual.inputTokens,
          actual.outputTokens,
          actual.durationMs,
          decisionJson ?? null,
        ],
      );
      await client.query(
        `UPDATE learning_tasks
         SET input_tokens=input_tokens+$2,output_tokens=output_tokens+$3,
             model_time_ms=model_time_ms+$4,updated_at=now()
         WHERE id=$1`,
        [claim.taskId, actual.inputTokens, actual.outputTokens, actual.durationMs],
      );
    });
  }
}

function checkRequestId(requestId: string): void {
  if (!/^[!-~]{1,128}$/u.test(requestId)) throw new Error("Invalid learning model request ID");
}

function checkReservation(budget: ModelCallBudget): void {
  for (const [value, maximum] of [
    [budget.inputTokens, MAX_INPUT],
    [budget.outputTokens, MAX_OUTPUT],
    [budget.durationMs, MAX_TIME_MS],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error("Invalid learning model reservation");
}

function sameScope(
  task: Pick<TaskRow, "organization_id" | "agent_id" | "owner_principal_id">,
  claim: LearningTaskClaim,
): boolean {
  return (
    task.organization_id === claim.organizationId &&
    task.agent_id === claim.agentId &&
    task.owner_principal_id === claim.ownerId
  );
}

function sameClaim(
  call: Pick<CallRow, "claim_id" | "generation">,
  claim: LearningTaskClaim,
): boolean {
  return call.claim_id === claim.claimId && call.generation === claim.generation;
}

function sameBudget(call: CallRow, budget: ModelCallBudget): boolean {
  return (
    call.reserved_input_tokens === budget.inputTokens &&
    call.reserved_output_tokens === budget.outputTokens &&
    call.reserved_duration_ms === budget.durationMs
  );
}
