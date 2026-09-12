import type { ConnectionBinding } from "../../domain/types.js";
import type { SessionEvent, SessionOutputSnapshot } from "../../ports/acp-application.js";

type OutputInput = {
  keepExisting?: boolean;
  key: string;
  connectionId: string;
  afterSequence?: number;
  initialState?: SessionOutputSnapshot["state"];
  read: (afterSequence: number | undefined) => Promise<SessionOutputSnapshot>;
  send: (event: SessionEvent) => Promise<void>;
  signal: AbortSignal;
  onFailure: (error: unknown) => void;
  beforeFirst?: () => Promise<void>;
  waitForDelivery?: boolean;
};

export function sessionOutputKey(binding: ConnectionBinding, sessionId: string): string {
  return JSON.stringify([binding.principalId, binding.agentId, binding.accessRevision, sessionId]);
}

// Invalidation is only a hint. A single database snapshot owns the transcript
// cursor and state, so replay/live handoff cannot lose or duplicate an event.
export class SessionOutputStreams {
  private readonly subscriptions = new Set<OutputSubscription>();

  public async attach(input: OutputInput): Promise<void> {
    for (const current of this.subscriptions) {
      if (
        input.keepExisting === true &&
        current.input.key === input.key &&
        current.input.connectionId === input.connectionId
      )
        return;
      if (current.input.key === input.key && current.input.connectionId === input.connectionId) {
        current.useSender(input.send);
        await current.flush();
        const cursor = current.cursor;
        if (cursor !== undefined)
          input = { ...input, afterSequence: Math.max(input.afterSequence ?? 0, cursor) };
        current.close();
      }
    }
    const subscription = new OutputSubscription(input, () =>
      this.subscriptions.delete(subscription),
    );
    this.subscriptions.add(subscription);
    subscription.start();
    await subscription.prepared.promise;
    if (input.waitForDelivery !== false) await subscription.flush();
  }

  public invalidate(key: string): void {
    for (const subscription of this.subscriptions) {
      if (subscription.input.key === key) subscription.refresh();
    }
  }

  public async flush(key: string, connectionId?: string): Promise<void> {
    await Promise.all(
      [...this.subscriptions]
        .filter(
          (subscription) =>
            subscription.input.key === key &&
            (connectionId === undefined || subscription.input.connectionId === connectionId),
        )
        .map((subscription) => subscription.flush()),
    );
  }

  public disconnect(connectionId: string): void {
    for (const subscription of this.subscriptions) {
      if (subscription.input.connectionId === connectionId) subscription.close();
    }
  }
}

class OutputSubscription {
  public readonly prepared = Promise.withResolvers<void>();
  public get cursor(): number | undefined {
    return this.sequence;
  }
  private readonly stop = new AbortController();
  private readonly parentAborted = () => this.close();
  private sequence: number | undefined;
  private state: string | undefined;
  private dirty = false;
  private pending: Promise<void> | undefined;
  private first = true;
  private send: OutputInput["send"];

  public constructor(
    public readonly input: OutputInput,
    private readonly remove: () => void,
  ) {
    this.send = input.send;
    this.sequence = input.afterSequence;
    this.state = input.initialState === undefined ? undefined : JSON.stringify(input.initialState);
  }

  public start(): void {
    this.input.signal.addEventListener("abort", this.parentAborted, { once: true });
    if (this.input.signal.aborted) this.close();
    else this.refresh();
  }

  public useSender(send: OutputInput["send"]): void {
    this.send = send;
  }

  public close(): void {
    this.prepared.resolve();
    this.stop.abort(new Error("Session output connection closed"));
    this.input.signal.removeEventListener("abort", this.parentAborted);
    this.remove();
  }

  public refresh(): void {
    if (this.stop.signal.aborted) return;
    this.dirty = true;
    this.pump();
  }

  public async flush(): Promise<void> {
    while (this.pending !== undefined) await this.pending;
  }

  private pump(): void {
    if (this.pending !== undefined) return;
    this.pending = this.drain()
      .catch((error: unknown) => {
        const report = !this.stop.signal.aborted;
        this.close();
        if (report) this.input.onFailure(error);
      })
      .finally(() => {
        this.pending = undefined;
        if (this.dirty && !this.stop.signal.aborted) this.pump();
      });
  }

  private async drain(): Promise<void> {
    while (this.dirty && !this.stop.signal.aborted) {
      this.dirty = false;
      const snapshot = await this.bounded(() => this.input.read(this.sequence));
      this.prepared.resolve();
      if (this.first && this.input.beforeFirst !== undefined)
        await this.bounded(this.input.beforeFirst);
      this.first = false;
      for (const event of snapshot.events) await this.bounded(() => this.send(event));
      const state = JSON.stringify(snapshot.state);
      if (state !== this.state) await this.bounded(() => this.send(snapshot.state));
      this.sequence = snapshot.sequence;
      this.state = state;
    }
  }

  private async bounded<T>(operation: () => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([operation(), aborted.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
