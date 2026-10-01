import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";

import type { LearningTaskClaim } from "../../domain/learning-scan.js";
import type { PostgresKernel } from "./kernel.js";

type Action = "prepare" | "check" | "commit" | "observe" | "cancel" | "release";
type State = "pending" | "unknown" | "settled";
type Intent = {
  claim: LearningTaskClaim;
  requestId: string;
  action: Action;
  executionId: string;
  mcpEndpoint: string;
  bodySha256: string;
  requestFacts: Record<string, unknown>;
};
type SavedIntent = {
  request_id: string;
  task_id: string;
  claim_id: string;
  generation: number;
  action: Action;
  execution_id: string;
  mcp_endpoint: string;
  body_sha256: string;
  request_facts: Record<string, unknown>;
  state: State;
  receipt: Record<string, unknown> | null;
};

export class PostgresLearningMaintenanceLedger {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async reserve(input: Intent): Promise<{ dispatch: boolean; state: State }> {
    validateIntent(input);
    return this.kernel.transaction(async (client) => {
      const task = await client.query<{
        organization_id: string;
        agent_id: string;
        owner_principal_id: string;
        source_run_id: string;
        claim_id: string | null;
        generation: number;
        state: string;
      }>(
        `SELECT organization_id,agent_id,owner_principal_id,source_run_id,claim_id,generation,state
          FROM learning_tasks WHERE id=$1 FOR UPDATE`,
        [input.claim.taskId],
      );
      const current = task.rows[0];
      if (!current || !sameClaim(current, input.claim))
        throw new Error("Learning maintenance claim is unavailable");
      const existing = await client.query<SavedIntent>(
        "SELECT * FROM learning_maintenance_intents WHERE request_id=$1 FOR UPDATE",
        [input.requestId],
      );
      const saved = existing.rows[0];
      if (saved) {
        if (!matchesIntent(saved, input))
          throw new Error("Learning maintenance request conflicts with its durable intent");
        return {
          dispatch: ["observe", "release"].includes(saved.action) && saved.state === "unknown",
          state: saved.state,
        };
      }
      if (!actionAllowedInState(input.action, current.state))
        throw new Error("Learning maintenance action is not allowed in the task state");
      await client.query(
        `INSERT INTO learning_maintenance_intents
        (request_id,task_id,claim_id,generation,action,execution_id,mcp_endpoint,
         body_sha256,request_facts,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'pending')`,
        [
          input.requestId,
          input.claim.taskId,
          input.claim.claimId,
          input.claim.generation,
          input.action,
          input.executionId,
          input.mcpEndpoint,
          input.bodySha256,
          JSON.stringify(input.requestFacts),
        ],
      );
      return { dispatch: true, state: "pending" as const };
    });
  }

  public async markUnknown(claim: LearningTaskClaim, requestId: string): Promise<void> {
    await this.kernel.transaction(async (client) => {
      const saved = await this.lockClaimIntent(client, claim, requestId);
      if (saved.state === "pending")
        await client.query(
          "UPDATE learning_maintenance_intents SET state='unknown' WHERE request_id=$1",
          [requestId],
        );
    });
  }

  public async settle(
    claim: LearningTaskClaim,
    requestId: string,
    receipt: unknown,
  ): Promise<void> {
    await this.kernel.transaction(async (client) => {
      const saved = await this.lockClaimIntent(client, claim, requestId);
      const serialized = JSON.stringify(receipt) as string | undefined;
      if (
        !isRecord(receipt) ||
        serialized === undefined ||
        Buffer.byteLength(serialized) > 16 * 1024 ||
        Array.isArray(receipt) ||
        receipt.request_id !== requestId ||
        receipt.action !== saved.action ||
        receipt.execution_id !== saved.execution_id ||
        !validOutcome(saved.action, receipt.outcome)
      )
        throw new Error("Learning maintenance receipt does not match its intent");
      if (saved.state === "settled") {
        if (!isDeepStrictEqual(saved.receipt, receipt))
          throw new Error("Learning maintenance receipt conflicts with its settled outcome");
        return;
      }
      await client.query(
        `UPDATE learning_maintenance_intents
        SET state='settled',receipt=$2::jsonb,settled_at=now()
        WHERE request_id=$1`,
        [requestId, serialized],
      );
    });
  }

