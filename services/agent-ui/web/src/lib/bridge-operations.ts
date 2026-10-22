import {
  WorkspaceApiError,
  type BridgeHttpClient,
  type PromptAdmission,
} from "./workspace-api-client.ts";
import { parseOperationError, validOperation, type OperationError } from "../../server/src/protocol/agent-view-delta.ts";

export type BridgeOperation = {
  operationId: string;
  sessionId: string;
  phase: "dispatching" | "accepted" | "running" | "awaiting_permission" |
    "cancelling" | "completed" | "failed" | "cancelled" | "uncertain";
  acceptance: "bridge" | "acp" | "unknown";
  runId?: string;
  outputWatermark?: number;
  stopReason?: string | null;
  errorClass?: string | null;
  error?: OperationError;
  /** Local capability; never read from a remote operation or persisted. */
  retryAvailable?: boolean;
};

type OperationApi = Pick<BridgeHttpClient, "prompt" | "operation" | "cancel" | "sessionCurrent">;

export class BridgeOperationTracker {
  private static readonly recentTerminalLimit = 64;
  private readonly agentId: string;
  private readonly api: OperationApi;
  private readonly changed: (operation: BridgeOperation) => void;
  private readonly operations = new Map<string, BridgeOperation>();
  private readonly terminals = new Set<string>();
  private readonly retryInputs = new Map<string, { body: string; bytes: number }>();
  private readonly retryFlights = new Map<string, Promise<BridgeOperation>>();
  private readonly submissions = new Set<string>();
  private retryBytes = 0;
  private retryGeneration = 0;
  private retryAbort = new AbortController();
  private closed = false;

  constructor(input: {
    agentId: string;
    api: OperationApi;
    changed?: (operation: BridgeOperation) => void;
  }) {
    this.agentId = input.agentId;
    this.api = input.api;
    this.changed = input.changed ?? (() => {});
  }

  get(sessionId: string, intentId: string): BridgeOperation | undefined {
    const operation = this.operations.get(key(sessionId, intentId));
    return operation === undefined ? undefined : { ...operation };
  }

  get snapshot(): BridgeOperation[] {
    return [...this.operations.values()].map((operation) => this.withRetry(operation));
  }

  async submit(sessionId: string, admission: PromptAdmission, signal?: AbortSignal): Promise<BridgeOperation> {
    this.ensureOpen();
    const item = key(sessionId, admission.intentId);
    if (this.get(sessionId, admission.intentId) !== undefined || this.submissions.has(item))
      throw new Error("Prompt intent is already tracked");
    this.rememberInput(sessionId, admission);
    this.submissions.add(item);
    try {
      const accepted = await this.api.prompt(this.agentId, sessionId, admission, signal);
      this.ensureOpen();
      if (accepted.operationId !== admission.intentId ||
        accepted.acceptance !== "bridge" || accepted.phase !== "dispatching")
        throw new Error("Bridge returned an invalid Prompt receipt");
      return this.put({
        operationId: admission.intentId,
        sessionId,
        phase: "dispatching",
        acceptance: "bridge",
      });
    } catch (cause) {
      this.ensureOpen();
      if (!(cause instanceof WorkspaceApiError) || cause.recovery !== "query_operation" ||
        cause.operationId !== admission.intentId) {
        this.releaseInput(key(sessionId, admission.intentId));
        throw cause;
      }
      try {
        const recovered = operationFromWire(
          await this.api.operation(this.agentId, sessionId, admission.intentId, signal),
        );
        if (recovered !== null && recovered.sessionId === sessionId &&
          recovered.operationId === admission.intentId)
          return this.put(recovered);
      } catch (readError) {
        this.ensureOpen();
        if (readError instanceof WorkspaceApiError &&
          (readError.status === 401 || readError.status === 403 || readError.code === "browser_session_changed"))
          throw readError;
      }
      return this.put({
        operationId: admission.intentId,
        sessionId,
        phase: "uncertain",
        acceptance: "unknown",
      });
    } finally {
      this.submissions.delete(item);
      const current = this.get(sessionId, admission.intentId);
      if (current && this.hasRetry(sessionId, admission.intentId)) this.changed(this.withRetry(current));
    }
  }

  hasRetry(sessionId: string, intentId: string): boolean {
    const operation = this.operations.get(key(sessionId, intentId));
    return !this.closed && this.api.sessionCurrent() && operation !== undefined &&
      retryUnknown(operation) && !this.submissions.has(key(sessionId, intentId)) &&
      this.retryInputs.has(key(sessionId, intentId));
  }

  clearRetryInputs(): void {
    const affected = [...this.operations.values()].filter(operation =>
      this.hasRetry(operation.sessionId, operation.operationId));
    this.retryGeneration++;
    this.retryAbort.abort();
    this.retryAbort = new AbortController();
    this.retryInputs.clear();
    this.retryBytes = 0;
    if (!this.closed)
      for (const operation of affected) this.changed(this.withRetry(operation));
  }

