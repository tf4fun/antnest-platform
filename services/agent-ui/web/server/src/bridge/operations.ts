import { createHash, randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { AcpPromptError, acpPromptRequestBytes, type IntentReceipt } from "../adapters/acp-http.ts";
import type { OperationError } from "../protocol/agent-view-delta.ts";

export type PromptIntent = {
  sessionId: string;
  intentId: string;
  expectedAppendVersion: number;
  prompt: ContentBlock[];
};

export type PreparedPrompt = Readonly<{ requestBytes: number }>;
export type RetryTicket = Readonly<{ release(): void }>;
type BridgeAcceptance = { operationId: string; acceptance: "bridge"; phase: "dispatching" };

export type Operation = {
  operationId: string;
  sessionId: string;
  phase:
    | "dispatching"
    | "accepted"
    | "running"
    | "awaiting_permission"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled"
    | "uncertain";
  acceptance: "bridge" | "acp" | "unknown";
  runId?: string;
  outputWatermark?: number;
  stopReason?: string | null;
  errorClass?: string | null;
  error?: OperationError;
};

type Dependencies = {
  prompt(input: PromptIntent): Promise<unknown>;
  readIntent(
    sessionId: string,
    intentId: string,
    signal?: AbortSignal,
  ): Promise<{ kind: "receipt"; receipt: IntentReceipt } | { kind: "unknown" }>;
  cancel(sessionId: string, expectedRunId: string): Promise<void>;
  retainWork(): () => void;
  changed?(sessionId: string): void;
  recordLocalIntentReuse?(outcome: "hit" | "conflict"): void;
  now?: () => number;
  reconcileTimeoutMs?: number;
};

type LocalOperation = {
  digest: string;
  inFlight: boolean;
  retired: boolean;
  releaseWork: () => void;
  settled: Promise<void>;
  sessionId: string;
  operation: Operation;
  uncertainSince: number | null;
  expectedAppendVersion: number;
  acceptedAppendVersion?: number;
};

type RetryAttempt = {
  key: string;
  sessionId: string;
  intentId: string;
  entry: LocalOperation | undefined;
  inFlightAtEntry: boolean;
  tickets: number;
  digest?: string;
  decision?: Promise<BridgeAcceptance>;
  completed: boolean;
  abort: AbortController;
  releaseWork: () => void;
};

export class OperationConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OperationConflictError";
  }
}

export class OperationReconciliationTimeoutError extends Error {
  public constructor() {
    super("Durable operation reconciliation timed out");
    this.name = "OperationReconciliationTimeoutError";
  }
}

export class OperationCoordinator {
  private readonly local = new Map<string, LocalOperation>();
  private readonly retries = new Map<string, RetryAttempt>();
  private readonly retryTickets = new WeakMap<RetryTicket, RetryAttempt>();
  private draining = false;
  private readonly prepared = new WeakMap<PreparedPrompt, {
    input: PromptIntent; digest: string; signal: AbortSignal | undefined;
  }>();
  private readonly dependencies: Dependencies;
  private readonly reconcileTimeoutMs: number;
  private readonly now: () => number;

  public constructor(dependencies: Dependencies) {
    if (!Number.isSafeInteger(dependencies.reconcileTimeoutMs ?? 30_000) ||
      (dependencies.reconcileTimeoutMs ?? 30_000) < 1)
      throw new RangeError("Invalid operation reconciliation deadline");
    this.dependencies = dependencies;
    this.now = dependencies.now ?? performance.now.bind(performance);
    this.reconcileTimeoutMs = dependencies.reconcileTimeoutMs ?? 30_000;
  }

  public snapshotMetrics(): { uncertainOperations: number; oldestUncertainMs: number } {
    let uncertainOperations = 0;
    let oldestUncertainMs = 0;
    const now = this.now();
    for (const entry of this.local.values()) {
      if (entry.uncertainSince === null) continue;
      uncertainOperations++;
      oldestUncertainMs = Math.max(oldestUncertainMs, now - entry.uncertainSince);
    }
    return { uncertainOperations, oldestUncertainMs: Math.max(0, oldestUncertainMs) };
  }

  private setOperation(entry: LocalOperation, operation: Operation): void {
    entry.uncertainSince = operation.phase === "uncertain"
      ? entry.uncertainSince ?? this.now() : null;
    entry.operation = operation;
  }

