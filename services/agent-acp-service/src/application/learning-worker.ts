import type { LearningScanScope, LearningTaskClaim } from "../domain/learning-scan.js";

type Paused = {
  next(
    after: string | null,
    signal: AbortSignal,
  ): Promise<{
    after: string | null;
    scanned: number;
    handled: "none" | "recovered" | "dispatched";
    exhausted: boolean;
  }>;
};
type Scan = {
  next(
    after: LearningScanScope | null,
    signal: AbortSignal,
  ): Promise<{
    after: LearningScanScope | null;
    scanned: number;
    failed: number;
    queued: number;
    exhausted: boolean;
  }>;
};
type Admission = { claimNext(): Promise<LearningTaskClaim | null> };
type Guard = {
  run(
    claim: LearningTaskClaim,
    parent: AbortSignal,
    work: (signal: AbortSignal, trackClaim: (next: LearningTaskClaim) => void) => Promise<unknown>,
  ): Promise<unknown>;
};
type Processor = { process(claim: LearningTaskClaim, signal: AbortSignal): Promise<unknown> };
type Outcomes = {
  pauseRunning(claim: LearningTaskClaim, reason: "runtime_unavailable"): Promise<unknown>;
};

/** One owner-only, serial pass: recover old effects before creating new work. */
export class LearningWorker {
  private pausedAfter: string | null = null;
  private scanAfter: LearningScanScope | null = null;

  public constructor(
    private readonly paused: Paused,
    private readonly scan: Scan,
    private readonly admission: Admission,
    private readonly guard: Guard,
    private readonly processor: Processor,
    private readonly outcomes: Outcomes,
    private readonly onFailure: (claim: LearningTaskClaim, error: unknown) => void = () => {},
    private readonly wait: (signal: AbortSignal) => Promise<void> = waitForNextPass,
    private readonly onCycleFailure: (error: unknown) => void = () => {},
    private readonly cleanup?: { tick(signal: AbortSignal): Promise<unknown> },
  ) {}

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let result: Awaited<ReturnType<LearningWorker["tick"]>>;
      try {
        result = await this.tick(signal);
      } catch (error) {
        if (wasAborted(signal)) return;
        try {
          this.onCycleFailure(error);
        } catch {
          // A diagnostic callback cannot terminate background recovery.
        }
        await this.wait(signal);
        continue;
      }
      if (result === "idle" || result === "failed") await this.wait(signal);
    }
  }

  public async tick(
    signal: AbortSignal,
  ): Promise<"recovered" | "paging" | "processed" | "failed" | "idle"> {
    signal.throwIfAborted();
    const paused = await this.paused.next(this.pausedAfter, signal);
    this.pausedAfter = paused.exhausted ? null : paused.after;
    if (paused.handled !== "none") return "recovered";
    if (!paused.exhausted) return "paging";

    try {
      await this.cleanup?.tick(signal);
    } catch (error) {
      signal.throwIfAborted();
      this.onCycleFailure(error);
    }

    signal.throwIfAborted();
    const scan = await this.scan.next(this.scanAfter, signal);
    this.scanAfter = scan.exhausted ? null : scan.after;
    signal.throwIfAborted();
    const claim = await this.admission.claimNext();
    if (claim === null) return scan.queued > 0 || !scan.exhausted ? "paging" : "idle";
    try {
      await this.guard.run(claim, signal, (leaseSignal) =>
        this.processor.process(claim, leaseSignal),
      );
      return "processed";
    } catch (error) {
      signal.throwIfAborted();
      await this.outcomes.pauseRunning(claim, "runtime_unavailable");
      this.onFailure(claim, error);
      return "failed";
    }
  }
}

function wasAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function waitForNextPass(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 2_000);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
