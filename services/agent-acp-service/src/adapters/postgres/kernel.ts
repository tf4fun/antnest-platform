import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { NOOP_TELEMETRY, type TelemetryPort } from "../../ports/telemetry.js";

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
    return this.observe("transaction", async () => {
      const client = await this.pool.connect();
      let releaseError: Error | undefined;
      try {
        await client.query("BEGIN");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
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
        client.release(releaseError);
      }
    });
  }

  private observe<Result>(operation: string, execute: () => Promise<Result>): Promise<Result> {
    const started = performance.now();
    let result = "error";
    return this.telemetry
      .span(
        operation === "transaction" ? "postgres.transaction" : "postgres.query",
        { "db.system.name": "postgresql", "db.operation.name": operation },
        async () => {
          const value = await execute();
          result = "ok";
          return value;
        },
      )
      .finally(() => {
        const attributes = { operation, result };
        this.telemetry.count("antnest.acp.repository.requests", attributes);
        this.telemetry.duration(
          "antnest.acp.repository.duration",
          performance.now() - started,
          attributes,
        );
      });
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
