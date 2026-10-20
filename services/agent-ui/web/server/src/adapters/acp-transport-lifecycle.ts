import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { captureAcpCloseTrace, type AcpCloseTrigger } from "../telemetry.ts";
import { OwnedHttpResponse } from "./owned-http-response.ts";
import { AcpCloseFailures, type AcpCloseFailureStage } from "./acp-close-diagnostics.ts";

type HttpStream = ReturnType<typeof createHttpStream>;

/** Owns the SDK transport's actual cleanup, independently of Connection.closed. */
export class AcpTransportLifecycle {
  public readonly stream: HttpStream;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly trafficAbort = new AbortController();
  private readonly cleanupAbort = new AbortController();
  private readonly errors: Error[] = [];
  private readonly startTrace = captureAcpCloseTrace();
  private closeTrace: ReturnType<ReturnType<typeof captureAcpCloseTrace>> | undefined;
  private closing: Promise<void> | undefined;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private initializationTimer: ReturnType<typeof setTimeout> | undefined;
  private initialized = false;
  private targetObserved = false;
  private deletes = 0;
  private deleteResponses = 0;
  private deleteCompleted = 0;
  private deleteStatus = 0;
  private streamJoined = false;
  private connectionEnded = false;
  private closeTrigger: AcpCloseTrigger | undefined;
  private peerLossFailure: Error | undefined;
  private replaceAfterPeerLoss = false;
  private readonly failures = new AcpCloseFailures();
  private readonly stopStream: () => Promise<void>;
  private cancelInitialization: (() => void) | undefined;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly closeTimeoutMs: number;

