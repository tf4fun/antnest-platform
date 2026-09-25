export class ReplayCapacityError extends Error {
  public constructor() {
    super("Replay queue capacity exceeded");
    this.name = "ReplayCapacityError";
  }
}

export class ReplayLoadGate {
  private busy = false;
  private readonly waiting: Array<() => void> = [];
  private readonly maxQueued: number;

  public constructor(maxQueued = 8) {
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0)
      throw new RangeError("Invalid replay queue capacity");
    this.maxQueued = maxQueued;
  }

  public snapshotMetrics(): { active: number; queued: number } {
    return { active: Number(this.busy), queued: this.waiting.length };
  }

  public async run<T>(load: () => Promise<T>): Promise<T> {
    if (this.busy) {
      if (this.waiting.length >= this.maxQueued)
        throw new ReplayCapacityError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.busy = true;
    }
    try {
      return await load();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.busy = false;
      else next();
    }
  }
}
