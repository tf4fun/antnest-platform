export class HttpBodyCleanupError extends Error {
  public constructor() {
    super("HTTP response body cleanup failed");
    this.name = "HttpBodyCleanupError";
  }
}

/** Forwards body reads while owning cancellation and final raw-reader release. */
export class OwnedHttpResponse {
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
    let terminalFailed = false, terminalError: unknown;
    void reader.closed.catch((error) => { terminalFailed = true; terminalError = error; });
    let complete!: () => void, fail!: (error: Error) => void;
    this.closed = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    void this.closed.catch(() => {});
    let ending = false, cancellationFailed = false;
    let reading: Promise<void> | undefined, cancellation: Promise<void> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const finish = () => {
      if (ending) return;
      ending = true;
      signal.removeEventListener("abort", abort);
      void Promise.resolve().then(async () => {
        // Neither task waits for this completion promise. In particular, raw
        // cancellation must not join the wrapper's own cancel callback.
        await reading;
        await cancellation;
        reader.releaseLock();
        if (cancellationFailed) throw new HttpBodyCleanupError();
      }).then(complete, () => fail(new HttpBodyCleanupError()));
    };
    const cancelRaw = () => {
      if (ending || cancellation) return;
      cancellation = (async () => {
        try { await reader.cancel(); }
        catch (error) {
          // Only the very same already-observed terminal error is harmless.
          // A failing active source cancellation, even rejection with undefined,
          // must survive cleanup without exposing its private diagnostic.
          if (!terminalFailed || error !== terminalError) cancellationFailed = true;
        } finally {
          finish();
          try { controller.close(); } catch { /* Already cancelled or errored. */ }
        }
      })();
    };
    this.cancel = () => { cancelRaw(); return this.closed; };
    const abort = () => { cancelRaw(); };
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull: (output) => {
        reading = (async () => {
          try {
            const next = await reader.read();
            if (ending) return;
            if (next.done) { finish(); output.close(); }
            else output.enqueue(next.value);
          } catch (error) { finish(); output.error(error); }
        })();
        return reading;
      },
      cancel: this.cancel,
    });
    this.response = new Response(body, { status: response.status,
      statusText: response.statusText, headers: response.headers });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
}
