import {
  WorkspaceApiError,
  type BridgeHttpClient,
  type PromptAdmission,
} from "./workspace-api-client.ts";

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
};

type OperationApi = Pick<BridgeHttpClient, "prompt" | "operation" | "cancel">;

export class BridgeOperationTracker {
  private static readonly recentTerminalLimit = 64;
  private readonly agentId: string;
  private readonly api: OperationApi;
  private readonly changed: (operation: BridgeOperation) => void;
  private readonly operations = new Map<string, BridgeOperation>();
  private readonly terminals = new Set<string>();
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
    return [...this.operations.values()].map((operation) => ({ ...operation }));
  }

  async submit(sessionId: string, admission: PromptAdmission, signal?: AbortSignal): Promise<BridgeOperation> {
    this.ensureOpen();
    if (this.get(sessionId, admission.intentId) !== undefined)
      throw new Error("Prompt intent is already tracked");
    try {
      const accepted = await this.api.prompt(this.agentId, sessionId, admission, signal);
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
      if (!(cause instanceof WorkspaceApiError) || cause.recovery !== "query_operation" ||
        cause.operationId !== admission.intentId)
        throw cause;
      try {
        const recovered = operationFromWire(
          await this.api.operation(this.agentId, sessionId, admission.intentId, signal),
        );
        if (recovered !== null && recovered.sessionId === sessionId &&
          recovered.operationId === admission.intentId)
          return this.put(recovered);
      } catch (readError) {
        if (readError instanceof WorkspaceApiError &&
          (readError.status === 401 || readError.status === 403))
          throw readError;
      }
      return this.put({
        operationId: admission.intentId,
        sessionId,
        phase: "uncertain",
        acceptance: "unknown",
      });
    }
  }

  observe(values: readonly unknown[]): void {
    if (this.closed) return;
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
      if (!(cause instanceof WorkspaceApiError) ||
        (cause.status !== undefined && cause.status < 500)) throw cause;
      try {
        const recovered = operationFromWire(
          await this.api.operation(this.agentId, sessionId, intentId, signal),
        );
        if (recovered !== null && recovered.sessionId === sessionId &&
          recovered.operationId === intentId && recovered.runId === current.runId)
          return this.put(recovered);
      } catch (readError) {
        if (readError instanceof WorkspaceApiError &&
          (readError.status === 401 || readError.status === 403)) throw readError;
      }
      throw cause;
    }
    const result = operationFromWire(raw);
    if (result === null || result.sessionId !== sessionId ||
      result.operationId !== intentId || result.runId !== current.runId)
      throw new Error("Bridge returned an invalid cancellation result");
    return this.put(result);
  }

  close(): void {
    this.closed = true;
    this.operations.clear();
    this.terminals.clear();
  }

  private put(next: BridgeOperation): BridgeOperation {
    const item = key(next.sessionId, next.operationId);
    const current = this.operations.get(item);
    if (current !== undefined && (
      (current.runId !== undefined && next.runId !== undefined && current.runId !== next.runId) ||
      (isTerminal(current.phase) && !isTerminal(next.phase)) ||
      (current.acceptance === "acp" && next.acceptance !== "acp") ||
      (current.outputWatermark !== undefined && next.outputWatermark !== undefined &&
        next.outputWatermark < current.outputWatermark)
    )) return { ...current };
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(next))
      return { ...current };
    this.operations.set(item, { ...next });
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
    if (!this.closed) this.changed({ ...next });
    return { ...next };
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Bridge observation is closed");
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
  };
}

function key(sessionId: string, intentId: string): string {
  return JSON.stringify([sessionId, intentId]);
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