  retry(sessionId: string, intentId: string, refreshHistory: () => Promise<string>, signal?: AbortSignal): Promise<BridgeOperation> {
    const item = key(sessionId, intentId);
    const existing = this.retryFlights.get(item);
    if (existing) return existing;
    const generation = this.retryGeneration;
    const originalPending = this.submissions.has(item);
    const scopedSignal = signal ? AbortSignal.any([signal, this.retryAbort.signal]) : this.retryAbort.signal;
    const currentScope = () => {
      this.ensureOpen();
      scopedSignal.throwIfAborted();
      if (generation !== this.retryGeneration)
        throw new Error("The original message is no longer available in this conversation.");
    };
    // Reserve the entire query/refresh/dispatch action before invoking any API.
    const task = Promise.resolve().then(async () => {
      currentScope();
      const raw = await this.api.operation(this.agentId, sessionId, intentId, scopedSignal);
      currentScope();
      const read = validOperation(raw) ? operationFromWire(raw) : null;
      if (read === null || read.sessionId !== sessionId || read.operationId !== intentId)
        throw new Error("The original message status could not be verified. Refresh this conversation.");
      let current = this.put(read);
      if (!retryUnknown(current)) return current;
      if (originalPending || this.submissions.has(item)) return current;
      if (!this.retryInputs.has(item)) return current; // Reload/eviction is query-only.
      const historyToken = await refreshHistory();
      currentScope();
      current = this.get(sessionId, intentId)!;
      // A late SSE or refreshed View receipt takes precedence over the earlier GET.
      if (!retryUnknown(current)) return current;
      if (typeof historyToken !== "string" || !historyToken.trim())
        throw new Error("A current history token is required before retrying the original message.");
      const original = this.retryInputs.get(item);
      if (!original) return current;
      const body = JSON.parse(original.body) as Omit<PromptAdmission, "historyToken">;
      try {
        const accepted = await this.api.prompt(this.agentId, sessionId, { ...body, historyToken }, scopedSignal, "retry");
        currentScope();
        if (accepted.operationId !== intentId || accepted.acceptance !== "bridge" || accepted.phase !== "dispatching")
          throw new Error("Bridge returned an invalid Prompt retry receipt");
        // 202 acknowledges dispatch only; it cannot replace a durable/uncertain receipt.
        return this.get(sessionId, intentId)!;
      } catch (cause) {
        currentScope();
        if (!(cause instanceof WorkspaceApiError) || cause.recovery !== "query_operation" || cause.operationId !== intentId)
          throw cause;
        // A lost retry ACK stays uncertain. No automatic replay is queued.
        return this.get(sessionId, intentId)!;
      }
    }).catch((cause: unknown) => {
      currentScope();
      if (cause instanceof WorkspaceApiError &&
        (cause.status === 401 || cause.status === 403 || cause.code === "browser_session_changed")) throw cause;
      const observed = this.get(sessionId, intentId);
      if (observed && (observed.acceptance === "acp" || observed.runId !== undefined || isTerminal(observed.phase)))
        return observed;
      throw cause;
    }).finally(() => {
      if (this.retryFlights.get(item) === task) this.retryFlights.delete(item);
    });
    this.retryFlights.set(item, task);
    return task;
  }

  observe(values: readonly unknown[]): void {
    if (this.closed || !this.api.sessionCurrent()) return;
    for (const value of values) {
      const operation = operationFromWire(value);
      if (operation !== null) this.put(operation);
    }
  }

  async cancel(sessionId: string, intentId: string, signal?: AbortSignal): Promise<BridgeOperation> {
    this.ensureOpen();
    const current = this.get(sessionId, intentId);
    if (current?.runId === undefined || isTerminal(current.phase))
      throw new Error("A current Run ID is required before cancellation");
    let raw: unknown;
    try {
      raw = await this.api.cancel(this.agentId, sessionId, intentId, current.runId, signal);
    } catch (cause) {
      this.ensureOpen();
      if (!(cause instanceof WorkspaceApiError) ||
        cause.code === "browser_session_changed" ||
        (cause.status !== undefined && cause.status < 500)) throw cause;
      try {
        const recovered = operationFromWire(
          await this.api.operation(this.agentId, sessionId, intentId, signal),
        );
        if (recovered !== null && recovered.sessionId === sessionId &&
          recovered.operationId === intentId && recovered.runId === current.runId)
          return this.put(recovered);
      } catch (readError) {
        this.ensureOpen();
        if (readError instanceof WorkspaceApiError &&
          (readError.status === 401 || readError.status === 403 || readError.code === "browser_session_changed")) throw readError;
      }
      throw cause;
    }
    this.ensureOpen();
    const result = operationFromWire(raw);
    if (result === null || result.sessionId !== sessionId ||
      result.operationId !== intentId || result.runId !== current.runId)
      throw new Error("Bridge returned an invalid cancellation result");
    return this.put(result);
  }

  close(): void {
    this.closed = true;
    this.clearRetryInputs();
    this.operations.clear();
    this.terminals.clear();
  }

