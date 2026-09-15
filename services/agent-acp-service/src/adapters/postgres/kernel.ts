import type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";
import { NOOP_TELEMETRY, type TelemetryPort } from "../../ports/telemetry.js";
import { observePostgresTransaction } from "../../telemetry/postgres.js";

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

  public transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
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
          const result = await operation(client);
          executing = false;
          const committed = await client.query("COMMIT");
          finish(committed.command === "ROLLBACK" ? "rolled_back" : "committed");
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