  public async reject(
    claim: LearningTaskClaim,
    requestId: string,
    rejection: { status: number; code: string },
  ): Promise<void> {
    if (
      !Number.isSafeInteger(rejection.status) ||
      rejection.status < 400 ||
      rejection.status > 499 ||
      [408, 429].includes(rejection.status) ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(rejection.code)
    )
      throw new Error("Invalid deterministic Runtime maintenance rejection");
    await this.kernel.transaction(async (client) => {
      const saved = await this.lockClaimIntent(client, claim, requestId);
      const receipt = {
        kind: "rejection",
        request_id: requestId,
        action: saved.action,
        execution_id: saved.execution_id,
        status: rejection.status,
        code: rejection.code,
      };
      if (saved.state === "settled") {
        if (!isDeepStrictEqual(saved.receipt, receipt))
          throw new Error("Learning maintenance rejection conflicts with its settled outcome");
        return;
      }
      await client.query(
        `UPDATE learning_maintenance_intents
        SET state='settled',receipt=$2::jsonb,settled_at=now()
        WHERE request_id=$1`,
        [requestId, JSON.stringify(receipt)],
      );
    });
  }

  public async settleObservedEffect(
    claim: LearningTaskClaim,
    effectRequestId: string,
    observationRequestId: string,
  ): Promise<"settled" | "unknown"> {
    if (effectRequestId === observationRequestId)
      throw new Error("An effect cannot observe its own request");
    return this.kernel.transaction(async (client) => {
      const effect = await this.lockClaimIntent(client, claim, effectRequestId);
      const observation = await this.lockClaimIntent(client, claim, observationRequestId);
      const expected = effect.action === "commit" ? effect.request_facts.target_digest : undefined;
      const receipt = observation.receipt;
      if (
        expected === undefined ||
        (expected !== null &&
          (typeof expected !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expected))) ||
        (effect.action === "commit" && expected === null) ||
        observation.action !== "observe" ||
        observation.state !== "settled" ||
        !isRecord(receipt) ||
        observation.request_facts.effect_request_id !== effectRequestId ||
        observation.request_facts.expected_target_digest !== expected ||
        receipt.request_id !== observationRequestId ||
        receipt.action !== "observe" ||
        receipt.execution_id !== observation.execution_id ||
        !["applied", "conflict", "unknown"].includes(String(receipt.outcome)) ||
        (receipt.observed_digest !== null &&
          (typeof receipt.observed_digest !== "string" ||
            !/^sha256:[0-9a-f]{64}$/u.test(receipt.observed_digest)))
      )
        throw new Error("Learning effect observation does not match its durable intent");
      if (receipt.outcome === "unknown") return "unknown";
      if (
        (receipt.outcome !== "applied" && receipt.outcome !== "conflict") ||
        (receipt.outcome === "applied" && receipt.observed_digest !== expected)
      )
        throw new Error("Learning effect observation outcome conflicts with its action");
      const result = {
        kind: "observed_effect",
        request_id: effectRequestId,
        action: effect.action,
        execution_id: effect.execution_id,
        observation_request_id: observationRequestId,
        outcome: receipt.outcome,
        observed_digest: receipt.observed_digest,
      };
      if (effect.state === "settled") {
        if (!isDeepStrictEqual(effect.receipt, result))
          throw new Error("Learning effect observation conflicts with a settled outcome");
        return "settled";
      }
      await client.query(
        `UPDATE learning_maintenance_intents
        SET state='settled',receipt=$2::jsonb,settled_at=now()
        WHERE request_id=$1`,
        [effectRequestId, JSON.stringify(result)],
      );
      return "settled";
    });
  }

  public async unresolved(claim: LearningTaskClaim): Promise<
    Array<{
      requestId: string;
      action: Action;
      executionId: string;
      mcpEndpoint: string;
      bodySha256: string;
      requestFacts: Record<string, unknown>;
      state: "pending" | "unknown";
    }>
  > {
    const result = await this.kernel.read<SavedIntent>(
      `SELECT intent.*
      FROM learning_maintenance_intents intent
      JOIN learning_tasks task ON task.id=intent.task_id
      WHERE intent.task_id=$1 AND intent.claim_id=$2 AND intent.generation=$3
        AND task.organization_id=$4 AND task.agent_id=$5 AND task.owner_principal_id=$6
        AND task.source_run_id=$7 AND intent.state<>'settled'
      ORDER BY intent.created_at,intent.request_id LIMIT 50`,
      [
        claim.taskId,
        claim.claimId,
        claim.generation,
        claim.organizationId,
        claim.agentId,
        claim.ownerId,
        claim.sourceRunId,
      ],
    );
    return result.rows.map((row) => {
      if (row.state === "settled")
        throw new Error("Settled maintenance intent appeared in unresolved list");
      return {
        requestId: row.request_id,
        action: row.action,
        executionId: row.execution_id,
        mcpEndpoint: row.mcp_endpoint,
        bodySha256: row.body_sha256,
        requestFacts: row.request_facts,
        state: row.state,
      };
    });
  }

  public async read(
    claim: LearningTaskClaim,
    requestId: string,
  ): Promise<{
    requestId: string;
    action: Action;
    executionId: string;
    mcpEndpoint: string;
    bodySha256: string;
    requestFacts: Record<string, unknown>;
    state: State;
    receipt: Record<string, unknown> | null;
  } | null> {
    const result = await this.kernel.read<SavedIntent>(
      `SELECT intent.*
      FROM learning_maintenance_intents intent
      JOIN learning_tasks task ON task.id=intent.task_id
      WHERE intent.request_id=$1 AND intent.task_id=$2 AND intent.claim_id=$3
        AND intent.generation=$4 AND task.organization_id=$5 AND task.agent_id=$6
        AND task.owner_principal_id=$7 AND task.source_run_id=$8`,
      [
        requestId,
        claim.taskId,
        claim.claimId,
        claim.generation,
        claim.organizationId,
        claim.agentId,
        claim.ownerId,
        claim.sourceRunId,
      ],
    );
    const saved = result.rows[0];
    return saved
      ? {
          requestId: saved.request_id,
          action: saved.action,
          executionId: saved.execution_id,
          mcpEndpoint: saved.mcp_endpoint,
          bodySha256: saved.body_sha256,
          requestFacts: saved.request_facts,
          state: saved.state,
          receipt: saved.receipt,
        }
      : null;
  }

  private async lockClaimIntent(
    client: PoolClient,
    claim: LearningTaskClaim,
    requestId: string,
  ): Promise<SavedIntent> {
    const result = await client.query<SavedIntent>(
      `SELECT intent.*
      FROM learning_maintenance_intents intent
      JOIN learning_tasks task ON task.id=intent.task_id
      WHERE intent.request_id=$1 AND intent.task_id=$2 AND intent.claim_id=$3
        AND intent.generation=$4 AND task.organization_id=$5 AND task.agent_id=$6
        AND task.owner_principal_id=$7 AND task.source_run_id=$8
      FOR UPDATE OF intent`,
      [
        requestId,
        claim.taskId,
        claim.claimId,
        claim.generation,
        claim.organizationId,
        claim.agentId,
        claim.ownerId,
        claim.sourceRunId,
      ],
    );
    const saved = result.rows[0];
    if (!saved) throw new Error("Learning maintenance intent is unavailable");
    return saved;
  }
}

