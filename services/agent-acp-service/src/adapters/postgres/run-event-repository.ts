import { deriveResourceId } from "../../domain/resource-id.js";
import type { PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { projectUsage } from "../../domain/usage.js";
import { reserveModelBudget, settleModelBudget } from "./model-budget.js";

import type {
  ToolEffectState,
  UnknownEffectSource,
  RunExecutionSnapshot,
  ModelCandidate,
} from "../../domain/types.js";
import type { ModelAttemptStarted } from "../../ports/model-attempts.js";
import type { InterruptedToolEffects } from "../../ports/run-event-repository.js";

import type { SessionEvent } from "../../ports/acp-application.js";
import type {
  AppendAgentMessageInput,
  AppendToolProgressInput,
  AppendRejectedToolCallInput,
  FinishToolAttemptInput,
  RunEventRepository,
  StartToolAttemptInput,
} from "../../ports/run-event-repository.js";
import type { PostgresKernel } from "./kernel.js";
import { RunWriteAuthority, type RunOwnerColumns } from "./run-write-authority.js";
import {
  decodeSessionEvent,
  encodeSessionEvent,
  type StoredSessionEvent,
} from "./session-event-codec.js";

export class PostgresRunEventRepository implements RunEventRepository {
  readonly #authority: RunWriteAuthority;
  public constructor(
    private readonly kernel: PostgresKernel,
    authority: RunWriteAuthority,
  ) {
    if (!(authority instanceof RunWriteAuthority))
      throw new TypeError("Run event writers require explicit authority");
    this.#authority = authority;
  }

  public appendPlan(request: Parameters<RunEventRepository["appendPlan"]>[0]): Promise<boolean> {
    const input = structuredClone(request);
    return this.#authority.transaction(this.kernel, async (client) => {
      const locked = await lockSessionRun(client, input.runId, this.#authority);
      const receipts: Array<SessionEvent | undefined> = [];
      for (const [index, event] of input.events.entries()) {
        receipts.push(
          await storedEventReceipt(client, locked, {
            id: deriveResourceId("message", "plan", `${input.id}:${index}`),
            kind: event.kind,
            event,
            createdAt: input.createdAt,
          }),
        );
      }
      if (receipts.some((receipt) => receipt !== undefined)) {
        if (receipts.some((receipt) => receipt === undefined))
          throw new Error("Plan receipt is incomplete");
        return true;
      }
      requireRunning(locked.state);
      const run = await client.query<{ cancel_requested_at: Date | null }>(
        "SELECT cancel_requested_at FROM runs WHERE id = $1",
        [input.runId],
      );
      if (requireRow(run.rows[0], "Run does not exist").cancel_requested_at !== null) return false;
      for (const [index, event] of input.events.entries()) {
        await appendLocked(
          client,
          { ...locked, nextSequence: locked.nextSequence + index },
          deriveResourceId("message", "plan", `${input.id}:${index}`),
          event.kind,
          event,
          input.createdAt,
        );
      }
      return true;
    });
  }

  public async appendToolProgress(request: AppendToolProgressInput): Promise<SessionEvent> {
    const input = structuredClone(request);
    const event: SessionEvent = {
      kind: "tool_call",
      initial: false,
      toolCallId: input.toolCallId,
      status: "in_progress",
      content: input.content,
    };
    return this.#authority.transaction(this.kernel, async (client) => {
      const locked = await lockSessionRun(client, input.runId, this.#authority);
      const receipt = await storedEventReceipt(client, locked, {
        id: input.id,
        kind: "tool_call",
        event,
        createdAt: input.createdAt,
      });
      if (receipt !== undefined) return receipt;
      requireRunning(locked.state);
      const attempt = await client.query(
        "SELECT id FROM tool_attempts WHERE run_id = $1 AND tool_call_id = $2 AND state = 'in_progress'",
        [input.runId, input.toolCallId],
      );
      if (attempt.rowCount !== 1) throw new Error("Tool attempt is not in progress");
      await appendLocked(client, locked, input.id, "tool_call", event, input.createdAt);
      return event;
    });
  }

  public async appendAgentMessage(request: AppendAgentMessageInput): Promise<SessionEvent> {
    const input = structuredClone(request);
    const event: SessionEvent = {
      kind: "agent_message",
      messageId: input.id,
      content: input.content,
      ...(input.toolCalls === undefined ? {} : { toolCalls: input.toolCalls }),
      ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
    };
    return this.append(
      input.runId,
      input.id,
      "agent_message",
      event,
      input.createdAt,
      input.content.length > 0,
    );
  }

  public async appendAgentThought(request: AppendAgentMessageInput): Promise<SessionEvent> {
    const input = structuredClone(request);
    const event: SessionEvent = {
      kind: "agent_thought",
      messageId: input.id,
      ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
      content: input.content,
    };
    return this.append(input.runId, input.id, "agent_thought", event, input.createdAt);
  }

  public appendUsage(
    request: Parameters<RunEventRepository["appendUsage"]>[0],
  ): Promise<SessionEvent> {
    const input = structuredClone(request);
    return this.#authority.transaction(this.kernel, async (client) => {
      const locked = await lockSessionRun(client, input.runId, this.#authority);
      const receipt = await storedUsage(client, locked, input);
      if (receipt !== undefined) return receipt;
      requireRunning(locked.state);
      return appendUsageLocked(client, locked, input);
    });
  }

  public startModelAttempt(
    request: Parameters<RunEventRepository["startModelAttempt"]>[0],
  ): Promise<void> {
    const input = structuredClone(request);
    requireOrdinal(input.ordinal);
    const id = modelAttemptId(input.runId, input.ordinal, "start");
    const event = {
      kind: "model_attempt",
      phase: "start",
      ordinal: input.ordinal,
      modelProfileId: input.modelProfileId,
      providerConnectionId: input.providerConnectionId,
      model: input.model,
      purpose: input.purpose,
      startedAt: input.startedAt,
      ...(input.reservation === undefined ? {} : { reservation: input.reservation }),
    };
    return this.modelTransaction(input.runId, async (client) => {
      const locked = await lockSessionRun(client, input.runId, this.#authority);
      if (await storedModelAttempt(client, locked, id, event, input.startedAt)) return;
      requireRunning(locked.state);
      const row = await client.query<{ execution_snapshot: RunExecutionSnapshot }>(
        "SELECT execution_snapshot FROM runs WHERE id=$1",
        [input.runId],
      );
      const frozen = requireRow(row.rows[0], "Run snapshot is missing").execution_snapshot;
      const candidate = frozenModelCandidate(frozen, input);
      if (candidate === undefined || input.ordinal > frozen.executionSpec.maxModelRequests)
        throw new Error("Model attempt does not match the frozen Run");
      const previous = await client.query<{ ordinal: string | null }>(
        `SELECT max((payload->>'ordinal')::bigint)::text AS ordinal FROM session_messages
         WHERE run_id=$1 AND session_id=$2 AND kind='model_attempt' AND payload->>'phase'='start'`,
        [locked.runId, locked.sessionId],
      );
      if (input.ordinal !== Number(previous.rows[0]?.ordinal ?? 0) + 1)
        throw new Error("Model attempt ordinal is not next");
      if (input.ordinal > 1) {
        const prior = await client.query(
          "SELECT id FROM session_messages WHERE id=$1 AND run_id=$2 AND session_id=$3 AND kind='model_attempt' AND payload->>'phase'='finish'",
          [
            modelAttemptId(input.runId, input.ordinal - 1, "finish"),
            locked.runId,
            locked.sessionId,
          ],
        );
        if (prior.rowCount !== 1) throw new Error("Previous model attempt is unfinished");
      }
      await reserveModelBudget(client, {
        runId: input.runId,
        ordinal: input.ordinal,
        organizationId: locked.organizationId,
        agentId: locked.agentId,
        ...(frozen.executionSpec.runBudget === undefined
          ? {}
          : { runBudget: frozen.executionSpec.runBudget }),
        ...(input.reservation === undefined ? {} : { reservation: input.reservation }),
        ...(candidate.model.pricing === undefined ? {} : { pricing: candidate.model.pricing }),
      });
      await appendModelAttemptLocked(client, locked, id, event, input.startedAt);
    });
  }

  public finishModelAttempt(
    request: Parameters<RunEventRepository["finishModelAttempt"]>[0],
  ): Promise<SessionEvent> {
    const input = structuredClone(request);
    requireOrdinal(input.ordinal);
    if (
      input.notDispatched === true &&
      (input.outcome === "completed" ||
        input.outputStarted ||
        input.status !== undefined ||
        !isDeepStrictEqual(input.usage, { inputTokens: 0, outputTokens: 0 }))
    )
      return Promise.reject(
        new Error("No-dispatch proof conflicts with the original model attempt"),
      );
    const id = modelAttemptId(input.runId, input.ordinal, "finish");
    const event = {
      kind: "model_attempt",
      phase: "finish",
      ordinal: input.ordinal,
      outcome: input.outcome,
      reason: input.reason,
      durationMs: input.durationMs,
      outputStarted: input.outputStarted,
      usage: input.usage,
      ...(input.notDispatched === undefined ? {} : { notDispatched: input.notDispatched }),
      ...(input.status === undefined ? {} : { status: input.status }),
      finishedAt: input.finishedAt,
      contextSize: input.contextSize,
    };
    const usage = {
      id: deriveResourceId("message", "model-attempt-usage", `${request.runId}:${request.ordinal}`),
      runId: input.runId,
      usage: input.usage,
      contextSize: input.contextSize,
      createdAt: input.finishedAt,
    };
    return this.modelTransaction(input.runId, async (client) => {
      const locked = await lockSessionRun(client, input.runId, this.#authority);
      const receipt = await storedModelAttempt(client, locked, id, event, input.finishedAt);
      const usageReceipt = await storedUsage(client, locked, usage);
      if (receipt || usageReceipt !== undefined) {
        if (!receipt || usageReceipt === undefined)
          throw new Error("Model attempt receipt is incomplete");
        return usageReceipt;
      }
      requireRunning(locked.state);
      const started = await client.query<{
        payload: ModelAttemptStarted;
        execution_snapshot: RunExecutionSnapshot;
      }>(
        `SELECT m.payload, r.execution_snapshot FROM session_messages m
         JOIN runs r ON r.id=m.run_id
         WHERE m.id=$1 AND m.run_id=$2 AND m.session_id=$3 AND m.kind='model_attempt'
           AND NOT m.visible AND m.context_excluded AND m.payload->>'phase'='start'`,
        [modelAttemptId(input.runId, input.ordinal, "start"), locked.runId, locked.sessionId],
      );
      if (started.rowCount !== 1) throw new Error("Model attempt start is missing");
      const original = requireRow(started.rows[0], "Model attempt start is missing");
      const candidate = frozenModelCandidate(original.execution_snapshot, original.payload);
      if (candidate === undefined || input.contextSize !== candidate.model.contextWindow)
        throw new Error("Model attempt context does not match its frozen candidate");
      await settleModelBudget(client, {
        runId: input.runId,
        ordinal: input.ordinal,
        organizationId: locked.organizationId,
        usage: input.usage,
        ...(input.notDispatched === undefined ? {} : { notDispatched: input.notDispatched }),
        ...(candidate.model.pricing === undefined ? {} : { pricing: candidate.model.pricing }),
      });
      await appendModelAttemptLocked(client, locked, id, event, input.finishedAt);
      return appendUsageLocked(client, { ...locked, nextSequence: locked.nextSequence + 1 }, usage);
    });
  }

  public async startToolAttempt(request: StartToolAttemptInput): Promise<SessionEvent> {
    const input = structuredClone(request);
    const event: SessionEvent = {
      kind: "tool_call",
      initial: true,
      toolCallId: input.toolCallId,
      title: input.tool.name,
      ...input.presentation,
      modelName: input.tool.modelName,
      arguments: input.arguments,
      status: "in_progress",
    };
    return this.#authority.transaction(this.kernel, async (client) => {
      const locked = await lockSessionRun(client, input.runId, this.#authority);
      const receipt = await storedEventReceipt(client, locked, {
        id: input.id,
        kind: "tool_call",
        event,
        createdAt: input.createdAt,
      });
      if (receipt !== undefined) {
        await requireToolStartReceipt(client, input);
        return receipt;
      }
      requireRunning(locked.state);
      await client.query(
        `INSERT INTO tool_attempts(
           id, run_id, tool_call_id, source, source_id, tool_name, request_digest,
           state, tool_effect_state, started_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress', 'none', $8, $8, $8)`,
        [
          deriveResourceId("toolattempt", "tool-start", input.id),
          input.runId,
          input.toolCallId,
          input.tool.source,
          input.tool.sourceId,
          input.tool.name,
          input.requestDigest,
          input.createdAt,
        ],
      );
      await appendLocked(client, locked, input.id, "tool_call", event, input.createdAt);
      return event;
    });
  }

  private async modelTransaction<T>(
    runId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const identity = (
      await this.kernel.query<{ organization_id: string }>(
        "SELECT organization_id FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0];
    if (identity === undefined) throw new Error("Run does not exist");
    return this.#authority.organizationTransaction(
      this.kernel,
      identity.organization_id,
      async (client) => {
        // The pre-lock lookup is only a lock key, never admission authority.
        const current = (
          await client.query<{ organization_id: string }>(
            "SELECT organization_id FROM runs WHERE id=$1",
            [runId],
          )
        ).rows[0];
        if (current?.organization_id !== identity.organization_id)
          throw new Error("Run organization changed");
        return operation(client);
      },
    );
  }

  public async appendRejectedToolCall(request: AppendRejectedToolCallInput): Promise<SessionEvent> {
    const input = structuredClone(request);
    const event: SessionEvent = {
      kind: "tool_call",
      initial: true,
      toolCallId: input.call.id,
      title: input.call.name,
      modelName: input.call.name,
      arguments: input.call.arguments,
      status: "failed",
      content: [{ type: "text", text: input.message }],
    };
    return this.append(input.runId, input.id, "tool_call", event, input.createdAt);
  }

  public async finishToolAttempt(request: FinishToolAttemptInput): Promise<SessionEvent> {
    const input = structuredClone(request);
    const event: SessionEvent = {
      kind: "tool_call",
      initial: false,
      toolCallId: input.toolCallId,
      status: input.status,
      content: input.content,
      ...(input.rawOutput === undefined ? {} : { rawOutput: input.rawOutput }),
      ...(input.file === undefined ? {} : { file: input.file }),
    };
    return this.#authority.transaction(this.kernel, async (client) => {
      const locked = await lockSessionRun(client, input.runId, this.#authority);
      const receipt = await storedEventReceipt(client, locked, {
        id: input.id,
        kind: "tool_call",
        event,
        createdAt: input.createdAt,
      });
      if (receipt !== undefined) {
        await requireToolFinishReceipt(client, input);
        return receipt;
      }
      requireRunning(locked.state);
      const updated = await client.query(
        `UPDATE tool_attempts
            SET state = $3, result_summary = $4::jsonb, tool_effect_state = $5,
                finished_at = $6, updated_at = $6, runtime_call_stopped = $7,
                finish_runtime_call_stopped = $7
          WHERE run_id = $1 AND tool_call_id = $2 AND state = 'in_progress'`,
        [
          input.runId,
          input.toolCallId,
          input.status,
          JSON.stringify(input.resultSummary),
          input.toolEffectState,
          input.createdAt,
          input.runtimeCallStopped === true,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error("Tool attempt is not in progress");
      }
      await appendLocked(client, locked, input.id, "tool_call", event, input.createdAt);
      return event;
    });
  }

  public async interruptToolAttempts(
    runId: string,
    requestedAt: Date,
    reason: "service_restart" | "persistence_failure" = "service_restart",
  ): Promise<InterruptedToolEffects> {
    const interruptedAt = new Date(requestedAt.getTime());
    return this.#authority.transaction(this.kernel, async (client) => {
      const locked = await lockRunAndSession(client, runId, this.#authority);
      return interruptLockedToolAttempts(client, locked, interruptedAt, reason);
    });
  }

  private async append(
    runId: string,
    id: string,
    kind: string,
    event: SessionEvent,
    createdAt: Date,
    visible = true,
  ): Promise<SessionEvent> {
    return this.#authority.transaction(this.kernel, async (client) => {
      const locked = await lockSessionRun(client, runId, this.#authority);
      const receipt = await storedEventReceipt(client, locked, {
        id,
        kind,
        event,
        createdAt,
        visible,
      });
      if (receipt !== undefined) return receipt;
      requireRunning(locked.state);
      await appendLocked(client, locked, id, kind, event, createdAt, visible);
      return event;
    });
  }
}

