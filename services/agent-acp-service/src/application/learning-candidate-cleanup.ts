import type { LearningTaskClaim } from "../domain/learning-scan.js";
import type { RuntimeBinding } from "../domain/types.js";

export type LearningCleanupItem = {
  claim: LearningTaskClaim;
  requestId: string;
  storageKey: string;
  packagePath: string;
  expectedDigest: string;
};
type Binding = RuntimeBinding & { acceptingRuns?: boolean };
type Store = { next(): Promise<LearningCleanupItem | null> };
type Bindings = { current(claim: LearningTaskClaim): Promise<Binding | null> };
type Runtime = {
  release(
    input: LearningCleanupItem & {
      binding: Binding;
      storageClass: "candidate";
      signal: AbortSignal;
    },
  ): Promise<{ outcome: "released" }>;
};
type Guard = {
  runRecovery(
    claim: LearningTaskClaim,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<"unavailable" | "released">,
  ): Promise<"unavailable" | "released">;
};

/** One bounded cleanup attempt; the store admits only durably settled storage. */
export class LearningCandidateCleanup {
  public constructor(
    private readonly store: Store,
    private readonly bindings: Bindings,
    private readonly runtime: Runtime,
    private readonly guard: Guard,
  ) {}

  public async tick(signal: AbortSignal): Promise<"idle" | "unavailable" | "released"> {
    signal.throwIfAborted();
    const item = await this.store.next();
    if (item === null) return "idle";
    return this.guard.runRecovery(item.claim, signal, async (leaseSignal) => {
      const binding = await this.bindings.current(item.claim);
      if (binding === null || binding.acceptingRuns === false) return "unavailable";
      leaseSignal.throwIfAborted();
      const deadline = new AbortController();
      const timer = setTimeout(
        () => deadline.abort(new Error("Skill cleanup deadline exceeded")),
        5_000,
      );
      try {
        await this.runtime.release({
          ...item,
          binding,
          storageClass: "candidate",
          // Once dispatched, keep the receipt readable during foreground handoff.
          // Shutdown and the bounded deadline still cancel the transport.
          signal: AbortSignal.any([signal, deadline.signal]),
        });
      } finally {
        clearTimeout(timer);
      }
      return "released";
    });
  }
}
