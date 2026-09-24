import {
  DeliveryTracker,
  DeliveryBufferCapacityError,
  type DeliveredBatch,
  type DeliveryMark,
} from "./delivery.ts";

export type ReplayCut = { sealedWatermark: number; appendVersion: number };

type Projection<Update, View> = {
  empty(): View;
  apply(view: View, batch: DeliveredBatch<Update>): View;
  estimate?(view: View): number;
  seal?(view: View): void;
  prepareReplacement?(view: View): void;
  limit?(view: View): boolean;
  isLimited?(view: View): boolean;
  summarize?(update: Update): Update | undefined;
};

type Attempt<Update, View> = {
  tracker: DeliveryTracker<Update>;
  view: View;
  error?: unknown;
};

export class SessionReplay<View, Update> {
  private current: Attempt<Update, View>;
  private candidate: Attempt<Update, View> | undefined;
  private appendVersion: number | null = null;
  private loading: Promise<void> | undefined;
  private needsReconcile = false;
  private readonly projection: Projection<Update, View>;
  private readonly sealWaitMs: number;
  private readonly waiters = new Set<() => void>();

  public constructor(
    projection: Projection<Update, View>,
    options: { sealWaitMs?: number } = {},
  ) {
    const waitMs = options.sealWaitMs ?? 5_000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 1)
      throw new RangeError("Invalid replay seal wait deadline");
    this.projection = projection;
    this.sealWaitMs = waitMs;
    this.current = this.newAttempt();
  }

  public snapshot(): {
    view: View;
    watermark: number;
    appendVersion: number | null;
    loading: boolean;
    needsReconcile: boolean;
  } {
    return {
      view: this.current.view,
      watermark: this.current.tracker.watermark,
      appendVersion: this.appendVersion,
      loading: this.loading !== undefined,
      needsReconcile: this.needsReconcile,
    };
  }

  public get estimatedRetainedBytes(): number {
    const estimate = (attempt: Attempt<Update, View>) =>
      (this.projection.estimate?.(attempt.view) ?? 0) +
      attempt.tracker.bufferedBytes;
    return (
      estimate(this.current) +
      (this.candidate === undefined ? 0 : estimate(this.candidate))
    );
  }

  public receive(mark: DeliveryMark, update?: Update): void {
    const target = this.candidate ?? this.current;
    if (target.error !== undefined) return;
    try {
      let batches: DeliveredBatch<Update>[];
      try {
        batches = target.tracker.accept(mark, update);
      } catch (error) {
        if (
          !(error instanceof DeliveryBufferCapacityError) ||
          target !== this.current ||
          !this.limitCurrent()
        )
          throw error;
        batches = target.tracker.accept(mark, update);
      }
      for (const batch of batches) {
        target.view = this.projection.apply(target.view, batch);
        this.enableSummaryIfLimited(target);
      }
    } catch (error) {
      target.error = error;
      this.needsReconcile = true;
      throw error;
    } finally {
      this.notifyWaiters();
    }
  }

  public applySideband(update: (view: View) => void): void {
    const target = this.candidate ?? this.current;
    if (target.error !== undefined) return;
    update(target.view);
    this.notifyWaiters();
  }

  public invalidate(error: unknown): void {
    const target = this.candidate ?? this.current;
    target.error = error;
    this.needsReconcile = true;
    this.notifyWaiters();
  }

  public load(loader: (candidate: View) => Promise<ReplayCut>): Promise<void> {
    if (this.loading !== undefined) return this.loading;
    const candidate = this.newAttempt();
    if (this.appendVersion !== null)
      this.projection.prepareReplacement?.(candidate.view);
    this.candidate = candidate;
    const pending = this.performLoad(candidate, loader).finally(() => {
      if (this.candidate === candidate) this.candidate = undefined;
      this.loading = undefined;
    });
    this.loading = pending;
    return pending;
  }

  public hasCompleteOutput(watermark: number): boolean {
    return (
      Number.isSafeInteger(watermark) &&
      watermark >= 0 &&
      this.loading === undefined &&
      !this.needsReconcile &&
      this.current.tracker.watermark >= watermark
    );
  }

  public limitCurrent(): boolean {
    if (
      this.loading !== undefined ||
      this.appendVersion === null ||
      this.needsReconcile ||
      !(this.projection.limit?.(this.current.view) ?? false)
    )
      return false;
    this.enableSummaryIfLimited(this.current);
    return true;
  }

  private enableSummaryIfLimited(attempt: Attempt<Update, View>): void {
    if (this.projection.isLimited?.(attempt.view) && this.projection.summarize)
      attempt.tracker.enableSummaryMode(this.projection.summarize);
  }

  private async performLoad(
    candidate: Attempt<Update, View>,
    loader: (candidate: View) => Promise<ReplayCut>,
  ): Promise<void> {
    try {
      const cut = await loader(candidate.view);
      if (candidate.error !== undefined) throw candidate.error;
      await this.waitForSeal(candidate, cut.sealedWatermark);
      candidate.tracker.seal(cut.sealedWatermark);
      this.projection.seal?.(candidate.view);
      this.current = candidate;
      this.appendVersion = cut.appendVersion;
      this.needsReconcile = false;
    } catch (error) {
      this.needsReconcile = true;
      throw error;
    }
  }

  private waitForSeal(
    candidate: Attempt<Update, View>,
    watermark: number,
  ): Promise<void> {
    if (candidate.error !== undefined) return Promise.reject(candidate.error);
    if (candidate.tracker.watermark >= watermark) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const check = () => {
        if (candidate.error !== undefined) finish(candidate.error);
        else if (candidate.tracker.watermark >= watermark) finish();
      };
      const timer = setTimeout(() => {
        try {
          candidate.tracker.seal(watermark);
        } catch (error) {
          finish(error);
        }
      }, this.sealWaitMs);
      this.waiters.add(check);
      check();
    });
  }

  private notifyWaiters(): void {
    for (const check of [...this.waiters]) check();
  }

  private newAttempt(): Attempt<Update, View> {
    return {
      tracker: new DeliveryTracker<Update>(0),
      view: this.projection.empty(),
    };
  }
}