function frozenModelCandidate(
  snapshot: RunExecutionSnapshot,
  attempt: Pick<ModelAttemptStarted, "modelProfileId" | "providerConnectionId" | "model">,
): ModelCandidate | undefined {
  const candidates = [
    {
      modelProfileId: snapshot.modelProfileId,
      providerConnectionId: snapshot.providerConnectionId,
      model: snapshot.executionSpec.model,
    },
    ...(snapshot.executionSpec.modelFailover === "before_output"
      ? (snapshot.executionSpec.fallbackModels ?? [])
      : []),
  ];
  return candidates.find(
    (candidate) =>
      candidate.modelProfileId === attempt.modelProfileId &&
      candidate.providerConnectionId === attempt.providerConnectionId &&
      candidate.model.model === attempt.model,
  );
}

function mergeUnknownEffectSource(
  current: UnknownEffectSource | undefined,
  next: UnknownEffectSource,
): UnknownEffectSource {
  if (current === undefined || current === next) {
    return next;
  }
  return "unclassified";
}

type LockedRun = { runId: string; sessionId: string; nextSequence: number };

function requireOrdinal(ordinal: number): void {
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0)
    throw new Error("Invalid model attempt ordinal");
}

function modelAttemptId(runId: string, ordinal: number, phase: "start" | "finish"): string {
  return deriveResourceId("message", "model-attempt", `${runId}:${ordinal}:${phase}`);
}

