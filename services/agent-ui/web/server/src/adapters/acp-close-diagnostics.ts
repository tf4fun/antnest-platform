export type AcpCloseFailureStage = "delete_request" | "delete_body" | "delete_status" |
  "body_cleanup" | "deadline" | "receipt_count" | "stream_cleanup";

const codes = new Map([
  ["ECONNREFUSED", "connection_refused"], ["ECONNRESET", "connection_reset"],
  ["EPIPE", "broken_pipe"], ["ENOTFOUND", "name_unresolved"],
  ["ETIMEDOUT", "connection_timeout"], ["UND_ERR_CONNECT_TIMEOUT", "connection_timeout"],
  ["UND_ERR_SOCKET", "socket_closed"], ["ABORT_ERR", "aborted"],
]);

/** Never retain exception messages, arbitrary codes, headers or identity data. */
function causesOf(cause: unknown): { causes: string[]; truncated: boolean } {
  const causes: string[] = [], pending = [cause], seen = new Set<unknown>();
  let truncated = false;
  try {
    while (pending.length && causes.length < 16) {
      const current = pending.shift();
      if (current === null || typeof current !== "object") {
        causes.push("unknown");
        continue;
      }
      if (seen.has(current)) { truncated = true; continue; }
      seen.add(current);
      const value = current as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
      const code = value.code;
      const known = typeof code === "string" && code.length <= 64 ? codes.get(code) : undefined;
      const name = known ? undefined : value.name;
      causes.push(known ?? (name === "AbortError" ? "aborted" : name === "TimeoutError" ? "timeout" : "unknown"));
      const nested = value.cause;
      if (nested !== undefined) pending.push(nested);
      if (current instanceof AggregateError) {
        const errors = value.errors;
        if (Array.isArray(errors)) {
          pending.push(...errors.slice(0, 16));
          truncated ||= errors.length > 16;
        }
      }
    }
    truncated ||= pending.length > 0;
  } catch {
    causes.push("classification_failed");
    truncated = true;
  }
  return { causes: causes.slice(0, 16), truncated };
}

export class AcpCloseFailures {
  public count = 0;
  public truncated = false;
  public readonly entries: { stage: AcpCloseFailureStage; causes: string[]; truncated: boolean }[] = [];

  public record(stage: AcpCloseFailureStage, cause?: unknown): void {
    this.count++;
    if (this.entries.length === 16) { this.truncated = true; return; }
    const summary = causesOf(cause);
    this.truncated ||= summary.truncated;
    this.entries.push({ stage, ...summary });
  }
}

export type AcpCloseReceipt = {
  targetObserved: boolean;
  deleteAttempts: number;
  deleteResponses: number;
  deleteCompleted: number;
  deleteStatus: number;
  pendingRequests: number;
  streamJoined: boolean;
  failures: AcpCloseFailures;
};
