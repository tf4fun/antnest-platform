import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";

import type { LearningTaskClaim } from "../../domain/learning-scan.js";
import {
  runtimeConnectionIdSchema,
  runtimeRevisionSchema,
  runtimeMcpEndpointSchema,
} from "../../domain/runtime-connection.js";
import type { PostgresKernel } from "./kernel.js";

type Action = "install";
type State = "pending" | "unknown" | "settled";
type Intent = {
  claim: LearningTaskClaim;
  requestId: string;
  action: Action;
  executionId: string;
  mcpEndpoint: string;
  revision: string;
  connectionId: string;
  bodySha256: string;
  requestFacts: Record<string, unknown>;
};
type SavedIntent = {
  request_id: string;
  task_id: string;
  claim_id: string;
  generation: number;
  // Rows written before install replaced the staged actions keep their action.
  action: string;
  execution_id: string;
  mcp_endpoint: string;
  runtime_revision: string | null;
  connection_id: string | null;
  body_sha256: string;
  request_facts: Record<string, unknown>;
  state: State;
  receipt: Record<string, unknown> | null;
};

export class PostgresLearningMaintenanceLedger {
  public constructor(
    private readonly kernel: PostgresKernel,
    private readonly onSettled?: (requestId: string) => void,
  ) {}

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
        // An unsettled install is never replayed blindly; a resend is a new attempt.
        return { dispatch: false, state: saved.state };
      }
      if (current.state !== "running")
        throw new Error("Learning maintenance action is not allowed in the task state");
      await client.query(
        `INSERT INTO learning_maintenance_intents
        (request_id,task_id,claim_id,generation,action,execution_id,mcp_endpoint,
         body_sha256,request_facts,runtime_revision,connection_id,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'pending')`,
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
          input.revision,
          input.connectionId,
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
        !validOutcome(saved, receipt)
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
    this.onSettled?.(requestId);
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
    this.onSettled?.(requestId);
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
    saved.runtime_revision === input.revision &&
    saved.connection_id === input.connectionId &&
    saved.body_sha256 === input.bodySha256 &&
    isDeepStrictEqual(saved.request_facts, input.requestFacts)
  );
}

function validateIntent(input: Intent): void {
  const url = new URL(input.mcpEndpoint);
  const facts = JSON.stringify(input.requestFacts) as string | undefined;
  if (
    !runtimeRevisionSchema.safeParse(input.revision).success ||
    !runtimeConnectionIdSchema.safeParse(input.connectionId).success ||
    !runtimeMcpEndpointSchema.safeParse(input.mcpEndpoint).success ||
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
    (input.action as string) !== "install"
  )
    throw new Error("Invalid learning maintenance intent");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validOutcome(saved: SavedIntent, receipt: Record<string, unknown>): boolean {
  if (saved.action !== "install") return false;
  if (receipt.outcome === "applied")
    return receipt.observed_digest === saved.request_facts.target_digest;
  return ["conflict", "blocked", "preempted"].includes(String(receipt.outcome));
}