async function storedModelAttempt(
  client: PoolClient,
  locked: LockedRun,
  id: string,
  payload: object,
  createdAt: Date,
): Promise<boolean> {
  const result = await client.query<{
    run_id: string;
    session_id: string;
    kind: string;
    visible: boolean;
    context_excluded: boolean;
    payload: unknown;
    created_at: Date;
  }>(
    "SELECT run_id,session_id,kind,visible,context_excluded,payload,created_at FROM session_messages WHERE id=$1",
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) return false;
  if (
    row.run_id !== locked.runId ||
    row.session_id !== locked.sessionId ||
    row.kind !== "model_attempt" ||
    row.visible ||
    !row.context_excluded ||
    row.created_at.getTime() !== createdAt.getTime() ||
    !isDeepStrictEqual(row.payload, JSON.parse(JSON.stringify(payload)))
  )
    throw new Error("Model attempt receipt identity conflict");
  return true;
}

async function appendModelAttemptLocked(
  client: PoolClient,
  locked: LockedRun,
  id: string,
  payload: object,
  createdAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at,context_excluded)
     VALUES($1,$2,$3,$4,'model_attempt',false,$5::jsonb,$6,true)`,
    [id, locked.sessionId, locked.runId, locked.nextSequence, JSON.stringify(payload), createdAt],
  );
  // Hidden attempt bookkeeping has no public update to publish. Keep Session
  // metadata tied to the visible events that advance it and wake observers.
  await client.query("UPDATE acp_sessions SET last_message_sequence=$2 WHERE id=$1", [
    locked.sessionId,
    locked.nextSequence,
  ]);
}

async function appendUsageLocked(
  client: PoolClient,
  locked: LockedRun,
  input: Parameters<RunEventRepository["appendUsage"]>[0],
): Promise<SessionEvent> {
  const previous = await client.query<{ payload: StoredSessionEvent }>(
    "SELECT payload FROM session_messages WHERE session_id=$1 AND kind='usage' ORDER BY sequence DESC LIMIT 1",
    [locked.sessionId],
  );
  const stored = previous.rows[0]?.payload;
  const prior = stored === undefined ? undefined : decodeSessionEvent(stored);
  const event: SessionEvent = {
    kind: "usage",
    ...projectUsage(
      input.usage,
      input.contextSize,
      prior?.kind === "usage" ? prior.cost : undefined,
    ),
  };
  await appendLocked(client, locked, input.id, "usage", event, input.createdAt);
  return event;
}

export async function interruptLockedToolAttempts(
  client: PoolClient,
  locked: LockedRun,
  interruptedAt: Date,
  reason: "service_restart" | "persistence_failure" = "service_restart",
): Promise<InterruptedToolEffects> {
  const runId = locked.runId;
  const attempts = await client.query<{
    id: string;
    tool_call_id: string;
    source: "runtime" | "client" | "agent";
    state: string;
    tool_effect_state: ToolEffectState;
    temporary_scope: boolean;
    temporary_pending: boolean;
  }>(
    `SELECT id, tool_call_id, source, state, tool_effect_state,
                (source='agent' AND source_id='skill_registry' AND tool_name='load_skill'
                 AND EXISTS(SELECT 1 FROM temporary_skill_scopes t WHERE t.run_id=tool_attempts.run_id)) AS temporary_scope,
                EXISTS(SELECT 1 FROM temporary_skill_scopes t WHERE t.run_id=tool_attempts.run_id AND t.released_at IS NULL) AS temporary_pending
           FROM tool_attempts
          WHERE run_id = $1
          ORDER BY created_at, id
          FOR UPDATE`,
    [runId],
  );
  let effectState: ToolEffectState = "none";
  let unknownEffectSource: UnknownEffectSource | undefined;
  let interrupted = 0;
  for (const attempt of attempts.rows) {
    effectState = combineEffects(effectState, attempt.tool_effect_state);
    const attemptEffectSource =
      attempt.source === "runtime" || attempt.temporary_scope
        ? "runtime_mcp"
        : attempt.source === "client"
          ? "client_mcp"
          : "unclassified";
    if (attempt.tool_effect_state === "unknown") {
      unknownEffectSource = mergeUnknownEffectSource(unknownEffectSource, attemptEffectSource);
    }
    if (attempt.state !== "in_progress") {
      continue;
    }
    const interruptedEffect = attempt.temporary_scope
      ? attempt.temporary_pending
        ? "unknown"
        : "settled"
      : attempt.source === "agent"
        ? "none"
        : "unknown";
    effectState = combineEffects(effectState, interruptedEffect);
    if (interruptedEffect === "unknown")
      unknownEffectSource = mergeUnknownEffectSource(unknownEffectSource, attemptEffectSource);
    const content = [
      {
        type: "text" as const,
        text:
          reason === "persistence_failure"
            ? attempt.source === "agent" && !attempt.temporary_scope
              ? "Skill discovery read was interrupted by Run persistence failure. No Runtime mutation was dispatched."
              : "Tool outcome is unknown after Run persistence was interrupted."
            : attempt.source === "agent" && !attempt.temporary_scope
              ? "Skill discovery read was interrupted by Agent ACP Service restart. No Runtime mutation was dispatched."
              : "Tool outcome is unknown because Agent ACP Service restarted.",
      },
    ];
    await client.query(
      `UPDATE tool_attempts
              SET state = 'failed', result_summary = $2::jsonb,
                  tool_effect_state = $4, finished_at = $3, updated_at = $3,
                  runtime_call_stopped = CASE WHEN source='agent' THEN $5 ELSE runtime_call_stopped END
            WHERE id = $1`,
      [
        attempt.id,
        JSON.stringify(content),
        interruptedAt,
        interruptedEffect,
        attempt.source === "agent" && (!attempt.temporary_scope || !attempt.temporary_pending),
      ],
    );
    await appendLocked(
      client,
      { ...locked, nextSequence: locked.nextSequence + interrupted },
      deriveResourceId("message", "tool-interrupted", attempt.id),
      "tool_call",
      {
        kind: "tool_call",
        initial: false,
        toolCallId: attempt.tool_call_id,
        status: "failed",
        content,
      },
      interruptedAt,
    );
    interrupted += 1;
  }
  await appendUnstartedToolResults(client, locked, runId, interruptedAt, interrupted, reason);
  if (effectState === "unknown") {
    return {
      toolEffectState: "unknown",
      unknownEffectSource: unknownEffectSource ?? "unclassified",
    };
  }
  return { toolEffectState: effectState };
}

type EventReceiptExpectation = {
  id: string;
  kind: string;
  event?: SessionEvent;
  createdAt: Date;
  visible?: boolean;
};

async function storedEventReceipt(
  client: PoolClient,
  locked: LockedRun,
  expected: EventReceiptExpectation,
): Promise<SessionEvent | undefined> {
  const result = await client.query<{
    run_id: string | null;
    session_id: string;
    kind: string;
    visible: boolean;
    payload: StoredSessionEvent;
    created_at: Date;
  }>(
    "SELECT run_id, session_id, kind, visible, payload, created_at FROM session_messages WHERE id = $1",
    [expected.id],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const event = decodeSessionEvent(row.payload);
  if (
    row.run_id !== locked.runId ||
    row.session_id !== locked.sessionId ||
    row.kind !== expected.kind ||
    row.visible !== (expected.visible ?? true) ||
    row.created_at.getTime() !== expected.createdAt.getTime() ||
    event.kind !== expected.kind ||
    (expected.event !== undefined &&
      !isDeepStrictEqual(event, normalizeSessionEvent(expected.event)))
  )
    throw new Error("Run event receipt identity conflict");
  return event;
}

function normalizeSessionEvent(event: SessionEvent): SessionEvent {
  // Compare the event as persisted, including JSON's treatment of undefined and
  // the codec's escaping of NUL and lone surrogates in Tool observations.
  const stored = JSON.parse(JSON.stringify(encodeSessionEvent(event))) as StoredSessionEvent;
  return decodeSessionEvent(stored);
}

async function storedUsage(
  client: PoolClient,
  locked: LockedRun,
  input: Parameters<RunEventRepository["appendUsage"]>[0],
): Promise<SessionEvent | undefined> {
  const event = await storedEventReceipt(client, locked, {
    id: input.id,
    kind: "usage",
    createdAt: input.createdAt,
  });
  if (event === undefined) return undefined;
  if (
    event.kind !== "usage" ||
    event.size !== input.contextSize ||
    !isDeepStrictEqual(event.measurement, JSON.parse(JSON.stringify(input.usage)))
  )
    throw new Error("Usage receipt identity conflict");
  return event;
}

async function requireToolStartReceipt(
  client: PoolClient,
  input: StartToolAttemptInput,
): Promise<void> {
  const id = deriveResourceId("toolattempt", "tool-start", input.id);
  const result = await client.query<{
    id: string;
    run_id: string;
    tool_call_id: string;
    source: string;
    source_id: string;
    tool_name: string;
    request_digest: string;
    started_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, run_id, tool_call_id, source, source_id, tool_name,
            request_digest, started_at, created_at
       FROM tool_attempts WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  // State, effects and completion evidence can advance after the start commits.
  if (
    row === undefined ||
    row.id !== id ||
    row.run_id !== input.runId ||
    row.tool_call_id !== input.toolCallId ||
    row.source !== input.tool.source ||
    row.source_id !== input.tool.sourceId ||
    row.tool_name !== input.tool.name ||
    row.request_digest !== input.requestDigest ||
    row.started_at?.getTime() !== input.createdAt.getTime() ||
    row.created_at.getTime() !== input.createdAt.getTime()
  )
    throw new Error("Tool start receipt identity conflict");
}

async function requireToolFinishReceipt(
  client: PoolClient,
  input: FinishToolAttemptInput,
): Promise<void> {
  const result = await client.query<{
    run_id: string;
    tool_call_id: string;
    state: string;
    tool_effect_state: ToolEffectState;
    result_summary: unknown;
    finished_at: Date | null;
    finish_runtime_call_stopped: boolean | null;
  }>(
    `SELECT run_id, tool_call_id, state, tool_effect_state, result_summary,
            finished_at, finish_runtime_call_stopped
       FROM tool_attempts WHERE run_id = $1 AND tool_call_id = $2`,
    [input.runId, input.toolCallId],
  );
  const row = result.rows[0];
  // Cleanup may advance runtime_call_stopped. A NULL original input is unknown
  // and cannot establish a receipt for a historical finish.
  if (
    row === undefined ||
    row.run_id !== input.runId ||
    row.tool_call_id !== input.toolCallId ||
    row.state !== input.status ||
    row.tool_effect_state !== input.toolEffectState ||
    !isDeepStrictEqual(row.result_summary, JSON.parse(JSON.stringify(input.resultSummary))) ||
    row.finished_at?.getTime() !== input.createdAt.getTime() ||
    row.finish_runtime_call_stopped !== (input.runtimeCallStopped === true)
  )
    throw new Error("Tool finish receipt identity conflict");
}

async function lockRunAndSession(
  client: PoolClient,
  runId: string,
  authority: RunWriteAuthority,
): Promise<LockedRun> {
  const locked = await lockSessionRun(client, runId, authority);
  requireRunning(locked.state);
  return locked;
}

function requireRunning(state: string): void {
  if (state !== "running") throw new Error("Run is not running");
}

async function lockSessionRun(
  client: PoolClient,
  runId: string,
  authority: RunWriteAuthority,
): Promise<LockedRun & { state: string; organizationId: string; agentId: string }> {
  const identity = await client.query<{ session_id: string }>(
    "SELECT session_id FROM runs WHERE id = $1",
    [runId],
  );
  const sessionId = requireRow(identity.rows[0], "Run does not exist").session_id;
  const session = await client.query<{
    last_message_sequence: string;
    organization_id: string;
    agent_id: string;
  }>(
    "SELECT last_message_sequence, organization_id, agent_id FROM acp_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  const sessionRow = requireRow(session.rows[0], "Session does not exist");
  authority.assertSession(sessionRow);
  const run = await client.query<RunOwnerColumns & { session_id: string; state: string }>(
    `SELECT session_id, state, organization_id, agent_id, execution_owner_registration_id,
      execution_owner_member_id, execution_owner_incarnation_id, execution_owner_epoch::text
     FROM runs WHERE id = $1 FOR UPDATE`,
    [runId],
  );
  const runRow = requireRow(run.rows[0], "Run does not exist");
  if (
    runRow.session_id !== sessionId ||
    runRow.organization_id !== sessionRow.organization_id ||
    runRow.agent_id !== sessionRow.agent_id
  ) {
    throw new Error("Run changed Session identity");
  }
  authority.assertRun(runRow);
  return {
    runId,
    sessionId,
    state: runRow.state,
    organizationId: runRow.organization_id,
    agentId: runRow.agent_id,
    nextSequence: Number(sessionRow.last_message_sequence) + 1,
  };
}

async function appendLocked(
  client: PoolClient,
  locked: LockedRun,
  id: string,
  kind: string,
  event: SessionEvent,
  createdAt: Date,
  visible = true,
): Promise<void> {
  await client.query(
    `INSERT INTO session_messages(
       id, session_id, run_id, sequence, kind, visible, payload, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      id,
      locked.sessionId,
      locked.runId,
      locked.nextSequence,
      kind,
      visible,
      JSON.stringify(encodeSessionEvent(event)),
      createdAt,
    ],
  );
  await client.query(
    "UPDATE acp_sessions SET last_message_sequence = $2, updated_at = $3 WHERE id = $1",
    [locked.sessionId, locked.nextSequence, createdAt],
  );
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new Error(message);
  }
  return row;
}