function sameClaim(
  row: {
    organization_id: string;
    agent_id: string;
    owner_principal_id: string;
    source_run_id: string;
    claim_id: string | null;
    generation: number;
  },
  claim: LearningTaskClaim,
): boolean {
  return (
    row.organization_id === claim.organizationId &&
    row.agent_id === claim.agentId &&
    row.owner_principal_id === claim.ownerId &&
    row.claim_id === claim.claimId &&
    row.source_run_id === claim.sourceRunId &&
    row.generation === claim.generation
  );
}

function matchesIntent(saved: SavedIntent, input: Intent): boolean {
  return (
    saved.task_id === input.claim.taskId &&
    saved.claim_id === input.claim.claimId &&
    saved.generation === input.claim.generation &&
    saved.action === input.action &&
    saved.execution_id === input.executionId &&
    saved.mcp_endpoint === input.mcpEndpoint &&
    saved.body_sha256 === input.bodySha256 &&
    isDeepStrictEqual(saved.request_facts, input.requestFacts)
  );
}

function validateIntent(input: Intent): void {
  const url = new URL(input.mcpEndpoint);
  const facts = JSON.stringify(input.requestFacts) as string | undefined;
  if (
    !/^[!-~]{1,128}$/u.test(input.requestId) ||
    input.requestId.includes("/") ||
    input.requestId.includes("\\") ||
    !/^[!-~]{1,200}$/u.test(input.executionId) ||
    input.executionId.includes("/") ||
    input.executionId.includes("\\") ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.bodySha256) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/mcp" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    input.mcpEndpoint.length > 2048 ||
    facts === undefined ||
    Buffer.byteLength(facts) > 16 * 1024 ||
    Array.isArray(input.requestFacts) ||
    !isDeepStrictEqual(JSON.parse(facts), input.requestFacts) ||
    !["prepare", "check", "commit", "observe", "cancel", "release"].includes(input.action)
  )
    throw new Error("Invalid learning maintenance intent");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validOutcome(action: Action, value: unknown): boolean {
  const permitted: Record<Action, readonly string[]> = {
    prepare: ["prepared"],
    check: ["checked"],
    commit: ["applied", "blocked"],
    observe: ["applied", "conflict", "unknown"],
    cancel: ["cancelled"],
    release: ["released"],
  };
  return typeof value === "string" && permitted[action].includes(value);
}

function actionAllowedInState(action: Action, state: string): boolean {
  if (state === "running") return true;
  if (state === "paused") return ["observe", "cancel", "release"].includes(action);
  return (
    ["completed", "cancelled", "failed"].includes(state) && ["observe", "release"].includes(action)
  );
}
