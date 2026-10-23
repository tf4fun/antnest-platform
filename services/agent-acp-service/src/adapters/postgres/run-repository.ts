import { deriveResourceId } from "../../domain/resource-id.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PoolClient } from "pg";
import { sessionConfigurationSchema } from "../../domain/session-configuration.js";
import {
  bridgeIntentDigestFromJson,
  canonicalPromptJson,
  promptPreparationChunk,
} from "../../domain/bridge-intent.js";

import type { EnvironmentChangeFact, SessionRecord } from "../../domain/types.js";
import { DomainError } from "../../domain/errors.js";
import type {
  AcceptRunInput,
  CreateRunIntentInput,
  RunIntent,
  RunRepository,
} from "../../ports/run-repository.js";
import type { PostgresKernel } from "./kernel.js";
import { RunWriteAuthority, type RunOwnerColumns } from "./run-write-authority.js";

type LockedSession = {
  organization_id: string;
  agent_id: string;
  state: string;
  last_message_sequence: string;
};
type LockedRun = RunOwnerColumns & {
  session_id: string;
  client_mcp_revision_id: string;
  state: string;
  cancel_requested_at: Date | null;
  pending_user_message_id: string | null;
  prompt_is_array: boolean | null;
};

export class PostgresRunRepository implements RunRepository {
  readonly #authority: RunWriteAuthority;

  public constructor(
    private readonly kernel: PostgresKernel,
    authority: RunWriteAuthority,
  ) {
    if (!(authority instanceof RunWriteAuthority))
      throw new TypeError("Run writers require explicit authority");
    this.#authority = authority;
  }

