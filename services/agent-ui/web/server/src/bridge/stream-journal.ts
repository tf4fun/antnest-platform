import { createHmac, timingSafeEqual } from "node:crypto";
import type { BridgeScope } from "./registry.ts";

type Body = {
  type: "operation" | "permission" | "delta";
  [key: string]: unknown;
};

type EncodedEvent = { json?: string; bytes: number; frame?: Uint8Array };
const encodedEvents = new WeakMap<object, EncodedEvent>();
const frameEncoder = new TextEncoder();

function encoding(event: object): EncodedEvent {
  let cached = encodedEvents.get(event);
  if (!cached) {
    const json = JSON.stringify(event);
    cached = { json, bytes: Buffer.byteLength(json) };
    encodedEvents.set(event, cached);
  }
  return cached;
}

export function encodedStreamFrame(event: StreamEvent<unknown>): Uint8Array {
  const cached = encoding(event);
  if (cached.frame === undefined) {
    cached.frame = frameEncoder.encode(
      `id: ${event.cursor}\nevent: ${event.type}\ndata: ${cached.json}\n\n`,
    );
    // The wire buffer now owns the JSON bytes; retaining the string as well
    // would keep two copies for every journaled event that reached HTTP.
    cached.json = undefined;
  }
  return cached.frame;
}

export type StreamEvent<View> = {
  type: "snapshot" | "reset" | Body["type"];
  agentId: string;
  bridgeEpoch: string;
  projectionId: string;
  fromStreamRevision: number;
  toStreamRevision: number;
  cursor: string;
  view?: View;
  [key: string]: unknown;
};

type Subscriber<View> = {
  push(event: StreamEvent<View>): void;
  reset(): void;
  close(): void;
  queuedBytes(): number;
};

export class StreamCapacityError extends Error {
  public constructor() {
    super("Workspace stream exceeds Bridge capacity");
    this.name = "StreamCapacityError";
  }
}

export class StreamJournal<View> {
  private readonly scope: BridgeScope;
  private readonly sessionId: string;
  private readonly epoch: string;
  private readonly projectionId: string;
  private readonly key: Buffer;
  private readonly maxRetained: number;
  private readonly maxRetainedBytes: number;
  private readonly maxSubscriberBytes: number;
  private readonly maxSubscribers: number;
  private readonly retained: StreamEvent<View>[] = [];
  private retainedBytes = 0;
  private readonly subscribers = new Set<Subscriber<View>>();
  private currentRevision = 0;
  private readonly observersChanged: () => void;

  public constructor(input: {
    scope: BridgeScope;
    sessionId: string;
    epoch: string;
    projectionId: string;
    key: Buffer;
    maxRetained?: number;
    maxRetainedBytes?: number;
    maxSubscriberBytes?: number;
    maxSubscribers?: number;
    observersChanged?(): void;
  }) {
    if (input.key.length < 32)
      throw new RangeError("Stream cursor key is too short");
    if (
      !Number.isSafeInteger(input.maxRetained ?? 128) ||
      (input.maxRetained ?? 128) < 1
    )
      throw new RangeError("Invalid stream suffix capacity");
    if (
      !Number.isSafeInteger(input.maxRetainedBytes ?? 262_144) ||
      (input.maxRetainedBytes ?? 262_144) < 256
    )
      throw new RangeError("Invalid retained stream byte budget");
    if (
      !Number.isSafeInteger(input.maxSubscriberBytes ?? 1_048_576) ||
      (input.maxSubscriberBytes ?? 1_048_576) < 256
    )
      throw new RangeError("Invalid subscriber byte budget");
    if (
      !Number.isSafeInteger(input.maxSubscribers ?? 8) ||
      (input.maxSubscribers ?? 8) < 1
    )
      throw new RangeError("Invalid subscriber count budget");
    this.observersChanged = input.observersChanged ?? (() => {});
    this.scope = input.scope;
    this.sessionId = input.sessionId;
    this.epoch = input.epoch;
    this.projectionId = input.projectionId;
    this.key = Buffer.from(input.key);
    this.maxRetained = input.maxRetained ?? 128;
    this.maxRetainedBytes = input.maxRetainedBytes ?? 262_144;
    this.maxSubscriberBytes = input.maxSubscriberBytes ?? 1_048_576;
    this.maxSubscribers = input.maxSubscribers ?? 8;
  }