  private put(next: BridgeOperation): BridgeOperation {
    this.ensureOpen();
    const item = key(next.sessionId, next.operationId);
    const current = this.operations.get(item);
    if (current !== undefined && (
      (current.runId !== undefined && next.runId !== undefined && current.runId !== next.runId) ||
      (current.runId !== undefined && next.runId === undefined) ||
      (isTerminal(current.phase) && !isTerminal(next.phase)) ||
      (current.acceptance === "acp" && next.acceptance !== "acp") ||
      (current.phase === "uncertain" && next.acceptance === "bridge" && next.phase === "dispatching") ||
      (current.outputWatermark !== undefined && next.outputWatermark !== undefined &&
        next.outputWatermark < current.outputWatermark)
    )) return { ...current };
    if (current?.error !== undefined && next.phase === "uncertain" &&
      next.acceptance === "unknown" && next.error === undefined)
      next = { ...next, error: current.error };
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(next))
      return { ...current };
    this.operations.set(item, { ...next });
    if (next.acceptance === "acp" || next.runId !== undefined || isTerminal(next.phase))
      this.releaseInput(item);
    this.terminals.delete(item);
    if (isTerminal(next.phase)) {
      this.terminals.add(item);
      while (this.terminals.size > BridgeOperationTracker.recentTerminalLimit) {
        const oldest = this.terminals.values().next().value;
        if (oldest === undefined) break;
        this.terminals.delete(oldest);
        this.operations.delete(oldest);
      }
    }
    if (!this.closed) this.changed(this.withRetry(next));
    return { ...next };
  }

  private withRetry(operation: BridgeOperation): BridgeOperation {
    return { ...operation, ...(this.hasRetry(operation.sessionId, operation.operationId) ? { retryAvailable: true } : {}) };
  }

  private rememberInput(sessionId: string, admission: PromptAdmission): void {
    const body = JSON.stringify({ intentId: admission.intentId,
      expectedAppendVersion: admission.expectedAppendVersion, prompt: admission.prompt });
    const bytes = new TextEncoder().encode(body).byteLength;
    const limit = 64 * 1024 * 1024;
    // Retention is optional: it must not change ordinary Prompt admission.
    if (bytes > limit) return;
    while (this.retryInputs.size >= 4 || this.retryBytes + bytes > limit) {
      const oldest = this.retryInputs.keys().next().value;
      if (oldest === undefined) break;
      this.releaseInput(oldest);
    }
    const item = key(sessionId, admission.intentId);
    this.releaseInput(item);
    this.retryInputs.set(item, { body, bytes });
    this.retryBytes += bytes;
  }

  private releaseInput(item: string): void {
    const input = this.retryInputs.get(item);
    if (input) this.retryBytes -= input.bytes;
    this.retryInputs.delete(item);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Bridge observation is closed");
    if (!this.api.sessionCurrent()) throw new WorkspaceApiError("The browser session changed.",
      undefined, "browser_session_changed", "none");
  }
}

function operationFromWire(raw: unknown): BridgeOperation | null {
  if (!isRecord(raw) || typeof raw.operationId !== "string" || !raw.operationId ||
    typeof raw.sessionId !== "string" || !raw.sessionId ||
    !phase(raw.phase) || !acceptance(raw.acceptance)) return null;
  if (raw.acceptance === "acp" &&
    (typeof raw.runId !== "string" || !raw.runId ||
      !Number.isSafeInteger(raw.outputWatermark) || (raw.outputWatermark as number) < 0))
    return null;
  const error = parseOperationError(raw.error);
  const promptError = raw.phase === "uncertain" && raw.acceptance === "unknown" &&
    error?.operationId === raw.operationId && error.retryable === false &&
    error.recovery === "query_operation" ? error : undefined;
  return {
    operationId: raw.operationId,
    sessionId: raw.sessionId,
    phase: raw.phase,
    acceptance: raw.acceptance,
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(typeof raw.outputWatermark === "number" ? { outputWatermark: raw.outputWatermark } : {}),
    ...(typeof raw.stopReason === "string" || raw.stopReason === null
      ? { stopReason: raw.stopReason } : {}),
    ...(typeof raw.errorClass === "string" && raw.errorClass.length <= 128 || raw.errorClass === null
      ? { errorClass: raw.errorClass as string | null } : {}),
    ...(promptError === undefined ? {} : { error: promptError }),
  };
}

function key(sessionId: string, intentId: string): string {
  return JSON.stringify([sessionId, intentId]);
}

function retryUnknown(operation: BridgeOperation): boolean {
  return operation.phase === "uncertain" && operation.acceptance === "unknown" &&
    operation.runId === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function phase(value: unknown): value is BridgeOperation["phase"] {
  return value === "dispatching" || value === "accepted" || value === "running" ||
    value === "awaiting_permission" || value === "cancelling" ||
    value === "completed" || value === "failed" || value === "cancelled" ||
    value === "uncertain";
}

function acceptance(value: unknown): value is BridgeOperation["acceptance"] {
  return value === "bridge" || value === "acp" || value === "unknown";
}

function isTerminal(value: BridgeOperation["phase"]): boolean {
  return value === "completed" || value === "failed" || value === "cancelled";
}
