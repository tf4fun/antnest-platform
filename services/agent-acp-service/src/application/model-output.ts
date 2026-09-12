import type { ModelDelta } from "../ports/model.js";

const MAX_CHUNK_CHARACTERS = 4096;
const FLUSH_INTERVAL_MS = 100;

export class ModelOutput {
  private pending: ModelDelta | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly failed = new AbortController();
  private first = true;
  private closed = false;
  public readonly kinds = new Set<ModelDelta["kind"]>();

  public constructor(private readonly write: (delta: ModelDelta) => Promise<void>) {}

  public get signal(): AbortSignal {
    return this.failed.signal;
  }

  public append(delta: ModelDelta): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Model output is closed"));
    return this.enqueue(async () => {
      if (delta.text.length === 0) return;
      this.kinds.add(delta.kind);
      if (this.pending !== undefined && this.pending.kind !== delta.kind) await this.flush();
      let remaining = delta.text;
      while (remaining.length > 0) {
        this.pending ??= { kind: delta.kind, text: "" };
        let size = Math.min(MAX_CHUNK_CHARACTERS - this.pending.text.length, remaining.length);
        if (size < remaining.length && /[\uD800-\uDBFF]/u.test(remaining.charAt(size - 1))) size--;
        if (size === 0) {
          await this.flush();
          continue;
        }
        this.pending.text += remaining.slice(0, size);
        remaining = remaining.slice(size);
        if (this.first || this.pending.text.length >= MAX_CHUNK_CHARACTERS) await this.flush();
      }
      if (this.pending !== undefined && this.timer === undefined) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          // enqueue retains the failure and aborts model IO; finish rethrows it.
          void this.enqueue(() => this.flush()).catch(() => undefined);
        }, FLUSH_INTERVAL_MS);
      }
    });
  }

  public async finish(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    await this.queue;
    await this.enqueue(() => this.flush());
    this.clearTimer();
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(() => {
      this.failed.signal.throwIfAborted();
      return work();
    });
    this.queue = next.catch((error: unknown) => {
      this.failed.abort(error);
    });
    return next;
  }

  private async flush(): Promise<void> {
    this.clearTimer();
    const delta = this.pending;
    this.pending = undefined;
    if (delta === undefined) return;
    await this.write(delta);
    this.first = false;
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
