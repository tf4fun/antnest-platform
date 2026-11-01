import { setTimeout as delay } from "node:timers/promises";
import type { ContentPurger, ContentRetentionConfig } from "../domain/content-retention.js";

export class ContentPurgeWorker {
  public constructor(
    private readonly dependencies: {
      purge: ContentPurger;
      retention: ContentRetentionConfig;
      report?: (blocked: number) => void;
      now?: () => Date;
    },
  ) {}

  public async run(signal: AbortSignal): Promise<void> {
    const { purge, retention } = this.dependencies;
    if (retention.deletedSessionRetentionMs <= 0) return;
    let after: string | null = null;
    while (!signal.aborted) {
      try {
        const now = this.dependencies.now?.() ?? new Date();
        const result = await purge.batch({
          cutoff: new Date(now.getTime() - retention.deletedSessionRetentionMs),
          ...(after === null ? {} : { after }),
          limit: retention.purgeBatch,
          dryRun: false,
          signal,
        });
        after = result.nextCursor;
        if (result.blocked > 0) this.dependencies.report?.(result.blocked);
        if (after === null) await delay(retention.purgeIntervalMs, undefined, { signal });
      } catch (error) {
        if (signal.reason !== undefined) return;
        throw error;
      }
    }
  }
}
