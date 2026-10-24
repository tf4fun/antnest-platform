import type { ConnectionBinding } from "../../domain/types.js";
import { DomainError } from "../../domain/errors.js";
import {
  isExecutionAccessRevoked,
  type ExecutionAccessSnapshot,
  type ExecutionIdentity,
} from "../../domain/execution-configuration.js";
import type { DeliveredSessionEvent, SessionOutputSnapshot } from "../../ports/acp-application.js";

type OutputInput = {
  identity: ExecutionIdentity;
  keepExisting?: boolean;
  key: string;
  connectionId: string;
  afterSequence?: number;
  initialState?: SessionOutputSnapshot["state"];
  configurationInResponse?: boolean;
  previousConfiguration?: string;
  previousInfo?: string;
  read: (afterSequence: number | undefined) => Promise<SessionOutputSnapshot>;
  send: (event: DeliveredSessionEvent) => Promise<void>;
  checkpoint?: (sequence: number) => Promise<void>;
  signal: AbortSignal;
  onFailure: (error: unknown) => void;
  beforeFirst?: () => Promise<void>;
  waitForDelivery?: boolean;
};

export function sessionOutputKey(binding: ConnectionBinding, sessionId: string): string {
  return JSON.stringify([binding.organizationId, binding.principalId, binding.agentId, sessionId]);
}

// Invalidation is only a hint. A single database snapshot owns the transcript
// cursor and state, so replay/live handoff cannot lose or duplicate an event.
export class SessionOutputStreams {
  private readonly subscriptions = new Set<OutputSubscription>();
  private readonly owned = new Set<OutputSubscription>();
  private readonly latestAccess = new Map<string, ExecutionAccessSnapshot>();
  private readonly cleanupFailures: { identity: ExecutionIdentity; error: unknown }[] = [];
  private readonly attachments = new Set<{
    input: OutputInput;
    cancelled: boolean;
    finished: PromiseWithResolvers<void>;
  }>();

  public async attach(input: OutputInput): Promise<boolean> {
    const attachment = { input, cancelled: false, finished: Promise.withResolvers<void>() };
    this.attachments.add(attachment);
    try {
      return await this.attachCurrent(input, () => {
        const current = this.latestAccess.get(input.identity.organizationId);
        return (
          attachment.cancelled ||
          (current !== undefined && isExecutionAccessRevoked(current, input.identity))
        );
      });
    } finally {
      this.attachments.delete(attachment);
      attachment.finished.resolve();
    }
  }

  private async attachCurrent(input: OutputInput, cancelled: () => boolean): Promise<boolean> {
    if (cancelled() || input.signal.aborted) return false;
    for (const current of this.subscriptions) {
      if (
        input.keepExisting === true &&
        current.input.key === input.key &&
        current.input.connectionId === input.connectionId
      )
        return true;
      if (current.input.key === input.key && current.input.connectionId === input.connectionId) {
        current.useSender(input.send, input.checkpoint);
        await current.flush();
        if (cancelled()) return false;
        const cursor = current.cursor;
        const previousConfiguration = current.configurationFingerprint;
        if (previousConfiguration !== undefined) input = { ...input, previousConfiguration };
        const previousInfo = current.infoFingerprint;
        if (previousInfo !== undefined) input = { ...input, previousInfo };
        if (cursor !== undefined)
          input = { ...input, afterSequence: Math.max(input.afterSequence ?? 0, cursor) };
        current.close();
      }
    }
    if (cancelled() || input.signal.aborted) return false;
    const subscription = new OutputSubscription(input, () => {
      this.subscriptions.delete(subscription);
      // A cancellation race can settle attach/flush before the original I/O.
      // Retain that original subscription until its owned operations settle.
      void subscription.join().then(
        () => this.owned.delete(subscription),
        (error: unknown) => {
          this.cleanupFailures.push({ identity: input.identity, error });
          this.owned.delete(subscription);
        },
      );
    });
    this.subscriptions.add(subscription);
    this.owned.add(subscription);
    subscription.start();
    await subscription.prepared.promise;
    if (input.waitForDelivery !== false) await subscription.flush();
    return !cancelled() && !subscription.closed;
  }

  public detach(key: string): void {
    for (const attachment of this.attachments) {
      if (attachment.input.key === key) attachment.cancelled = true;
    }
    for (const subscription of this.subscriptions) {
      if (subscription.input.key === key) subscription.close();
    }
  }

  public invalidate(key: string): void {
    for (const subscription of this.subscriptions) {
      if (subscription.input.key === key) subscription.refresh();
    }
  }