  public async prepare(input: PromptIntent, signal?: AbortSignal): Promise<PreparedPrompt> {
    signal?.throwIfAborted();
    // Capture metadata and ordinary JSON values before the first yield. Reuse
    // one serialization for both the historic digest and exact wire sizing.
    const captured = { ...input, prompt: canonical(input.prompt) as ContentBlock[] };
    const json = JSON.stringify(captured.prompt);
    const hash = createHash("sha256").update(JSON.stringify({
      expectedAppendVersion: captured.expectedAppendVersion, prompt: [],
    }).slice(0, -3));
    let requestBytes = acpPromptRequestBytes({ ...captured, prompt: [] }) - 2;
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < json.length;) {
      signal?.throwIfAborted();
      let end = Math.min(offset + chunkSize, json.length);
      if (end < json.length && json.charCodeAt(end - 1) >= 0xd800 && json.charCodeAt(end - 1) <= 0xdbff &&
        json.charCodeAt(end) >= 0xdc00 && json.charCodeAt(end) <= 0xdfff) end--;
      const bytes = Buffer.from(json.slice(offset, end));
      hash.update(bytes); requestBytes += bytes.length; offset = end;
      if (offset < json.length) await nextTurn();
    }
    signal?.throwIfAborted();
    const prepared = Object.freeze({ requestBytes });
    this.prepared.set(prepared, { input: captured, digest: hash.update("}").digest("hex"), signal });
    return prepared;
  }

  public submitPrepared(prepared: PreparedPrompt): BridgeAcceptance {
    const captured = this.prepared.get(prepared);
    if (captured === undefined) throw new Error("Invalid or consumed prepared Prompt");
    this.prepared.delete(prepared);
    captured.signal?.throwIfAborted();
    return this.commit(captured.input, captured.digest);
  }

  public beginRetry(sessionId: string, intentId: string): RetryTicket {
    if (this.draining) throw new Error("Bridge operations are draining");
    const key = operationKey(sessionId, intentId);
    let attempt = this.retries.get(key);
    if (attempt === undefined) {
      if (this.retries.size >= 256)
        throw new OperationConflictError("Bridge retry capacity is exhausted");
      const entry = this.local.get(key);
      attempt = {
        key, sessionId, intentId, entry,
        inFlightAtEntry: entry?.inFlight === true,
        tickets: 0, completed: false, abort: new AbortController(),
        releaseWork: this.retainWork(),
      };
      this.retries.set(key, attempt);
    }
    const owned = attempt;
    owned.tickets++;
    const ticket: RetryTicket = Object.freeze({ release: () => {
      if (!this.retryTickets.delete(ticket)) return;
      owned.tickets--;
      this.retireRetry(owned);
    } });
    this.retryTickets.set(ticket, owned);
    return ticket;
  }

  public async retryPrepared(prepared: PreparedPrompt, ticket?: RetryTicket): Promise<BridgeAcceptance> {
    const captured = this.prepared.get(prepared);
    if (captured === undefined) throw new Error("Invalid or consumed prepared Prompt");
    this.prepared.delete(prepared);
    captured.signal?.throwIfAborted();
    const ownedTicket = ticket ?? this.beginRetry(captured.input.sessionId, captured.input.intentId);
    try {
      const attempt = this.retryTickets.get(ownedTicket);
      if (attempt === undefined || attempt.key !== operationKey(captured.input.sessionId, captured.input.intentId))
        throw new Error("Invalid or released retry ticket");
      if ((attempt.entry !== undefined && attempt.entry.digest !== captured.digest) ||
        (attempt.digest !== undefined && attempt.digest !== captured.digest)) {
        this.dependencies.recordLocalIntentReuse?.("conflict");
        throw new OperationConflictError("Intent ID was already used with different input");
      }
      attempt.digest = captured.digest;
      if (attempt.decision === undefined) {
        if (this.draining) throw new Error("Bridge operations are draining");
        const signal = captured.signal === undefined ? attempt.abort.signal :
          AbortSignal.any([captured.signal, attempt.abort.signal]);
        attempt.decision = this.decideRetry(attempt, captured.input, signal);
        const completed = () => {
          attempt.completed = true;
          this.retireRetry(attempt);
        };
        void attempt.decision.then(completed, completed);
      }
      // Await the actual query/decision, including after caller cancellation.
      // The HTTP dispatch and its upload reservation remain owned until join.
      const accepted = await attempt.decision;
      captured.signal?.throwIfAborted();
      return accepted;
    } finally {
      if (ticket === undefined) ownedTicket.release();
    }
  }

  public beginDrain(): void {
    this.draining = true;
    for (const attempt of this.retries.values())
      attempt.abort.abort(new Error("Bridge operations are draining"));
  }

  public async joinRetryDecisions(): Promise<void> {
    while (true) {
      const pending = [...this.retries.values()].filter((attempt) =>
        attempt.decision !== undefined && !attempt.completed);
      if (pending.length === 0) return;
      await Promise.allSettled(pending.map((attempt) => attempt.decision!));
    }
  }

  private retireRetry(attempt: RetryAttempt): void {
    if (attempt.tickets !== 0 || (attempt.decision !== undefined && !attempt.completed)) return;
    if (this.retries.get(attempt.key) !== attempt) return;
    this.retries.delete(attempt.key);
    attempt.releaseWork();
  }

  private async decideRetry(attempt: RetryAttempt, input: PromptIntent, signal: AbortSignal): Promise<BridgeAcceptance> {
    const accepted: BridgeAcceptance = {
      operationId: input.intentId, acceptance: "bridge", phase: "dispatching",
    };
    const entry = attempt.entry;
    const hasReceipt = () => entry?.operation.acceptance === "acp";
    signal.throwIfAborted();
    if (hasReceipt() || attempt.inFlightAtEntry) return accepted;
    let result: Awaited<ReturnType<Dependencies["readIntent"]>>;
    try {
      result = await this.dependencies.readIntent(input.sessionId, input.intentId, signal);
    } catch (cause) {
      if (hasReceipt()) return accepted;
      signal.throwIfAborted();
      throw cause;
    }
    // A newer observed receipt wins even over a stale response or read failure.
    if (hasReceipt()) return accepted;
    if (result.kind === "receipt") {
      if (result.receipt.sessionId !== input.sessionId || result.receipt.intentId !== input.intentId)
        throw new OperationConflictError("ACP returned a receipt for another operation");
      if (entry !== undefined) {
        entry.acceptedAppendVersion = result.receipt.appendVersion;
        this.setOperation(entry, operationFromReceipt(result.receipt));
        if (terminal(entry.operation.phase)) {
          entry.retired = true;
          entry.releaseWork();
        }
        this.dependencies.changed?.(input.sessionId);
      }
      return accepted;
    }
    signal.throwIfAborted();
    if (entry === undefined || this.local.get(attempt.key) !== entry || entry.inFlight)
      return accepted;
    if (this.draining) throw new Error("Bridge operations are draining");
    // Reacquire work for this actual call. Its prior uncertain observation is
    // retained until a durable receipt arrives; another ACK proves no progress.
    entry.releaseWork = this.retainWork();
    entry.inFlight = true;
    entry.retired = false;
    this.dispatch(input, entry);
    return accepted;
  }

  public submit(input: PromptIntent): BridgeAcceptance {
    return this.commit(input, promptDigest(input));
  }

  private commit(input: PromptIntent, digest: string): BridgeAcceptance {
    if (this.draining) throw new Error("Bridge operations are draining");
    const key = operationKey(input.sessionId, input.intentId);
    const existing = this.local.get(key);
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        this.dependencies.recordLocalIntentReuse?.("conflict");
        throw new OperationConflictError(
          "Intent ID was already used with different input",
        );
      }
      this.dependencies.recordLocalIntentReuse?.("hit");
      return {
        operationId: input.intentId,
        acceptance: "bridge",
        phase: "dispatching",
      };
    }
    if (this.local.size >= 256) {
      const retired = [...this.local].find(([key, entry]) =>
        entry.retired && !entry.inFlight && !this.retries.has(key));
      if (retired === undefined)
        throw new OperationConflictError(
          "Bridge operation capacity is exhausted",
        );
      this.local.delete(retired[0]);
    }
    const releaseWork = this.retainWork();
    const entry: LocalOperation = {
      digest,
      inFlight: true,
      retired: false,
      releaseWork,
      settled: Promise.resolve(),
      sessionId: input.sessionId,
      uncertainSince: null,
      expectedAppendVersion: input.expectedAppendVersion,
      operation: {
        operationId: input.intentId,
        sessionId: input.sessionId,
        acceptance: "bridge",
        phase: "dispatching",
      },
    };
    this.local.set(key, entry);
    this.dependencies.changed?.(input.sessionId);
    this.dispatch(input, entry);
    return {
      operationId: input.intentId,
      acceptance: "bridge",
      phase: "dispatching",
    };
  }

  private retainWork(): () => void {
    const release = this.dependencies.retainWork();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  private dispatch(input: PromptIntent, entry: LocalOperation): void {
    entry.settled = Promise.resolve()
      .then(() => {
        if (this.draining) throw new Error("Bridge operations are draining");
        return this.dependencies.prompt(input);
      })
      .then(
        () => {
          entry.inFlight = false;
          entry.retired = true;
          entry.releaseWork();
          if (entry.operation.acceptance === "bridge") {
            this.setOperation(entry, {
              ...entry.operation,
              acceptance: "unknown",
              phase: "uncertain",
            });
            this.dependencies.changed?.(input.sessionId);
          }
        },
        (cause: unknown) => {
          entry.inFlight = false;
          entry.retired = true;
          entry.releaseWork();
          if (entry.operation.acceptance !== "acp") {
            // A refusal cannot prove that this intent was never accepted.
            // Keep querying the original intent; never turn retry guidance
            // into another Prompt dispatch or a synthetic durable outcome.
            const classification = cause instanceof AcpPromptError ? cause.classification : undefined;
            this.setOperation(entry, {
              ...entry.operation,
              acceptance: "unknown",
              phase: "uncertain",
              ...(classification === undefined ? {} : { error: {
                code: classification.code,
                message: classification.message,
                requestId: randomUUID(),
                operationId: input.intentId,
                retryable: false,
                recovery: "query_operation" as const,
              } }),
            });
            this.dependencies.changed?.(input.sessionId);
          }
        },
      );
  }

  public settled(sessionId: string, intentId: string): Promise<void> {
    return (
      this.local.get(operationKey(sessionId, intentId))?.settled ??
      Promise.resolve()
    );
  }

  public hasInFlight(sessionId: string): boolean {
    return [...this.local.values()].some(
      (entry) => entry.sessionId === sessionId && entry.inFlight && !terminal(entry.operation.phase),
    );
  }

  public knowsLocalVersion(sessionId: string, version: number): boolean {
    return [...this.local.values()].some((entry) => entry.sessionId === sessionId &&
      entry.acceptedAppendVersion === version && entry.expectedAppendVersion + 1 === version);
  }

  public knowsAppendTransition(sessionId: string, from: number, to: number): boolean {
    if (from > to) return false;
    let next = from;
    const admissions = [...this.local.values()].filter((entry) => entry.sessionId === sessionId);
    while (next < to) {
      if (!admissions.some((entry) => entry.expectedAppendVersion === next &&
        entry.acceptedAppendVersion === next + 1)) return false;
      next++;
    }
    return true;
  }

  public trackedSessionIds(): string[] {
    return [...new Set([...this.local.values()]
      .filter((entry) => !terminal(entry.operation.phase))
      .map((entry) => entry.sessionId))];
  }

  public async reconcileMissing(
    sessionId: string,
    recentReceipts: IntentReceipt[],
  ): Promise<void> {
    const recent = new Set(recentReceipts.map((receipt) => receipt.intentId));
    const missing = [...this.local.values()].filter((entry) =>
      entry.sessionId === sessionId &&
      !terminal(entry.operation.phase) &&
      !recent.has(entry.operation.operationId));
    if (missing.length === 0) return;
    const deadline = new AbortController();
    const timer = setTimeout(() =>
      deadline.abort(new OperationReconciliationTimeoutError()),
    this.reconcileTimeoutMs);
    timer.unref();
    try {
      for (let index = 0; index < missing.length; index += 8) {
        const batch = Promise.all(missing.slice(index, index + 8).map((entry) =>
          this.read(sessionId, entry.operation.operationId, deadline.signal)));
        await untilAborted(batch, deadline.signal);
      }
    } catch (error) {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  public observeReceipts(sessionId: string, receipts: IntentReceipt[]): void {
    for (const receipt of receipts) {
      if (receipt.sessionId !== sessionId)
        throw new OperationConflictError("ACP receipt scope mismatch");
      const local = this.local.get(operationKey(sessionId, receipt.intentId));
      if (local === undefined) continue;
      local.acceptedAppendVersion = receipt.appendVersion;
      this.setOperation(local, operationFromReceipt(receipt));
      if (terminal(local.operation.phase)) {
        local.retired = true;
        local.releaseWork();
      }
    }
  }

  public snapshot(sessionId: string, receipts: IntentReceipt[]): Operation[] {
    const operations = new Map<string, Operation>();
    for (const receipt of receipts) {
      if (receipt.sessionId !== sessionId)
        throw new OperationConflictError("ACP receipt scope mismatch");
      operations.set(receipt.intentId, operationFromReceipt(receipt));
    }
    for (const entry of this.local.values()) {
      if (entry.sessionId !== sessionId) continue;
      const durable = operations.get(entry.operation.operationId);
      if (
        durable === undefined ||
        (entry.operation.phase === "cancelling" &&
          durable.runId === entry.operation.runId &&
          !terminal(durable.phase))
      )
        operations.set(entry.operation.operationId, { ...entry.operation });
    }
    return [...operations.values()];
  }

  public async read(
    sessionId: string,
    intentId: string,
    signal?: AbortSignal,
  ): Promise<Operation> {
    const result = await this.dependencies.readIntent(sessionId, intentId, signal);
    signal?.throwIfAborted();
    const local = this.local.get(operationKey(sessionId, intentId));
    if (result.kind === "receipt") {
      if (
        result.receipt.sessionId !== sessionId ||
        result.receipt.intentId !== intentId
      )
        throw new OperationConflictError(
          "ACP returned a receipt for another operation",
        );
      const operation = operationFromReceipt(result.receipt);
      if (local !== undefined) local.acceptedAppendVersion = result.receipt.appendVersion;
      if (
        local !== undefined &&
        JSON.stringify(local.operation) !== JSON.stringify(operation)
      ) {
        this.setOperation(local, operation);
        this.dependencies.changed?.(sessionId);
      }
      if (local !== undefined && terminal(operation.phase)) {
        local.releaseWork();
        local.retired = true;
      }
      return operation;
    }
    // Absence is weaker evidence than an already observed durable receipt.
    if (local?.inFlight === true || local?.operation.acceptance === "acp")
      return { ...local.operation };
    if (local !== undefined && local.operation.phase !== "uncertain") {
      this.setOperation(local, {
        operationId: intentId,
        sessionId,
        phase: "uncertain",
        acceptance: "unknown",
      });
      this.dependencies.changed?.(sessionId);
    }
    if (local !== undefined) return { ...local.operation };
    return {
      operationId: intentId,
      sessionId,
      phase: "uncertain",
      acceptance: "unknown",
    };
  }

  public async cancel(
    sessionId: string,
    intentId: string,
    expectedRunId: string,
  ): Promise<Operation> {
    const operation = await this.read(sessionId, intentId);
    if (
      operation.acceptance !== "acp" ||
      operation.runId !== expectedRunId ||
      terminal(operation.phase)
    )
      throw new OperationConflictError("The requested Run is no longer active");
    await this.dependencies.cancel(sessionId, expectedRunId);
    const local = this.local.get(operationKey(sessionId, intentId));
    const latest = local?.operation ?? await this.read(sessionId, intentId);
    if (latest.acceptance !== "acp") return { ...latest };
    if (latest.runId !== expectedRunId)
      throw new OperationConflictError("The requested Run is no longer active");
    if (terminal(latest.phase)) return { ...latest };
    const cancelling = { ...latest, phase: "cancelling" as const };
    if (local !== undefined) {
      this.setOperation(local, cancelling);
      this.dependencies.changed?.(sessionId);
    }
    return cancelling;
  }
}

async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function operationKey(sessionId: string, intentId: string): string {
  return JSON.stringify([sessionId, intentId]);
}

function promptDigest(input: PromptIntent): string {
  const payload = JSON.stringify({
    expectedAppendVersion: input.expectedAppendVersion,
    prompt: canonical(input.prompt),
  });
  return createHash("sha256").update(payload).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

export function operationFromReceipt(receipt: IntentReceipt): Operation {
  return {
    operationId: receipt.intentId,
    sessionId: receipt.sessionId,
    acceptance: "acp",
    phase:
      receipt.phase === "persisting"
        ? "accepted"
        : receipt.phase === "unknown"
          ? "uncertain"
          : receipt.phase,
    runId: receipt.runId,
    outputWatermark: receipt.outputWatermark,
    stopReason: receipt.stopReason,
    errorClass: receipt.errorClass,
  };
}

function terminal(phase: Operation["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}
