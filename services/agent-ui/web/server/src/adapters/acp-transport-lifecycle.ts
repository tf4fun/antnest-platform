import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { captureAcpCloseTrace, type AcpCloseTrigger } from "../telemetry.ts";
import { OwnedHttpResponse } from "./owned-http-response.ts";

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
    void connection.closed.then(() => this.close()).catch(() => {});
  }

  public completeInitialization(): void {
    if (this.closing || this.parentSignal?.aborted)
      throw new Error("ACP initialization was cancelled");
    this.initialized = true;
    this.detachInitialization();
  }

  public beginClose(trigger: AcpCloseTrigger): void {
    if (this.closeTrace) return;
    this.detachInitialization();
    this.closeTrace = this.startTrace(trigger);
    this.cleanupTimer = setTimeout(() => {
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
        await stopped;
        // SDK errorReadable() starts cleanup without awaiting it. Tasks can also
        // be added by a late initialize response, so drain to actual quiescence.
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        if (this.targetObserved && this.deletes !== 1)
          this.errors.push(new Error("ACP cleanup target has no unique DELETE receipt"));
        if (this.errors.length) throw new AggregateError(this.errors, "ACP cleanup failed");
      } finally {
        clearTimeout(this.cleanupTimer);
        this.detachInitialization();
        this.closeTrace!.finish(this.errors.length ? "failed" : this.deletes ? "closed" : "no_target");
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
    try {
      const response = await (deleting
        ? this.closeTrace!.fetch(fetchImpl, input, { ...init, signal })
        : fetchImpl(input, { ...init, signal }));
      const initializing = method === "POST" &&
        !new Headers(init?.headers).has("acp-connection-id");
      if (initializing && response.ok && response.headers.has("acp-connection-id"))
        this.targetObserved = true;
      if (deleting) {
        await discardCleanupBody(response);
        if (response.status !== 202) throw new Error("ACP DELETE was not accepted");
        return response;
      }
      return this.trackBody(response, signal);
    } catch (error) {
      if (!deleting) throw error;
      // Never retain remote response contents, preparation errors or credentials.
      const failure = new Error("ACP DELETE cleanup failed");
      this.errors.push(failure);
      throw failure;
    }
  }

  private trackBody(response: Response, signal: AbortSignal): Response {
    const owned = new OwnedHttpResponse(response, signal);
    this.track(owned.closed.catch(() => {
      this.errors.push(new Error("ACP response body cleanup failed"));
    }));
    return owned.response;
  }
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
