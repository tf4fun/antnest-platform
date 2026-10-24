export class HttpRelayBodyCleanupError extends AggregateError {
  public constructor(errors: readonly unknown[]) {
    super(errors, "Original HTTP relay response body cleanup failed");
    this.name = "HttpRelayBodyCleanupError";
  }
}

/** Forwards body reads while owning cancellation and final raw-reader release. */
export class OwnedRelayResponse {
  public readonly response: Response;
  public readonly closed: Promise<void>;
  public readonly cancel: () => Promise<void>;

  public constructor(response: Response, signal: AbortSignal) {
    if (!response.body) {
      this.response = response;
      this.closed = Promise.resolve();
      this.cancel = () => this.closed;
      return;
    }
    const reader = response.body.getReader();
    let terminalFailed = false;
    let terminalError: unknown;
    void reader.closed.catch((error: unknown) => {
      terminalFailed = true;
      terminalError = error;
    });
    let complete!: () => void;
    let fail!: (error: Error) => void;
    this.closed = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    void this.closed.catch(() => {});
    let ending = false;
    let cancellationFailed = false;
    const failures: unknown[] = [];
    let reading: Promise<void> | undefined;
    let cancellation: Promise<void> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const finish = () => {
      if (ending) return;
      ending = true;
      signal.removeEventListener("abort", abort);
      void Promise.resolve()
        .then(async () => {
          // Neither task waits for this completion promise. In particular, raw
          // cancellation must not join the wrapper's own cancel callback.
          const settled = await Promise.allSettled([reading, cancellation]);
          for (const result of settled)
            if (result.status === "rejected") failures.push(result.reason);
          try {
            reader.releaseLock();
          } catch (error) {
            failures.push(error);
          }
          if (cancellationFailed || failures.length) throw new HttpRelayBodyCleanupError(failures);
        })
        .then(complete, (error: unknown) =>
          fail(
            error instanceof HttpRelayBodyCleanupError
              ? error
              : new HttpRelayBodyCleanupError([error]),
          ),
        );
    };
    const cancelRaw = () => {
      if (ending || cancellation) return;
      cancellation = (async () => {
        try {
          await reader.cancel();
        } catch (error) {
          // Only the same already-observed terminal rejection is a duplicate.
          // Preserve independent cancellation failures, including undefined.
          if (!terminalFailed || error !== terminalError) {
            cancellationFailed = true;
            failures.push(error);
          }
        } finally {
          finish();
          try {
            controller.close();
          } catch {
            /* Already cancelled or errored. */
          }
        }
      })();
    };
    this.cancel = () => {
      cancelRaw();
      return this.closed;
    };
    const abort = () => {
      cancelRaw();
    };
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull: (output) => {
        reading = (async () => {
          try {
            const next = await reader.read();
            if (ending) return;
            if (next.done) {
              finish();
              output.close();
            } else output.enqueue(next.value);
          } catch (error) {
            finish();
            output.error(error);
          }
        })();
        return reading;
      },
      cancel: this.cancel,
    });
    this.response = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
}