  public get revision(): number {
    return this.currentRevision;
  }

  public get subscriberCount(): number {
    return this.subscribers.size;
  }

  public snapshotMetrics(): {
    subscribers: number;
    queuedBytes: number;
    retainedBytes: number;
  } {
    let queuedBytes = 0;
    for (const subscriber of this.subscribers)
      queuedBytes += subscriber.queuedBytes();
    return {
      subscribers: this.subscribers.size,
      queuedBytes,
      retainedBytes: this.retainedBytes,
    };
  }

  public snapshot(makeView: (cursor: string) => View): StreamEvent<View> {
    return this.snapshotEvent("snapshot", makeView);
  }

  public publish(body: Body): StreamEvent<View> {
    if (this.currentRevision >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("Stream revision is exhausted");
    const previous = this.currentRevision;
    const next = previous + 1;
    const event: StreamEvent<View> = {
      ...body,
      ...(body.type === "delta" ? { fromCursor: this.cursor(previous) } : {}),
      agentId: this.scope.agentId,
      bridgeEpoch: this.epoch,
      projectionId: this.projectionId,
      fromStreamRevision: previous,
      toStreamRevision: next,
      cursor: this.cursor(next),
    };
    if (size(event) > 65_536)
      throw new RangeError("Stream event exceeds maximum size");
    this.currentRevision = next;
    this.retain(event);
    for (const subscriber of this.subscribers) subscriber.push(event);
    return event;
  }

  public publishReset(makeView: (cursor: string) => View): StreamEvent<View> {
    if (this.currentRevision >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("Stream revision is exhausted");
    const previous = this.currentRevision;
    const next = previous + 1;
    const cursor = this.cursor(next);
    const event: StreamEvent<View> = {
      type: "reset",
      agentId: this.scope.agentId,
      bridgeEpoch: this.epoch,
      projectionId: this.projectionId,
      fromStreamRevision: previous,
      toStreamRevision: next,
      cursor,
      view: makeView(cursor),
    };
    if (size(event) > this.maxSubscriberBytes) {
      this.currentRevision = next;
      this.close();
      throw new StreamCapacityError();
    }
    this.currentRevision = next;
    this.retain(event);
    for (const subscriber of this.subscribers) subscriber.push(event);
    return event;
  }

  public subscribe(
    cursor: string | null,
    makeView: (cursor: string) => View,
  ): AsyncIterableIterator<StreamEvent<View>> {
    if (this.subscribers.size >= this.maxSubscribers)
      throw new StreamCapacityError();
    const queue: StreamEvent<View>[] = [];
    let queuedBytes = 0;
    let waiter:
      ((result: IteratorResult<StreamEvent<View>>) => void) | undefined;
    let closed = false;
    let resetPending = false;
    const close = () => {
      if (closed) return;
      closed = true;
      resetPending = false;
      this.subscribers.delete(subscriber);
      this.observersChanged();
      queue.length = 0;
      queuedBytes = 0;
      waiter?.({ done: true, value: undefined });
      waiter = undefined;
    };
    const enqueue = (event: StreamEvent<View>) => {
      if (closed || resetPending) return;
      const bytes = size(event);
      if (
        bytes > this.maxSubscriberBytes ||
        queuedBytes + bytes > this.maxSubscriberBytes
      ) {
        subscriber.reset();
        return;
      }
      if (waiter !== undefined) {
        const resolve = waiter;
        waiter = undefined;
        resolve({ done: false, value: event });
        return;
      }
      queue.push(event);
      queuedBytes += bytes;
    };
    const latestReset = (): StreamEvent<View> | undefined => {
      try {
        const event = this.snapshotEvent("reset", makeView);
        if (size(event) > this.maxSubscriberBytes) {
          close();
          return undefined;
        }
        return event;
      } catch {
        close();
        return undefined;
      }
    };
    const subscriber: Subscriber<View> = {
      push: enqueue,
      reset: () => {
        queue.length = 0;
        queuedBytes = 0;
        if (waiter !== undefined) {
          const event = latestReset();
          if (event === undefined) return;
          const resolve = waiter;
          waiter = undefined;
          resolve({ done: false, value: event });
          return;
        }
        resetPending = true;
      },
      close,
      queuedBytes: () => queuedBytes,
    };
    const from = cursor === null ? null : this.parseCursor(cursor);
    const needsReset =
      from === null || from < this.currentRevision - this.retained.length;
    const initialReset = needsReset
      ? this.snapshotEvent("reset", makeView)
      : null;
    this.subscribers.add(subscriber);
    this.observersChanged();
    if (initialReset !== null) {
      enqueue(initialReset);
    } else {
      for (const event of this.retained)
        if (from !== null && event.toStreamRevision > from) enqueue(event);
    }
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (resetPending) {
          resetPending = false;
          const event = latestReset();
          return Promise.resolve(
            event === undefined
              ? { done: true as const, value: undefined }
              : { done: false as const, value: event },
          );
        }
        const event = queue.shift();
        if (event !== undefined) {
          queuedBytes -= size(event);
          return Promise.resolve({ done: false as const, value: event });
        }
        if (closed)
          return Promise.resolve({ done: true as const, value: undefined });
        return new Promise((resolve) => {
          waiter = resolve;
        });
      },
      return: async () => {
        close();
        return { done: true as const, value: undefined };
      },
    };
  }

