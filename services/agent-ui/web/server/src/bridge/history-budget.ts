import { HistoryCapacityError } from "./compact-transcript.ts";

type HistoryOwner = { readonly estimatedCachedHistoryBytes: number };

export class SharedHistoryBudget {
  private readonly maxBytes: number;
  private readonly owners = new Set<HistoryOwner>();
  private readonly reservations = new Map<HistoryOwner, number>();

  public constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError("Invalid total history budget");
    this.maxBytes = maxBytes;
  }

  public register(owner: HistoryOwner): void {
    this.owners.add(owner);
  }

  public unregister(owner: HistoryOwner): void {
    this.owners.delete(owner);
    this.reservations.delete(owner);
  }

  public snapshotMetrics(): { cachedBytes: number; reservedBytes: number } {
    let cachedBytes = 0;
    let reservedBytes = 0;
    for (const owner of this.owners) {
      cachedBytes += owner.estimatedCachedHistoryBytes;
      reservedBytes += this.reservations.get(owner) ?? 0;
    }
    return { cachedBytes, reservedBytes };
  }

  public reserve(owner: HistoryOwner, bytes: number): () => void {
    if (!this.owners.has(owner) || !Number.isSafeInteger(bytes) || bytes < 1)
      throw new RangeError("Invalid history reservation");
    let used = 0;
    for (const item of this.owners)
      used += item.estimatedCachedHistoryBytes + (this.reservations.get(item) ?? 0);
    if (used + bytes > this.maxBytes) throw new HistoryCapacityError();
    this.reservations.set(owner, (this.reservations.get(owner) ?? 0) + bytes);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.reservations.get(owner) ?? 0) - bytes;
      if (remaining > 0) this.reservations.set(owner, remaining);
      else this.reservations.delete(owner);
    };
  }
}
