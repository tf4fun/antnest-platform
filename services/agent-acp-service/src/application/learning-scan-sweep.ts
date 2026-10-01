import type { LearningScanScope } from "../domain/learning-scan.js";

type ScopeSource = {
  listScopes(after: LearningScanScope | null, limit: number): Promise<LearningScanScope[]>;
};
type Scanner = {
  scanPage(scope: LearningScanScope): Promise<{
    decided: number;
    queued: number;
    queueFull: boolean;
  }>;
};

/** One bounded, serial pass over durable Agent scopes; the caller owns scheduling. */
export class LearningScanSweep {
  public constructor(
    private readonly scopes: ScopeSource,
    private readonly scanner: Scanner,
    private readonly onFailure: (scope: LearningScanScope, error: unknown) => void = () => {},
  ) {}

  public async next(
    after: LearningScanScope | null,
    signal: AbortSignal,
  ): Promise<{
    after: LearningScanScope | null;
    scanned: number;
    failed: number;
    queued: number;
    exhausted: boolean;
  }> {
    signal.throwIfAborted();
    const page = await this.scopes.listScopes(after, 100);
    signal.throwIfAborted();
    if (page.length === 0)
      return { after: null, scanned: 0, failed: 0, queued: 0, exhausted: true };
    let scanned = 0;
    let failed = 0;
    let queued = 0;
    for (const scope of page) {
      signal.throwIfAborted();
      try {
        const result = await this.scanner.scanPage(scope);
        scanned += 1;
        queued += result.queued;
      } catch (error) {
        signal.throwIfAborted();
        this.onFailure(scope, error);
        failed += 1;
      }
    }
    return { after: page.at(-1)!, scanned, failed, queued, exhausted: false };
  }
}