  public close(): void {
    for (const subscriber of [...this.subscribers]) subscriber.close();
    this.retained.length = 0;
    this.retainedBytes = 0;
  }

  private retain(event: StreamEvent<View>): void {
    this.retained.push(event);
    this.retainedBytes += size(event);
    while (
      this.retained.length > this.maxRetained ||
      this.retainedBytes > this.maxRetainedBytes
    ) {
      const oldest = this.retained.shift();
      if (oldest !== undefined) this.retainedBytes -= size(oldest);
    }
  }

  private snapshotEvent(
    type: "snapshot" | "reset",
    makeView: (cursor: string) => View,
  ): StreamEvent<View> {
    const cursor = this.cursor(this.currentRevision);
    const event: StreamEvent<View> = {
      type,
      agentId: this.scope.agentId,
      bridgeEpoch: this.epoch,
      projectionId: this.projectionId,
      fromStreamRevision: this.currentRevision,
      toStreamRevision: this.currentRevision,
      cursor,
      view: makeView(cursor),
    };
    if (size(event) > this.maxSubscriberBytes) throw new StreamCapacityError();
    return event;
  }

  private cursor(revision: number): string {
    const payload = Buffer.from(
      JSON.stringify([
        this.scope.organizationId,
        this.scope.principalId,
        this.scope.agentId,
        this.sessionId,
        this.epoch,
        this.projectionId,
        revision,
      ]),
    ).toString("base64url");
    const input = `v1.${payload}`;
    return `${input}.${this.sign(input)}`;
  }

  private parseCursor(cursor: string): number | null {
    if (cursor.length > 4096) return null;
    const parts = cursor.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== "v1" ||
      !/^[A-Za-z0-9_-]+$/u.test(parts[1] ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parts[2] ?? "")
    )
      return null;
    const input = `v1.${parts[1]}`;
    const actual = Buffer.from(parts[2]!, "base64url");
    const expected = Buffer.from(this.sign(input), "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return null;
    try {
      const value: unknown = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf8"),
      );
      if (
        !Array.isArray(value) ||
        value.length !== 7 ||
        value[0] !== this.scope.organizationId ||
        value[1] !== this.scope.principalId ||
        value[2] !== this.scope.agentId ||
        value[3] !== this.sessionId ||
        value[4] !== this.epoch ||
        value[5] !== this.projectionId ||
        !Number.isSafeInteger(value[6]) ||
        value[6] < 0 ||
        value[6] > this.currentRevision
      )
        return null;
      return value[6];
    } catch {
      return null;
    }
  }

  private sign(input: string): string {
    return createHmac("sha256", this.key).update(input).digest("base64url");
  }
}

function size(value: object): number {
  return encoding(value).bytes;
}
