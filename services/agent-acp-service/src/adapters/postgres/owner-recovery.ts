import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { parseOwnerInspection, type OwnerInspection } from "../../application/owner-inspection.js";
import {
  parseOwnerRegistration,
  type OwnerRegistration,
} from "../../application/owner-incarnation.js";
import { AgentOwnershipLostError, ownershipFence } from "../../domain/agent-ownership.js";
import { finishLockedRun } from "./execution-repository.js";
import type { PostgresKernel } from "./kernel.js";
import { interruptLockedToolAttempts } from "./run-event-repository.js";
import { rejectLockedRunIntent } from "./run-repository.js";
import {
  RunWriteAuthority,
  type RunOwnerAuthority,
  type RunOwnerColumns,
} from "./run-write-authority.js";

export type RecoverPredecessorRun = {
  runId: string;
  inspection: OwnerInspection;
  recoveredAt: Date;
};

export class PostgresOwnerRecovery {
  readonly #authority: RunWriteAuthority;

  public constructor(
    private readonly kernel: PostgresKernel,
    authority: RunOwnerAuthority,
  ) {
    this.#authority = RunWriteAuthority.owned(authority);
  }

  public async listPredecessors(): Promise<
    readonly Readonly<{
      runId: string;
      registration: OwnerRegistration;
      inspection?: Extract<OwnerInspection, { state: "stopped" }>;
    }>[]
  > {
    const scope = this.#authority.scope()!;
    const current = this.#authority.origin();
    return this.#authority.organizationTransaction(
      this.kernel,
      scope.organizationId,
      async (client) => {
        const result = await client.query<
          RunOwnerColumns & {
            run_id: string;
            accepted_inspection: unknown;
            accepted_receipt_id: string | null;
          }
        >(
          `SELECT r.id AS run_id,r.organization_id,r.agent_id,r.execution_owner_registration_id,
           r.execution_owner_member_id,r.execution_owner_incarnation_id,r.execution_owner_epoch::text,
           p.inspection AS accepted_inspection,p.receipt_id AS accepted_receipt_id
         FROM runs r LEFT JOIN owner_stop_receipts p
           ON p.registration_id=r.execution_owner_registration_id
         WHERE r.organization_id=$1 AND r.agent_id=$2
           AND r.state IN ('admitting','running') AND r.execution_owner_registration_id IS NOT NULL
           AND r.execution_owner_incarnation_id IS DISTINCT FROM $3 ORDER BY r.created_at,r.id`,
          [scope.organizationId, scope.agentId, current[2]],
        );
        return Object.freeze(
          result.rows.map((row) => {
            const [registration_id, member_id, incarnation_id] = originalOwner(row);
            const registration = parseOwnerRegistration({
              registration_id,
              member_id,
              incarnation_id,
            });
            const inspection =
              row.accepted_receipt_id === null
                ? undefined
                : parseOwnerInspection(row.accepted_inspection, registration);
            if (
              inspection !== undefined &&
              (inspection.state !== "stopped" ||
                inspection.stop_receipt.receipt_id !== row.accepted_receipt_id)
            )
              throw new Error("Invalid accepted predecessor stop proof");
            return Object.freeze({
              runId: row.run_id,
              registration,
              ...(inspection === undefined ? {} : { inspection }),
            });
          }),
        );
      },
    );
  }

  // Input is an authenticated inspection or a complete accepted proof revalidated
  // from storage. Networking finishes outside this finite current-fence transaction.
  public async recoverRun(request: RecoverPredecessorRun): Promise<"recovered" | "terminal"> {
    const input = structuredClone(request);
    if (!(input.recoveredAt instanceof Date) || !Number.isFinite(input.recoveredAt.getTime()))
      throw new TypeError("Invalid recovery time");
    const scope = this.#authority.scope()!;
    const current = this.#authority.origin();
    return this.#authority.organizationTransaction(
      this.kernel,
      scope.organizationId,
      async (client) => {
        const identity = await client.query<{ session_id: string }>(
          "SELECT session_id FROM runs WHERE id=$1 AND organization_id=$2 AND agent_id=$3",
          [input.runId, scope.organizationId, scope.agentId],
        );
        const sessionId = identity.rows[0]?.session_id;
        if (sessionId === undefined) throw new AgentOwnershipLostError();
        const sessions = await client.query<{
          organization_id: string;
          agent_id: string;
          last_message_sequence: string;
        }>(
          "SELECT organization_id, agent_id, last_message_sequence FROM acp_sessions WHERE id=$1 FOR UPDATE",
          [sessionId],
        );
        const session = sessions.rows[0];
        if (session === undefined) throw new AgentOwnershipLostError();
        this.#authority.assertSession(session);
        const runs = await client.query<RunOwnerColumns & { session_id: string; state: string }>(
          `SELECT session_id,state,organization_id,agent_id,execution_owner_registration_id,
                execution_owner_member_id,execution_owner_incarnation_id,execution_owner_epoch::text
         FROM runs WHERE id=$1 FOR UPDATE`,
          [input.runId],
        );
        const run = runs.rows[0];
        if (
          run === undefined ||
          run.session_id !== sessionId ||
          run.organization_id !== session.organization_id ||
          run.agent_id !== session.agent_id
        )
          throw new AgentOwnershipLostError();
        this.#authority.assertSession(run);
        const original = originalOwner(run);
        if (
          original[0] === current[0] ||
          original[2] === current[2] ||
          BigInt(original[3]) >= BigInt(current[3]!)
        )
          throw new AgentOwnershipLostError();
        const inspection = parseOwnerInspection(input.inspection, {
          registration_id: original[0],
          member_id: original[1],
          incarnation_id: original[2],
        });
        if (inspection.state !== "stopped") throw new Error("Predecessor stop is not proven");
        const existingProof = await checkedProof(client, inspection);
        const recovered = await client.query<{
          receipt_id: string;
          organization_id: string;
          agent_id: string;
          original_registration_id: string;
          original_member_id: string;
          original_incarnation_id: string;
          original_epoch: string;
        }>(
          "SELECT receipt_id,organization_id,agent_id,original_registration_id,original_member_id,original_incarnation_id,original_epoch::text FROM run_owner_recoveries WHERE run_id=$1",
          [input.runId],
        );
        const audit = recovered.rows[0];
        if (
          audit !== undefined &&
          (!existingProof ||
            audit.receipt_id !== inspection.stop_receipt.receipt_id ||
            audit.organization_id !== scope.organizationId ||
            audit.agent_id !== scope.agentId ||
            !isDeepStrictEqual(
              [
                audit.original_registration_id,
                audit.original_member_id,
                audit.original_incarnation_id,
                audit.original_epoch,
              ],
              original,
            ))
        )
          throw new Error("Run recovery receipt identity conflict");
        if (["completed", "cancelled", "failed", "unresolved"].includes(run.state)) {
          // An ordinary terminal Run is not a new recovery receipt. In particular,
          // an unaccepted failed intent legitimately has no accepted Run outcome.
          return "terminal";
        }
        if (audit !== undefined || !["admitting", "running"].includes(run.state))
          throw new Error("Run recovery history is inconsistent");
        if (run.state === "admitting") await assertUnaccepted(client, input.runId);
        await client.query(
          `INSERT INTO owner_stop_receipts(receipt_id,registration_id,inspection,accepted_at)
         VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,
          [
            inspection.stop_receipt.receipt_id,
            inspection.registration_id,
            JSON.stringify(inspection),
            input.recoveredAt,
          ],
        );
        // A concurrent recovery of another scope may have inserted either unique
        // key while we waited. A conflict never authorizes a changed response.
        if (!(await checkedProof(client, inspection)))
          throw new Error("Stop receipt was not persisted");
        await client.query(
          `INSERT INTO run_owner_recoveries(run_id,receipt_id,organization_id,agent_id,
          original_registration_id,original_member_id,original_incarnation_id,original_epoch,
          recovering_registration_id,recovering_member_id,recovering_incarnation_id,recovering_epoch,accepted_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9,$10,$11,$12::bigint,$13)`,
          [
            input.runId,
            inspection.stop_receipt.receipt_id,
            scope.organizationId,
            scope.agentId,
            ...original,
            ...current,
            input.recoveredAt,
          ],
        );
        if (run.state === "admitting") {
          await rejectLockedRunIntent(
            client,
            input.runId,
            "service_restarted_before_execution",
            input.recoveredAt,
          );
          return "recovered";
        }
        const temporary = await client.query<{ released_at: Date | null; bound: boolean | null }>(
          `SELECT t.released_at,
             t.organization_id=r.organization_id AND t.agent_id=r.agent_id
             AND t.execution_id=r.execution_snapshot->'runtime'->>'executionId'
             AND t.mcp_endpoint=r.execution_snapshot->'runtime'->>'mcpEndpoint' AS bound
           FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id
           WHERE t.run_id=$1 FOR UPDATE OF t`,
          [input.runId],
        );
        if (temporary.rows.some((row) => row.bound !== true))
          throw new Error("Temporary Skill original Runtime binding changed");
        const cleanupPending = temporary.rows.some((row) => row.released_at === null);
        const effects = await interruptLockedToolAttempts(
          client,
          {
            runId: input.runId,
            sessionId,
            nextSequence: Number(session.last_message_sequence) + 1,
          },
          input.recoveredAt,
        );
        const outcome =
          effects.toolEffectState === "unknown" || cleanupPending
            ? {
                terminalClass: "unresolved" as const,
                executorState: "quiescent" as const,
                toolEffectState: "unknown" as const,
                unknownEffectSource: cleanupPending
                  ? effects.toolEffectState === "unknown" &&
                    effects.unknownEffectSource !== "runtime_mcp"
                    ? ("unclassified" as const)
                    : ("runtime_mcp" as const)
                  : effects.unknownEffectSource!,
                errorClass: cleanupPending
                  ? "temporary_skill_cleanup_pending"
                  : "service_restarted_during_tool",
              }
            : {
                terminalClass: "failed" as const,
                executorState: "quiescent" as const,
                toolEffectState: effects.toolEffectState,
                errorClass: "service_restarted_during_run",
              };
        await finishLockedRun(client, {
          runId: input.runId,
          ...outcome,
          finishedAt: input.recoveredAt,
        });
        return "recovered";
      },
    );
  }
}

function originalOwner(row: RunOwnerColumns): [string, string, string, string] {
  const values = [
    row.execution_owner_registration_id,
    row.execution_owner_member_id,
    row.execution_owner_incarnation_id,
    row.execution_owner_epoch,
  ] as const;
  if (values.some((value) => value === null)) throw new AgentOwnershipLostError();
  const [registration, member, incarnation, epoch] = values as [string, string, string, string];
  ownershipFence({
    organizationId: row.organization_id,
    agentId: row.agent_id,
    ownerInstanceId: incarnation,
    epoch,
  });
  return [registration, member, incarnation, epoch];
}

async function checkedProof(
  client: PoolClient,
  inspection: Extract<OwnerInspection, { state: "stopped" }>,
): Promise<boolean> {
  const result = await client.query<{
    receipt_id: string;
    registration_id: string;
    inspection: unknown;
  }>(
    "SELECT receipt_id,registration_id,inspection FROM owner_stop_receipts WHERE receipt_id=$1 OR registration_id=$2",
    [inspection.stop_receipt.receipt_id, inspection.registration_id],
  );
  if (result.rows.length === 0) return false;
  const stored = result.rows[0]!;
  if (
    result.rows.length !== 1 ||
    stored.receipt_id !== inspection.stop_receipt.receipt_id ||
    stored.registration_id !== inspection.registration_id ||
    !isDeepStrictEqual(stored.inspection, inspection)
  )
    throw new Error("Stop receipt identity conflict");
  return true;
}

async function assertUnaccepted(client: PoolClient, runId: string): Promise<void> {
  const result = await client.query<{ executed: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM session_messages WHERE run_id=$1)
       OR EXISTS(SELECT 1 FROM tool_attempts WHERE run_id=$1)
       OR EXISTS(SELECT 1 FROM tool_permissions WHERE run_id=$1)
       OR EXISTS(SELECT 1 FROM temporary_skill_scopes WHERE run_id=$1) AS executed`,
    [runId],
  );
  if (result.rows[0]?.executed !== false) throw new Error("Admitting Run has execution history");
}