  public async getSession(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.kernel.query<{
      id: string;
      organization_id: string;
      principal_id: string;
      agent_id: string;
      cwd: "/workspace";
      state: SessionRecord["state"];
      title: string | null;
      forked_from_session_id: string | null;
      client_mcp_revision_id: string;
      last_execution_revision: string | null;
      last_message_sequence: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
              client_mcp_revision_id,
              last_execution_revision, last_message_sequence, created_at, updated_at
         FROM acp_sessions WHERE id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          organizationId: row.organization_id,
          principalId: row.principal_id,
          agentId: row.agent_id,
          cwd: row.cwd,
          state: row.state,
          title: row.title,
          forkedFromSessionId: row.forked_from_session_id,
          clientMcpRevisionId: row.client_mcp_revision_id,
          lastExecutionRevision: row.last_execution_revision,
          lastMessageSequence: Number(row.last_message_sequence),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
  }

  public async findBridgeIntent(
    sessionId: string,
    intentId: string,
  ): Promise<{ digest: string } | null> {
    const result = await this.kernel.query<{ intent_digest: string }>(
      `SELECT intent_digest FROM runs WHERE session_id = $1 AND bridge_intent_id = $2`,
      [sessionId, intentId],
    );
    return result.rows[0] === undefined ? null : { digest: result.rows[0].intent_digest };
  }

  public async createRunIntent(input: CreateRunIntentInput): Promise<RunIntent> {
    // Capture caller-owned values before yielding. The JSON string is reused by
    // the digest and INSERT; the detached value replaces the full INSERT return.
    const request = {
      ...input,
      createdAt: new Date(input.createdAt.getTime()),
      ...(input.bridgeIntent === undefined ? {} : { bridgeIntent: { ...input.bridgeIntent } }),
    };
    const promptJson = canonicalPromptJson(request.prompt);
    if (promptJson.length > promptPreparationChunk) await nextTurn();
    const prompt = JSON.parse(promptJson) as RunIntent["prompt"];
    const bridgeIntent = request.bridgeIntent;
    const digest =
      bridgeIntent === undefined
        ? null
        : await bridgeIntentDigestFromJson(bridgeIntent.expectedAppendVersion, promptJson);
    try {
      return await this.#authority.transaction(this.kernel, async (client) => {
        const session = await client.query<{
          organization_id: string;
          agent_id: string;
          state: string;
          client_mcp_revision_id: string;
          configuration: unknown;
          append_version: string;
        }>(
          `SELECT organization_id, agent_id, state, client_mcp_revision_id, configuration, append_version
             FROM acp_sessions WHERE id = $1 FOR UPDATE`,
          [request.sessionId],
        );
        const sessionRow = requireRow(session.rows[0], "Session does not exist");
        this.#authority.assertSession(sessionRow);
        if (sessionRow.state !== "active") {
          throw new DomainError("session_not_active", "Session is not active");
        }
        if (bridgeIntent !== undefined) {
          const existing = await client.query<RunOwnerColumns & { intent_digest: string }>(
            `SELECT intent_digest, organization_id, agent_id,
                    execution_owner_registration_id, execution_owner_member_id,
                    execution_owner_incarnation_id, execution_owner_epoch::text
               FROM runs
              WHERE session_id = $1 AND bridge_intent_id = $2`,
            [request.sessionId, bridgeIntent.intentId],
          );
          if (existing.rows[0] !== undefined) {
            this.#authority.assertRun(existing.rows[0]);
            if (existing.rows[0].intent_digest !== digest)
              throw new DomainError(
                "idempotency_conflict",
                "Intent key belongs to different input",
              );
            throw new DomainError("intent_already_recorded", "Intent already has a durable Run");
          }
          if (Number(sessionRow.append_version) !== bridgeIntent.expectedAppendVersion)
            throw new DomainError("session_append_conflict", "Session append version changed");
        }
        const currentAppendVersion = Number(sessionRow.append_version);
        if (
          !Number.isSafeInteger(currentAppendVersion) ||
          currentAppendVersion >= Number.MAX_SAFE_INTEGER
        )
          throw new DomainError("session_append_conflict", "Session append version is exhausted");
        // Both Session and Agent unique indexes protect this insert. Preserve
        // Session error priority under its lock, independent of index order.
        const active = await client.query<{ id: string }>(
          "SELECT id FROM runs WHERE session_id = $1 AND state IN ('admitting', 'running') LIMIT 1",
          [request.sessionId],
        );
        if (active.rows[0] !== undefined)
          throw new DomainError("session_busy", "Session already has a non-terminal Run");
        const nextAppendVersion = currentAppendVersion + 1;
        const result = await client.query<{
          id: string;
          request_id: string;
          session_id: string;
          client_mcp_revision_id: string;
          expected_access_revision: string;
          state: RunIntent["state"];
          pending_user_message_id: string;
          session_configuration: unknown;
        }>(
          `INSERT INTO runs(
             id, request_id, session_id, client_mcp_revision_id,
             expected_access_revision, state,
             pending_user_message_id, input_prompt,
             created_at, updated_at, session_configuration,
             bridge_intent_id, intent_digest, expected_append_version, append_version,
             organization_id, agent_id,
             execution_owner_registration_id, execution_owner_member_id,
             execution_owner_incarnation_id, execution_owner_epoch
           ) VALUES ($1, $2, $3, $4, $5, 'admitting', $6, $7::jsonb, $8, $8, $9::jsonb,
                     $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::bigint)
           RETURNING id, request_id, session_id, client_mcp_revision_id,
                     expected_access_revision, state,
                     pending_user_message_id, session_configuration`,
          [
            request.runId,
            request.requestId,
            request.sessionId,
            sessionRow.client_mcp_revision_id,
            request.expectedAccessRevision,
            request.userMessageId,
            promptJson,
            request.createdAt,
            JSON.stringify(sessionConfigurationSchema.parse(sessionRow.configuration)),
            bridgeIntent?.intentId ?? null,
            digest,
            bridgeIntent?.expectedAppendVersion ?? null,
            nextAppendVersion,
            sessionRow.organization_id,
            sessionRow.agent_id,
            ...this.#authority.origin(),
          ],
        );
        await client.query("UPDATE acp_sessions SET append_version = $2 WHERE id = $1", [
          request.sessionId,
          nextAppendVersion,
        ]);
        const row = requireRow(result.rows[0], "Run intent was not created");
        return {
          id: row.id,
          requestId: row.request_id,
          sessionId: row.session_id,
          clientMcpRevisionId: row.client_mcp_revision_id,
          expectedAccessRevision: row.expected_access_revision,
          state: row.state,
          userMessageId: row.pending_user_message_id,
          prompt,
          sessionConfiguration: sessionConfigurationSchema.parse(row.session_configuration),
        };
      });
    } catch (error) {
      if (isConstraint(error, "runs_session_nonterminal_unique")) {
        throw new DomainError("session_busy", "Session already has a non-terminal Run");
      }
      if (isConstraint(error, "runs_agent_nonterminal_unique")) {
        throw new DomainError("agent_busy", "Agent already has an active Run");
      }
      throw error;
    }
  }

  public async requestCancellation(runId: string, requestedAt: Date): Promise<void> {
    const capturedAt = new Date(requestedAt.getTime());
    await this.#authority.transaction(this.kernel, async (client) => {
      if ((await this.lockRun(client, runId)) === undefined) return;
      await client.query(
        `UPDATE runs
          SET cancel_requested_at = COALESCE(cancel_requested_at, $2), updated_at = $2
        WHERE id = $1 AND state IN ('admitting', 'running')`,
        [runId, capturedAt],
      );
    });
  }

  public async acceptRun(request: AcceptRunInput): Promise<"accepted" | "cancelled"> {
    const input = structuredClone(request);
    return this.#authority.transaction(this.kernel, async (client) => {
      const { session: sessionRow, run: runRow } = requireRow(
        await this.lockRun(client, input.runId),
        "Run intent does not exist",
      );
      if (runRow.state !== "admitting") {
        throw new Error("Run intent is no longer admitting");
      }
      if (runRow.pending_user_message_id === null || runRow.prompt_is_array !== true) {
        throw new Error("Run intent has no recoverable prompt");
      }
      if (runRow.client_mcp_revision_id !== input.snapshot.clientMcpRevisionId) {
        throw new Error("Run snapshot does not match its captured client MCP revision");
      }
      if (runRow.cancel_requested_at !== null || sessionRow.state !== "active") {
        await client.query(
          `UPDATE runs
              SET state = 'cancelled', execution_snapshot = $2::jsonb, deadline_at = $3,
                  pending_user_message_id = NULL,
                  terminal_class = 'cancelled', executor_state = 'quiescent',
                  tool_effect_state = 'none', error_class = NULL,
                  cancel_requested_at = COALESCE(cancel_requested_at, $4), updated_at = $4
            WHERE id = $1`,
          [
            input.runId,
            JSON.stringify(input.snapshot),
            input.snapshot.deadlineAt,
            input.acceptedAt,
          ],
        );
        return "cancelled";
      }

      let sequence = Number(sessionRow.last_message_sequence);
      if (input.environmentFact !== null) {
        sequence += 1;
        await insertEnvironmentFact(client, input, input.environmentFact, sequence);
      }
      sequence += 1;
      const message = await client.query(
        `INSERT INTO session_messages(
           id, session_id, run_id, sequence, kind, visible, payload, created_at
         ) SELECT pending_user_message_id, session_id, id, $2, 'user_message', true,
                  jsonb_build_object('kind', 'user_message',
                    'messageId', pending_user_message_id, 'content', input_prompt), $3
             FROM runs WHERE id = $1`,
        [input.runId, sequence, input.acceptedAt],
      );
      if (message.rowCount !== 1) throw new Error("Run user message was not created");
      await client.query(
        `UPDATE runs
            SET state = 'running', execution_snapshot = $2::jsonb, deadline_at = $3,
                pending_user_message_id = NULL, updated_at = $4
          WHERE id = $1`,
        [input.runId, JSON.stringify(input.snapshot), input.snapshot.deadlineAt, input.acceptedAt],
      );
      await client.query(
        `UPDATE acp_sessions
            SET last_execution_revision = $2, last_message_sequence = $3,
                title = COALESCE(title, $5), updated_at = $4
          WHERE id = $1`,
        [
          runRow.session_id,
          input.snapshot.executionRevision,
          sequence,
          input.acceptedAt,
          input.sessionTitle ?? null,
        ],
      );
      return "accepted";
    });
  }

  public async rejectRun(
    runId: string,
    errorClass: string,
    rejectedAt: Date,
  ): Promise<"failed" | "cancelled"> {
    const capturedAt = new Date(rejectedAt.getTime());
    return this.#authority.transaction(this.kernel, async (client) => {
      requireRow(await this.lockRun(client, runId), "Run intent is no longer admitting");
      return rejectLockedRunIntent(client, runId, errorClass, capturedAt);
    });
  }

  private async lockRun(
    client: PoolClient,
    runId: string,
  ): Promise<{ session: LockedSession; run: LockedRun } | undefined> {
    const identity = await client.query<{ session_id: string }>(
      "SELECT session_id FROM runs WHERE id = $1",
      [runId],
    );
    const sessionId = identity.rows[0]?.session_id;
    if (sessionId === undefined) return undefined;
    const session = await client.query<LockedSession>(
      `SELECT organization_id, agent_id, state, last_message_sequence
         FROM acp_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    const sessionRow = requireRow(session.rows[0], "Session does not exist");
    this.#authority.assertSession(sessionRow);
    const run = await client.query<LockedRun>(
      `SELECT session_id, organization_id, agent_id, client_mcp_revision_id, state,
              cancel_requested_at, pending_user_message_id,
              jsonb_typeof(input_prompt) = 'array' AS prompt_is_array,
              execution_owner_registration_id, execution_owner_member_id,
              execution_owner_incarnation_id, execution_owner_epoch::text
         FROM runs WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    const runRow = run.rows[0];
    if (runRow === undefined) return undefined;
    if (
      runRow.session_id !== sessionId ||
      runRow.organization_id !== sessionRow.organization_id ||
      runRow.agent_id !== sessionRow.agent_id
    )
      throw new Error("Run intent changed Session identity");
    this.#authority.assertRun(runRow);
    return { session: sessionRow, run: runRow };
  }
}

