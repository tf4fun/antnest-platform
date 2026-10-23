import type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";
import { NOOP_TELEMETRY, type TelemetryPort } from "../../ports/telemetry.js";
import { observePostgresTransaction } from "../../telemetry/postgres.js";
import { lockRuntimeBarrierOrganization } from "./runtime-barrier.js";
import {
  AgentOwnershipLostError,
  ownershipFence,
  transactionBudget,
  type AgentOwnershipFence,
} from "../../domain/agent-ownership.js";

type TransactionOptions = { timeoutMs?: number };

export function postgresPoolOptions(connectionString: string, timeoutMs: number): PoolConfig {
  return {
    connectionString,
    max: 10,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
  };
}

export class PostgresKernel {
  public constructor(
    private readonly pool: Pool,
    private readonly telemetry: TelemetryPort = NOOP_TELEMETRY,
  ) {}

  public query<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.observe(sqlOperation(text), () => this.pool.query<Row>(text, [...values]));
  }

  public agentTransaction<T>(
    input: AgentOwnershipFence,
    operation: (client: PoolClient) => Promise<T>,
    options: TransactionOptions & { organizationBarrier?: true } = {},
  ): Promise<T> {
    const fence = ownershipFence(input);
    const timeoutMs = transactionBudget(options.timeoutMs ?? 10_000);
    const organizationBarrier = options.organizationBarrier === true;
    return this.transaction(
      async (client) => {
        if (organizationBarrier) await lockRuntimeBarrierOrganization(client, fence.organizationId);
        const values = [fence.organizationId, fence.agentId, fence.ownerInstanceId, fence.epoch];
        const locked = await client.query(
          "SELECT organization_id FROM agent_leases WHERE organization_id=$1 AND agent_id=$2 FOR SHARE",
          values.slice(0, 2),
        );
        if (locked.rowCount !== 1) throw new AgentOwnershipLostError();
        // The clock check must run after any wait for the lease row lock.
        const current = await client.query<{ owned: boolean }>(
          `SELECT owner_instance_id=$3 AND epoch=$4::bigint AND expires_at>clock_timestamp() AS owned
         FROM agent_leases WHERE organization_id=$1 AND agent_id=$2`,
          values,
        );
        if (current.rows[0]?.owned !== true) throw new AgentOwnershipLostError();
        return operation(client);
      },
      { timeoutMs },
    );
  }

  public transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const timeoutMs =
      options.timeoutMs === undefined ? undefined : transactionBudget(options.timeoutMs);
    return this.observe("transaction", () =>
      observePostgresTransaction(async (finish) => {
        const client = await this.pool.connect();
        let releaseError: Error | undefined;
        let executing = false;
        const connectionFailed = (error: Error) => {
          releaseError ??= error;
        };
        client.on("error", connectionFailed);
        try {
          await client.query("BEGIN");
          executing = true;
          if (timeoutMs !== undefined) {
            await client.query("SELECT set_config('transaction_timeout',$1,true)", [
              `${timeoutMs}ms`,
            ]);
          }
          const result = await operation(client);
          executing = false;
          const committed = await client.query("COMMIT");
          finish(committed.command === "ROLLBACK" ? "rolled_back" : "committed");
          if (committed.command !== "COMMIT")
            throw new Error("PostgreSQL transaction did not commit");
          return result;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
            if (executing) finish("rolled_back");
          } catch (rollbackError) {
            const rollbackFailure = asError(rollbackError);
            releaseError = rollbackFailure;
            throw new AggregateError(
              [asError(error), rollbackFailure],
              "PostgreSQL transaction and rollback both failed",
              { cause: rollbackError },
            );
          }
          throw error;
        } finally {
          client.removeListener("error", connectionFailed);
          client.release(releaseError);
        }
      }),
    );
  }

  public read<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<QueryResult<Row>> {
    return this.observe(sqlOperation(text), () => readQuery<Row>(this.pool, text, values, signal));
  }

  private async observe<Result>(
    operation: string,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    const started = performance.now();
    let result = "error";
    try {
      const value = await execute();
      result = "ok";
      return value;
    } finally {
      const attributes = { operation, result };
      this.telemetry.count("antnest.acp.repository.requests", attributes);
      this.telemetry.duration(
        "antnest.acp.repository.duration",
        performance.now() - started,
        attributes,
      );
    }
  }
}

// Cancelling a read discards its socket. This must not be used to infer whether
// a write committed; a server statement timeout also bounds orphaned backend work.
async function readQuery<Row extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  signal?.throwIfAborted();
  if (signal === undefined) return pool.query<Row>(text, [...values]);
  const interrupted = Promise.withResolvers<never>();
  let client: PoolClient | undefined;
  let reusable = false;
  const release = (destroy: boolean) => {
    const acquired = client;
    client = undefined;
    acquired?.removeListener("error", fail);
    acquired?.release(destroy);
  };
  const fail = (reason: unknown) => {
    release(true);
    interrupted.reject(reason);
  };
  const cancel = () => fail(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const acquisition = pool.connect().then((acquired) => {
    if (signal.aborted) {
      acquired.release();
      signal.throwIfAborted();
    }
    client = acquired;
    acquired.on("error", fail);
    return acquired;
  });
  try {
    const acquired = await Promise.race([acquisition, interrupted.promise]);
    signal.throwIfAborted();
    const result = await Promise.race([
      acquired.query<Row>(text, [...values]),
      interrupted.promise,
    ]);
    signal.throwIfAborted();
    reusable = true;
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    release(!reusable);
  }
}

function sqlOperation(text: string): string {
  const operation = /^\s*([A-Za-z]+)/u.exec(text)?.[1]?.toLowerCase();
  switch (operation) {
    case "select":
    case "insert":
    case "update":
    case "delete":
      return operation;
    case undefined:
      return "other";
    default:
      return "other";
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("PostgreSQL connection is not reusable");
}
