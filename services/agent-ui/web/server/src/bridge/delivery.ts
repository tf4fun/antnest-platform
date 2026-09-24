import { createHash } from "node:crypto";

const MAX_PARTS_PER_EVENT = 4096;
const MAX_PENDING_EVENTS = 128;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const RECENT_DELIVERED_EVENTS = 32;

export type DeliveryMark =
  | { kind: "checkpoint"; sequence: number }
  | {
      kind: "part";
      sequence: number;
      partIndex: number;
      partCount: number;
      runId: string | null;
      messageId: string;
    };

export type DeliveredBatch<Update> = {
  sequence: number;
  runId: string | null;
  messageId: string;
  updates: Update[];
};

type Pending<Update> = {
  runId: string | null;
  messageId: string;
  partCount: number;
  parts: Map<number, { update: Update | undefined; bytes: number; digest: string }>;
};

type DeliveredRecord = {
  runId: string | null;
  messageId: string;
  partCount: number;
  digests: Map<number, string>;
};

export class DeliveryProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DeliveryProtocolError";
  }
}

export class DeliveryBufferCapacityError extends DeliveryProtocolError {
  public constructor() {
    super("Delivery buffer exceeds capacity");
    this.name = "DeliveryBufferCapacityError";
  }
}

export function parseDeliveryMark(value: unknown): DeliveryMark | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "checkpoint") {
    if (!exactKeys(record, ["kind", "sequence"]) || !revision(record.sequence))
      return null;
    return { kind: "checkpoint", sequence: record.sequence };
  }
  if (
    record.kind !== "part" ||
    !exactKeys(record, [
      "kind",
      "sequence",
      "partIndex",
      "partCount",
      "runId",
      "messageId",
    ])
  )
    return null;
  if (
    !revision(record.sequence) ||
    record.sequence === 0 ||
    !revision(record.partIndex) ||
    !revision(record.partCount) ||
    record.partCount === 0 ||
    record.partIndex >= record.partCount ||
    !(record.runId === null || identifier(record.runId)) ||
    !identifier(record.messageId)
  )
    return null;
  return {
    kind: "part",
    sequence: record.sequence,
    partIndex: record.partIndex,
    partCount: record.partCount,
    runId: record.runId,
    messageId: record.messageId,
  };
}

export class DeliveryTracker<Update> {
  private readonly pending = new Map<number, Pending<Update>>();
  private readonly delivered = new Map<number, DeliveredRecord>();
  private checkpoint = 0;
  private currentWatermark: number;
  private pendingBytes = 0;
  private summarize?: (update: Update) => Update | undefined;

  public constructor(initialWatermark: number) {
    if (!revision(initialWatermark))
      throw new RangeError(
        "Initial delivery watermark must be a safe nonnegative integer",
      );
    this.currentWatermark = initialWatermark;
    this.checkpoint = initialWatermark;
  }

  public get watermark(): number {
    return this.currentWatermark;
  }

  public get bufferedBytes(): number {
    return this.pendingBytes;
  }

  public enableSummaryMode(summarize: (update: Update) => Update | undefined): void {
    if (this.summarize !== undefined) return;
    this.summarize = summarize;
    this.pendingBytes = 0;
    for (const batch of this.pending.values()) {
      for (const part of batch.parts.values()) {
        part.update = part.update === undefined ? undefined : summarize(part.update);
        part.bytes = part.update === undefined ? 0 : Buffer.byteLength(JSON.stringify(part.update));
        this.pendingBytes += part.bytes;
      }
    }
    if (this.pendingBytes > MAX_PENDING_BYTES)
      throw new DeliveryProtocolError("Delivery summary exceeds capacity");
  }

