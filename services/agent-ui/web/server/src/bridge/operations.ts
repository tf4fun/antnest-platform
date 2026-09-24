import { createHash } from "node:crypto";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { IntentReceipt } from "../adapters/acp-http.ts";

export type PromptIntent = {
  sessionId: string;
  intentId: string;
  expectedAppendVersion: number;
  prompt: ContentBlock[];
};

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

  public submit(input: PromptIntent): {
    operationId: string;
    acceptance: "bridge";
    phase: "dispatching";
  } {
    const key = operationKey(input.sessionId, input.intentId);
    const digest = promptDigest(input);
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
      const retired = [...this.local].find(([, entry]) => entry.retired);
      if (retired === undefined)
        throw new OperationConflictError(
          "Bridge operation capacity is exhausted",
        );
      this.local.delete(retired[0]);
    }
    const heldWork = this.dependencies.retainWork();
    let released = false;
    const releaseWork = () => {
      if (released) return;
      released = true;
      heldWork();
    };
    const entry: LocalOperation = {
      digest,
      inFlight: true,
      retired: false,
      releaseWork,
      settled: Promise.resolve(),
      sessionId: input.sessionId,
      uncertainSince: null,
      operation: {
        operationId: input.intentId,
        sessionId: input.sessionId,
        acceptance: "bridge",
        phase: "dispatching",
      },
    };
    this.local.set(key, entry);
    this.dependencies.changed?.(input.sessionId);
    entry.settled = Promise.resolve()
      .then(() => this.dependencies.prompt(input))
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
      );
    return {
      operationId: input.intentId,
      acceptance: "bridge",
      phase: "dispatching",
    };
  }

  public settled(sessionId: string, intentId: string): Promise<void> {
    return (
      this.local.get(operationKey(sessionId, intentId))?.settled ??
      Promise.resolve()
    );
  }

  public hasInFlight(sessionId: string): boolean {
    return [...this.local.values()].some(
      (entry) => entry.sessionId === sessionId && entry.inFlight,
    );
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
    if (local?.inFlight === true) return { ...local.operation };
    if (local !== undefined && local.operation.phase !== "uncertain") {
      this.setOperation(local, {
        operationId: intentId,
        sessionId,
        phase: "uncertain",
        acceptance: "unknown",
      });
      this.dependencies.changed?.(sessionId);
    }
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
    const cancelling = { ...operation, phase: "cancelling" as const };
    const local = this.local.get(operationKey(sessionId, intentId));
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
    ...(receipt.errorClass === undefined ? {} : { errorClass: receipt.errorClass }),
  };
}

function terminal(phase: Operation["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}
