import type { Pool, PoolClient } from "pg";
import { setTimeout as delay } from "node:timers/promises";

const WORKER_LOCK = 2_026_083_002;
const DEFAULT_PROBE_INTERVAL_MS = 1_000;

export type WorkerLockOptions = {
  probeIntervalMs?: number;
};

export class WorkerOwnershipLostError extends Error {
  public constructor(options?: ErrorOptions) {
    super("Agent ACP worker ownership was lost", options);
    this.name = "WorkerOwnershipLostError";
  }
}

export class PostgresWorkerLock {
  private held = true;
  private released = false;
  private discard = false;
  private readonly loss = Promise.withResolvers<Error>();
  private readonly monitorAbort = new AbortController();
  private readonly monitor: Promise<void>;
  private recovery: Promise<number> | undefined;

  private constructor(
    private readonly client: PoolClient,
    private readonly probeIntervalMs: number,
  ) {
    client.on("error", this.onClientError);
    this.monitor = this.monitorSession();
  }

  public static async acquire(
    pool: Pool,
    options: WorkerLockOptions = {},
  ): Promise<PostgresWorkerLock> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [WORKER_LOCK],
      );
      if (result.rows[0]?.acquired !== true) {
        throw new Error("another Agent ACP worker owns the database");
      }
      return new PostgresWorkerLock(
        client,
        Math.max(10, options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS),
      );
    } catch (error) {
      client.release();
      throw error;
    }
  }

  public isHeld(): boolean {
    return this.held && !this.released;
  }

  public waitForLoss(): Promise<Error> {
    return this.loss.promise;
  }

  public pauseAbandonedLearningTasks(): Promise<number> {
    if (!this.isHeld()) return Promise.reject(new WorkerOwnershipLostError());
    this.recovery ??= this.pauseAbandonedLearningTasksUnderLock().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  private async pauseAbandonedLearningTasksUnderLock(): Promise<number> {
    await this.client.query("BEGIN");
    try {
      await this.client.query(
        `UPDATE learning_model_calls SET state='unknown'
         WHERE state='reserved' AND task_id IN
           (SELECT id FROM learning_tasks WHERE state='running')`,
      );
      const result = await this.client.query(
        `UPDATE learning_tasks SET state='paused',pause_reason='worker_lost',updated_at=now()
         WHERE state='running'`,
      );
      if (!this.isHeld()) throw new WorkerOwnershipLostError();
      await this.client.query("COMMIT");
      if (!this.isHeld()) throw new WorkerOwnershipLostError();
      return result.rowCount ?? 0;
    } catch (error) {
      await this.client.query("ROLLBACK").catch(() => {
        this.discard = true;
      });
      throw error;
    }
  }

  public async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    await this.recovery?.catch(() => undefined);
    this.monitorAbort.abort();
    await this.monitor;
    const shouldUnlock = this.held;
    this.held = false;
    this.client.off("error", this.onClientError);
    try {
      if (shouldUnlock) {
        const result = await this.client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1) AS unlocked",
          [WORKER_LOCK],
        );
        if (result.rows[0]?.unlocked !== true) {
          this.discard = true;
          throw new Error("Agent ACP worker lock was not released by its owning session");
        }
      }
    } catch (error) {
      this.discard = true;
      throw error;
    } finally {
      this.client.release(this.discard);
    }
  }

  private readonly onClientError = (error: Error): void => {
    if (!this.released && this.held) {
      this.markLost(error);
    }
  };

  private async monitorSession(): Promise<void> {
    while (!this.monitorAbort.signal.aborted) {
      try {
        await delay(this.probeIntervalMs, undefined, { signal: this.monitorAbort.signal });
      } catch {
        return;
      }
      try {
        const probe = {
          text: "SELECT 1 AS value",
          query_timeout: this.probeIntervalMs,
        };
        const result = await this.client.query<{ value: number }>(probe);
        if (result.rows[0]?.value !== 1) {
          throw new Error("Agent ACP worker-lock probe returned an unexpected value");
        }
      } catch (error) {
        if (!this.released) {
          this.markLost(asError(error));
        }
        return;
      }
    }
  }

  private markLost(error: Error): void {
    if (!this.held) {
      return;
    }
    this.held = false;
    this.discard = true;
    this.monitorAbort.abort();
    this.loss.resolve(error);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Agent ACP worker-lock session was lost");
}