  public constructor(url: string, input: {
    headers: Record<string, string>;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    closeTimeoutMs?: number;
  }) {
    this.closeTimeoutMs = input.closeTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.closeTimeoutMs) || this.closeTimeoutMs < 1 ||
      this.closeTimeoutMs > 5_000) throw new RangeError("Invalid ACP cleanup timeout");
    this.parentSignal = input.signal;
    const transport = createHttpStream(url, {
      headers: input.headers, cookies: "omit",
      fetch: (request, init) => this.track(this.fetch(input.fetchImpl, request, init)),
    });
    const reader = transport.readable.getReader();
    const writer = transport.writable.getWriter();
    void reader.closed.catch(() => {});
    void writer.closed.catch(() => {});
    let pulling: Promise<void> | undefined;
    this.stream = {
      readable: new ReadableStream({
        pull: (controller) => {
          pulling = (async () => {
            try {
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) { controller.error(error); }
          })();
          return pulling;
        },
        cancel: () => this.close(),
      }),
      writable: new WritableStream({
        write: (message) => writer.write(message),
        close: () => this.close(),
        abort: () => this.close(),
      }),
    };
    this.stopStream = async () => {
      // Start both before awaiting either: cancel aborts an in-flight initialize,
      // while the writer barrier joins its possible late connection DELETE.
      // Already-errored SDK streams reject cancellation with their original error;
      // the independent HTTP tracker retains actual cleanup failures instead.
      await Promise.allSettled([reader.cancel(), writer.abort()]);
      await pulling;
      reader.releaseLock();
      writer.releaseLock();
    };
  }

  public bindConnection(connection: { close(error?: Error): void; closed: Promise<unknown> }): void {
    this.cancelInitialization = () => {
      this.beginClose("initialization_failure");
      connection.close(new Error("ACP initialization was cancelled"));
      void this.close().catch(() => {});
    };
    this.initializationTimer = setTimeout(this.cancelInitialization, 10_000);
    this.parentSignal?.addEventListener("abort", this.cancelInitialization, { once: true });
    if (this.parentSignal?.aborted) this.cancelInitialization();
    // Keep the rejection observed without discarding the stable close result.
    // Never join this callback from close(), which would wait on itself.
    void connection.closed.then(() => {
      this.connectionEnded = true;
      return this.close();
    }).catch(() => {});
  }

  /** A retirement qualification; the original close promise still rejects. */
  public get canReplaceAfterPeerLoss(): boolean {
    return this.replaceAfterPeerLoss;
  }

  public completeInitialization(): void {
    if (this.closing || this.parentSignal?.aborted)
      throw new Error("ACP initialization was cancelled");
    this.initialized = true;
    this.detachInitialization();
  }

  public beginClose(trigger: AcpCloseTrigger): void {
    if (this.closeTrace) return;
    this.closeTrigger = trigger;
    this.detachInitialization();
    this.closeTrace = this.startTrace(trigger);
    this.cleanupTimer = setTimeout(() => {
      this.failures.record("deadline");
      this.errors.push(new Error("ACP cleanup deadline exceeded"));
      this.cleanupAbort.abort(new Error("ACP cleanup deadline exceeded"));
      this.trafficAbort.abort();
    }, this.closeTimeoutMs);
  }

  public close(): Promise<void> {
    if (this.closing) return this.closing;
    this.beginClose(this.initialized ? "transport_failure" : "initialization_failure");
    this.closing = Promise.resolve().then(async () => {
      try {
        const stopped = this.stopStream();
        this.trafficAbort.abort();
        try { await stopped; this.streamJoined = true; }
        catch (cause) { this.failures.record("stream_cleanup", cause); throw cause; }
        // SDK errorReadable() starts cleanup without awaiting it. Tasks can also
        // be added by a late initialize response, so drain to actual quiescence.
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        if (this.targetObserved && this.deletes !== 1) {
          this.failures.record("receipt_count");
          this.errors.push(new Error("ACP cleanup target has no unique DELETE receipt"));
        }
        if (this.errors.length) throw new AggregateError(this.errors, "ACP cleanup failed");
      } finally {
        clearTimeout(this.cleanupTimer);
        this.detachInitialization();
        this.closeTrace!.finish(this.errors.length || !this.streamJoined ? "failed" : this.deletes ? "closed" : "no_target", {
          targetObserved: this.targetObserved, deleteAttempts: this.deletes,
          deleteResponses: this.deleteResponses, deleteCompleted: this.deleteCompleted,
          deleteStatus: this.deleteStatus, pendingRequests: this.pending.size,
          streamJoined: this.streamJoined, failures: this.failures,
        });
        this.replaceAfterPeerLoss = this.closeTrigger === "transport_failure" &&
          this.initialized && this.connectionEnded && this.targetObserved &&
          this.deletes === 1 && this.deleteResponses === 0 && this.deleteCompleted === 0 &&
          this.streamJoined && this.pending.size === 0 &&
          this.peerLossFailure !== undefined &&
          this.errors.length === 1 && this.errors[0] === this.peerLossFailure;
      }
    });
    void this.closing.catch(() => {});
    return this.closing;
  }

  private detachInitialization(): void {
    clearTimeout(this.initializationTimer);
    if (this.cancelInitialization)
      this.parentSignal?.removeEventListener("abort", this.cancelInitialization);
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  private async fetch(fetchImpl: typeof fetch, input: Parameters<typeof fetch>[0],
    init?: RequestInit): Promise<Response> {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const deleting = method === "DELETE";
    if (deleting) {
      this.deletes++;
      this.beginClose(this.initialized ? "transport_failure" : "initialization_failure");
    }
    const signal = AbortSignal.any([
      ...(originalSignal ? [originalSignal] : []),
      deleting ? this.cleanupAbort.signal : this.trafficAbort.signal,
    ]);
    let phase: AcpCloseFailureStage = "delete_request";
    try {
      const response = await (deleting
        ? this.closeTrace!.fetch(fetchImpl, input, { ...init, signal })
        : fetchImpl(input, { ...init, signal }));
      const initializing = method === "POST" &&
        !new Headers(init?.headers).has("acp-connection-id");
      if (initializing && response.ok && response.headers.has("acp-connection-id"))
        this.targetObserved = true;
      if (deleting) {
        this.deleteResponses++;
        this.deleteStatus = response.status;
        phase = "delete_body";
        await discardCleanupBody(response);
        this.deleteCompleted++;
        phase = "delete_status";
        if (response.status !== 202) throw new Error("ACP DELETE was not accepted");
        return response;
      }
      return this.trackBody(response, signal);
    } catch (error) {
      if (!deleting) throw error;
      this.failures.record(phase, error);
      // Never retain remote response contents, preparation errors or credentials.
      const failure = new Error("ACP DELETE cleanup failed");
      if (phase === "delete_request" && isDisconnectedPeer(error))
        this.peerLossFailure = failure;
      this.errors.push(failure);
      throw failure;
    }
  }

  private trackBody(response: Response, signal: AbortSignal): Response {
    const owned = new OwnedHttpResponse(response, signal);
    this.track(owned.closed.catch(() => {
      this.failures.record("body_cleanup");
      this.errors.push(new Error("ACP response body cleanup failed"));
    }));
    return owned.response;
  }
}

// Inspect the complete owned fetch cause, not the bounded telemetry summary.
// Only native fetch wrappers and exclusively refused/reset connection leaves
// qualify. A reset has no acknowledgement; the original close still rejects.
function isDisconnectedPeer(error: unknown): boolean {
  const seen = new Set<Error>();
  const visit = (value: unknown, depth: number): boolean => {
    if (!(value instanceof Error) || depth > 8 || seen.size >= 32 || seen.has(value))
      return false;
    seen.add(value);
    const code = (value as Error & { code?: unknown }).code;
    const disconnected = code === "ECONNREFUSED" || code === "ECONNRESET";
    const hasCause = Object.hasOwn(value, "cause");
    if (value instanceof AggregateError) {
      return disconnected && Array.isArray(value.errors) &&
        value.errors.length > 0 && value.errors.length <= 16 &&
        value.errors.every((cause: unknown) => visit(cause, depth + 1)) &&
        (!hasCause || visit(value.cause, depth + 1));
    }
    if (disconnected)
      return !hasCause || visit(value.cause, depth + 1);
    return value instanceof TypeError && code === undefined && hasCause &&
      visit(value.cause, depth + 1);
  };
  try { return visit(error, 0); } catch { return false; }
}

async function discardCleanupBody(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let complete = false;
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { complete = true; return; }
      bytes += next.value.byteLength;
      if (bytes > 65_536) throw new Error("ACP cleanup response exceeded its limit");
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