  public accept(mark: DeliveryMark, update?: Update): DeliveredBatch<Update>[] {
    if (mark.kind === "checkpoint") {
      if (!revision(mark.sequence))
        throw new DeliveryProtocolError("Invalid checkpoint sequence");
      this.checkpoint = Math.max(this.checkpoint, mark.sequence);
      return this.flush();
    }
    if (parseDeliveryMark(mark) === null || update === undefined)
      throw new DeliveryProtocolError("Invalid delivery part");
    if (mark.partCount > MAX_PARTS_PER_EVENT)
      throw new DeliveryProtocolError("Delivery part count exceeds capacity");
    const encoded = JSON.stringify(update);
    if (encoded === undefined)
      throw new DeliveryProtocolError("Delivery update is not JSON");
    const digest = createHash("sha256").update(encoded).digest("hex");
    const retained = this.summarize?.(update) ?? (this.summarize === undefined ? update : undefined);
    const bytes = retained === undefined ? 0 : Buffer.byteLength(JSON.stringify(retained));
    if (mark.sequence <= this.currentWatermark) {
      const previous = this.delivered.get(mark.sequence);
      if (
        previous === undefined ||
        !matching(previous, mark) ||
        previous.digests.get(mark.partIndex) !== digest
      )
        throw new DeliveryProtocolError("Late or conflicting delivery part");
      return [];
    }
    let batch = this.pending.get(mark.sequence);
    if (batch === undefined) {
      if (this.pending.size >= MAX_PENDING_EVENTS)
        throw new DeliveryProtocolError("Too many incomplete delivery events");
      if (this.pendingBytes + bytes > MAX_PENDING_BYTES)
        throw new DeliveryBufferCapacityError();
      batch = {
        runId: mark.runId,
        messageId: mark.messageId,
        partCount: mark.partCount,
        parts: new Map(),
      };
      this.pending.set(mark.sequence, batch);
    } else if (!matching(batch, mark)) {
      throw new DeliveryProtocolError("Conflicting delivery batch identity");
    }
    const existing = batch.parts.get(mark.partIndex);
    if (existing !== undefined && existing.digest !== digest)
      throw new DeliveryProtocolError("Conflicting delivery part payload");
    if (existing === undefined) {
      if (this.pendingBytes + bytes > MAX_PENDING_BYTES)
        throw new DeliveryBufferCapacityError();
      batch.parts.set(mark.partIndex, { update: retained, bytes, digest });
      this.pendingBytes += bytes;
    }
    return this.flush();
  }

  public seal(sealedWatermark: number): void {
    if (!revision(sealedWatermark) || this.currentWatermark < sealedWatermark)
      throw new DeliveryProtocolError(
        "Replay has not delivered its sealed watermark",
      );
  }

  private flush(): DeliveredBatch<Update>[] {
    const ready: DeliveredBatch<Update>[] = [];
    while (this.currentWatermark < Number.MAX_SAFE_INTEGER) {
      const next = this.currentWatermark + 1;
      const batch = this.pending.get(next);
      if (batch !== undefined) {
        if (batch.parts.size !== batch.partCount) break;
        ready.push({
          sequence: next,
          runId: batch.runId,
          messageId: batch.messageId,
          updates: Array.from(
            { length: batch.partCount },
            (_, index) => batch.parts.get(index)!.update,
          ).filter((update): update is Update => update !== undefined),
        });
        this.pending.delete(next);
        this.delivered.set(next, {
          runId: batch.runId,
          messageId: batch.messageId,
          partCount: batch.partCount,
          digests: new Map(
            [...batch.parts].map(([index, part]) => [index, part.digest]),
          ),
        });
        if (this.delivered.size > RECENT_DELIVERED_EVENTS)
          this.delivered.delete(this.delivered.keys().next().value!);
        for (const part of batch.parts.values())
          this.pendingBytes -= part.bytes;
        this.currentWatermark = next;
      } else if (this.checkpoint >= next) {
        const nextPending = Math.min(...this.pending.keys());
        this.currentWatermark = Math.min(this.checkpoint, nextPending - 1);
      } else {
        break;
      }
    }
    return ready;
  }
}

function matching(
  batch: Pick<DeliveredRecord, "runId" | "messageId" | "partCount">,
  mark: Extract<DeliveryMark, { kind: "part" }>,
): boolean {
  return (
    batch.runId === mark.runId &&
    batch.messageId === mark.messageId &&
    batch.partCount === mark.partCount
  );
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function exactKeys(value: Record<string, unknown>, names: string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === names.length && keys.every((key) => names.includes(key))
  );
}