export async function rejectLockedRunIntent(
  client: PoolClient,
  runId: string,
  errorClass: string,
  capturedAt: Date,
): Promise<"failed" | "cancelled"> {
  const result = await client.query<{ state: "failed" | "cancelled" }>(
    `UPDATE runs
          SET state = CASE WHEN cancel_requested_at IS NULL THEN 'failed' ELSE 'cancelled' END,
              pending_user_message_id = NULL,
              terminal_class = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE 'cancelled' END,
              executor_state = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE 'quiescent' END,
              tool_effect_state = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE 'none' END,
              error_class = CASE WHEN cancel_requested_at IS NULL THEN $2 ELSE NULL END,
              updated_at = $3
        WHERE id = $1 AND state = 'admitting'
        RETURNING state`,
    [runId, errorClass, capturedAt],
  );
  if (result.rowCount !== 1) {
    throw new Error("Run intent is no longer admitting");
  }
  return requireRow(result.rows[0], "Run rejection did not return state").state;
}

async function insertEnvironmentFact(
  client: PoolClient,
  input: AcceptRunInput,
  fact: EnvironmentChangeFact,
  sequence: number,
): Promise<void> {
  await client.query(
    `INSERT INTO session_messages(
       id, session_id, run_id, sequence, kind, visible, payload, created_at
     )
     SELECT $1, session_id, id, $2, 'environment_change', false, $3::jsonb, $4
       FROM runs WHERE id = $5`,
    [
      deriveResourceId("message", "environment-change", input.runId),
      sequence,
      JSON.stringify(fact),
      input.acceptedAt,
      input.runId,
    ],
  );
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new Error(message);
  }
  return row;
}

function isConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}