function combineEffects(current: ToolEffectState, next: ToolEffectState): ToolEffectState {
  if (current === "unknown" || next === "unknown") {
    return "unknown";
  }
  return current === "settled" || next === "settled" ? "settled" : "none";
}

async function appendUnstartedToolResults(
  client: PoolClient,
  locked: LockedRun,
  runId: string,
  interruptedAt: Date,
  sequenceOffset: number,
  reason: "service_restart" | "persistence_failure",
): Promise<void> {
  const assistant = await client.query<{ id: string; sequence: string; payload: unknown }>(
    `SELECT id, sequence, payload
       FROM session_messages
      WHERE run_id = $1
        AND kind = 'agent_message'
        AND (COALESCE(payload ->> 'toolCallsJson', '[]') <> '[]'
          OR (jsonb_typeof(payload -> 'toolCalls') = 'array' AND jsonb_array_length(payload -> 'toolCalls') > 0))
      ORDER BY sequence DESC
      LIMIT 1`,
    [runId],
  );
  const row = assistant.rows[0];
  if (row === undefined) {
    return;
  }
  const calls = recoveryToolCalls(decodeSessionEvent(row.payload as StoredSessionEvent));
  const events = await client.query<{ payload: unknown }>(
    `SELECT payload
       FROM session_messages
      WHERE run_id = $1 AND kind = 'tool_call' AND sequence > $2
      ORDER BY sequence`,
    [runId, row.sequence],
  );
  const terminal = new Set(
    events.rows
      .map((event) => terminalToolCallId(event.payload))
      .filter((toolCallId): toolCallId is string => toolCallId !== null),
  );
  let appended = 0;
  for (const call of calls) {
    if (terminal.has(call.id)) {
      continue;
    }
    const content = [
      {
        type: "text" as const,
        text:
          reason === "persistence_failure"
            ? "Tool was not executed because Run persistence was interrupted before dispatch."
            : "Tool was not executed because Agent ACP Service restarted before dispatch.",
      },
    ];
    await appendLocked(
      client,
      { ...locked, nextSequence: locked.nextSequence + sequenceOffset + appended },
      deriveResourceId("message", "tool-not-executed", JSON.stringify([row.id, call.id])),
      "tool_call",
      {
        kind: "tool_call",
        initial: true,
        toolCallId: call.id,
        title: call.name,
        modelName: call.name,
        status: "failed",
        content,
      },
      interruptedAt,
    );
    appended += 1;
  }
}

function recoveryToolCalls(value: unknown): Array<{ id: string; name: string }> {
  const event = asRecord(value, "Assistant Tool response is invalid");
  if (!Array.isArray(event.toolCalls)) {
    throw new Error("Assistant Tool calls are invalid");
  }
  return event.toolCalls.map((value) => {
    const call = asRecord(value, "Assistant Tool call is invalid");
    if (typeof call.id !== "string" || typeof call.name !== "string") {
      throw new Error("Assistant Tool call identity is invalid");
    }
    return { id: call.id, name: call.name };
  });
}

function terminalToolCallId(value: unknown): string | null {
  const event = asRecord(value, "Tool event is invalid");
  if (
    typeof event.toolCallId !== "string" ||
    typeof event.status !== "string" ||
    event.status === "pending" ||
    event.status === "in_progress"
  ) {
    return null;
  }
  return event.toolCallId;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}