  public invalidateOrganization(organizationId: string): void {
    for (const subscription of this.subscriptions) {
      if (subscription.input.identity.organizationId === organizationId) subscription.refresh();
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
    for (const attachment of this.attachments) {
      if (attachment.input.connectionId === connectionId) attachment.cancelled = true;
    }
    for (const subscription of this.subscriptions) {
      if (subscription.input.connectionId === connectionId) subscription.close();
    }
  }

  public async revokeAccess(snapshot: ExecutionAccessSnapshot): Promise<void> {
    this.latestAccess.set(snapshot.organization_id, structuredClone(snapshot));
    const joins: Promise<unknown>[] = [];
    for (const attachment of this.attachments) {
      if (isExecutionAccessRevoked(snapshot, attachment.input.identity)) {
        attachment.cancelled = true;
        joins.push(attachment.finished.promise);
      }
    }
    for (const subscription of this.owned) {
      if (isExecutionAccessRevoked(snapshot, subscription.input.identity)) {
        subscription.close();
        joins.push(subscription.join());
      }
    }
    const results = await Promise.allSettled(joins);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    failures.push(
      ...this.cleanupFailures
        .filter((item) => isExecutionAccessRevoked(snapshot, item.identity))
        .map((item) => item.error),
    );
    if (failures.length)
      throw new AggregateError([...new Set(failures)], "Session output revocation failed");
  }
}

class OutputSubscription {
  public get infoFingerprint(): string | undefined {
    return this.info;
  }
  public get closed(): boolean {
    return this.stop.signal.aborted;
  }
  public get configurationFingerprint(): string | undefined {
    return this.configuration;
  }
  public readonly prepared = Promise.withResolvers<void>();
  public get cursor(): number | undefined {
    return this.sequence;
  }
  private readonly stop = new AbortController();
  private readonly parentAborted = () => this.close();
  private sequence: number | undefined;
  private state: string | undefined;
  private configuration: string | undefined;
  private info: string | undefined;
  private dirty = false;
  private pending: Promise<void> | undefined;
  private readonly originals = new Set<Promise<unknown>>();
  private readonly lateFailures: unknown[] = [];
  private first = true;
  private send: OutputInput["send"];
  private checkpoint: OutputInput["checkpoint"];

  public constructor(
    public readonly input: OutputInput,
    private readonly remove: () => void,
  ) {
    this.send = input.send;
    this.checkpoint = input.checkpoint;
    this.configuration = input.previousConfiguration;
    this.info = input.previousInfo;
    this.sequence = input.afterSequence;
    this.state = input.initialState === undefined ? undefined : JSON.stringify(input.initialState);
  }

  public start(): void {
    this.input.signal.addEventListener("abort", this.parentAborted, { once: true });
    if (this.input.signal.aborted) this.close();
    else this.refresh();
  }

  public useSender(send: OutputInput["send"], checkpoint: OutputInput["checkpoint"]): void {
    this.send = send;
    this.checkpoint = checkpoint;
  }

  public close(): void {
    if (this.closed) return;
    this.prepared.resolve();
    this.stop.abort(new Error("Session output connection closed"));
    this.input.signal.removeEventListener("abort", this.parentAborted);
    this.remove();
  }

  public async join(): Promise<void> {
    // Called outside the pump. Its pending continuation can own a read/send
    // even after bounded() has observed cancellation.
    await this.pending;
    while (this.originals.size > 0) await Promise.allSettled([...this.originals]);
    if (this.lateFailures.length)
      throw new AggregateError(
        this.lateFailures,
        "Original output operations failed after cancellation",
      );
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
        // Deletion invalidates this Session, not every Session on its transport.
        if (report && !(error instanceof DomainError && error.code === "session_not_found"))
          this.input.onFailure(error);
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
      const configurationInResponse = this.first && this.input.configurationInResponse === true;
      this.first = false;
      let lastMarkedSequence = this.sequence ?? 0;
      const info = JSON.stringify(snapshot.info);
      if (snapshot.info !== undefined && info !== this.info)
        await this.bounded(() => this.send({ kind: "session_info", ...snapshot.info! }));
      this.info = info;
      for (const event of snapshot.events) {
        if (event.kind === "state" && this.checkpoint !== undefined) continue;
        if (event.kind === "configuration" && snapshot.configuration !== undefined) continue;
        if (
          this.checkpoint !== undefined &&
          event.delivery !== undefined &&
          event.delivery.sequence > lastMarkedSequence + 1
        ) {
          await this.bounded(() => this.checkpoint!(event.delivery!.sequence - 1));
        }
        await this.bounded(() => this.send(event));
        if (event.delivery !== undefined)
          lastMarkedSequence = Math.max(lastMarkedSequence, event.delivery.sequence);
      }
      const configuration = JSON.stringify(snapshot.configuration);
      if (
        snapshot.configuration !== undefined &&
        configuration !== this.configuration &&
        !configurationInResponse
      ) {
        await this.bounded(() =>
          this.send({ kind: "configuration", configuration: snapshot.configuration! }),
        );
      }
      this.configuration = configuration;
      const state = JSON.stringify(snapshot.state);
      if (state !== this.state) await this.bounded(() => this.send(snapshot.state));
      if (this.checkpoint !== undefined && snapshot.sequence > lastMarkedSequence)
        await this.bounded(() => this.checkpoint!(snapshot.sequence));
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
      const tracked = Promise.withResolvers<T>();
      const original = tracked.promise;
      this.originals.add(original);
      void original.then(
        () => this.originals.delete(original),
        (error: unknown) => {
          this.originals.delete(original);
          if (
            this.closed &&
            error !== signal.reason &&
            error !== this.input.signal.reason &&
            !(
              error instanceof DomainError &&
              ["access_denied", "session_not_found"].includes(error.code)
            )
          ) {
            this.lateFailures.push(error);
            try {
              this.input.onFailure(error);
            } catch {
              /* Reporting cannot abandon the original join. */
            }
          }
        },
      );
      try {
        tracked.resolve(operation());
      } catch (error) {
        tracked.reject(error);
      }
      return await Promise.race([original, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
