import type { ToolProgressUpdate } from "../ports/tools.js";

const FLUSH_INTERVAL_MS = 100;
const MAX_PREVIEW_BYTES = 16_384;
const MAX_UPDATES = 32;
const TRUNCATED = "\n[Tool progress preview truncated]";
const TEXT_BUDGET = MAX_PREVIEW_BYTES - Buffer.byteLength(TRUNCATED);

/** One in-flight write plus a bounded snapshot, even when the SDK cannot await callbacks. */
export class ToolProgress {
  private readonly failed = new AbortController();
  private text = "";
  private bytes = 0;
  private lastProgress = -1;
  private updates = 0;
  private truncated = false;
  private dirty = false;
  private closed = false;
  private writing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(private readonly emit: (text: string) => Promise<void>) {}

  public get signal(): AbortSignal {
    return this.failed.signal;
  }

  public append(update: ToolProgressUpdate): void {
    if (this.closed || this.truncated || this.failed.signal.aborted) return;
    if (!validProgress(update, this.lastProgress)) return;
    this.lastProgress = update.progress;
    const message = update.message || numericProgress(update);
    const remaining = TEXT_BUDGET - this.bytes;
    const prefix = this.text.length === 0 ? "" : "\n";
    const added = utf8Prefix(prefix + message, remaining);
    this.text += added;
    this.bytes += Buffer.byteLength(added);
    this.truncated = added.length < prefix.length + message.length;
    this.dirty = true;
    this.schedule();
  }

  public async finish(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.writing;
    this.failed.signal.throwIfAborted();
    await this.flush();
    this.failed.signal.throwIfAborted();
  }

  private schedule(): void {
    if (this.closed || this.writing !== undefined || this.timer !== undefined) return;
    if (this.updates === 0) {
      void this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private flush(): Promise<void> {
    if (!this.dirty || this.failed.signal.aborted) return Promise.resolve();
    this.dirty = false;
    this.updates++;
    this.truncated ||= this.updates === MAX_UPDATES;
    const snapshot = this.text + (this.truncated ? TRUNCATED : "");
    this.writing = this.write(snapshot).finally(() => {
      this.writing = undefined;
      if (this.dirty && !this.failed.signal.aborted) this.schedule();
    });
    return this.writing;
  }

  private async write(snapshot: string): Promise<void> {
    try {
      await this.emit(snapshot);
    } catch (error) {
      this.failed.abort(error);
    }
  }
}

function validProgress(update: ToolProgressUpdate, previous: number): boolean {
  return (
    Number.isFinite(update.progress) &&
    update.progress >= 0 &&
    update.progress >= previous &&
    (update.total === undefined || (Number.isFinite(update.total) && update.total > 0))
  );
}

function numericProgress(update: ToolProgressUpdate): string {
  return update.total === undefined
    ? `Progress: ${update.progress}`
    : `Progress: ${update.progress} / ${update.total}`;
}

function utf8Prefix(text: string, budget: number): string {
  let end = 0;
  let bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > budget) break;
    end += character.length;
  }
  return text.slice(0, end);
}
