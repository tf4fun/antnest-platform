import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";

import { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import type { TelemetryAttributes, TelemetryPort } from "../../../src/ports/telemetry.js";

describe("PostgresKernel telemetry", () => {
  it("observes a query without recording SQL text or bind values", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [], rowCount: 0 }));
    const telemetry = recordedTelemetry();
    const kernel = new PostgresKernel({ query } as unknown as Pool, telemetry.port);

    await kernel.query("SELECT secret FROM private_table WHERE token = $1", ["hidden"]);

    expect(telemetry.spans).toEqual([
      {
        name: "postgres.query",
        attributes: { "db.system.name": "postgresql", "db.operation.name": "select" },
      },
    ]);
    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.repository.requests",
      attributes: { operation: "select", result: "ok" },
    });
    expect(JSON.stringify({ spans: telemetry.spans, counts: telemetry.counts })).not.toContain(
      "hidden",
    );
    expect(JSON.stringify({ spans: telemetry.spans, counts: telemetry.counts })).not.toContain(
      "private_table",
    );
  });

  it("observes one transaction and rolls back the original failure", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [], rowCount: 0 }));
    const release = vi.fn();
    const client = Object.assign(new EventEmitter(), { query, release }) as unknown as PoolClient;
    const telemetry = recordedTelemetry();
    const kernel = new PostgresKernel(
      { connect: () => Promise.resolve(client) } as unknown as Pool,
      telemetry.port,
    );
    const failure = new Error("write failed");

    await expect(
      kernel.transaction(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(query).toHaveBeenNthCalledWith(2, "ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
    expect(client.listenerCount("error")).toBe(0);
    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.repository.requests",
      attributes: { operation: "transaction", result: "error" },
    });
  });

  it("preserves transaction and rollback failures and discards the connection", async () => {
    const transactionFailure = new Error("write failed");
    const rollbackFailure = new Error("connection lost");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(rollbackFailure);
    const release = vi.fn();
    const client = Object.assign(new EventEmitter(), { query, release }) as unknown as PoolClient;
    const telemetry = recordedTelemetry();
    const kernel = new PostgresKernel(
      { connect: () => Promise.resolve(client) } as unknown as Pool,
      telemetry.port,
    );

    const result = kernel.transaction(() => {
      throw transactionFailure;
    });

    await expect(result).rejects.toMatchObject({
      cause: rollbackFailure,
      errors: [transactionFailure, rollbackFailure],
    });
    expect(query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(query).toHaveBeenNthCalledWith(2, "ROLLBACK");
    expect(release).toHaveBeenCalledWith(rollbackFailure);
    expect(client.listenerCount("error")).toBe(0);
    expect(telemetry.counts).toContainEqual({
      name: "antnest.acp.repository.requests",
      attributes: { operation: "transaction", result: "error" },
    });
  });
});

function recordedTelemetry() {
  const spans: Array<{ name: string; attributes: TelemetryAttributes }> = [];
  const counts: Array<{ name: string; attributes: TelemetryAttributes }> = [];
  const durations: Array<{ name: string; attributes: TelemetryAttributes }> = [];
  const port: TelemetryPort = {
    span: async <Result>(
      name: string,
      attributes: TelemetryAttributes,
      operation: () => Promise<Result>,
    ) => {
      spans.push({ name, attributes });
      return operation();
    },
    count: (name, attributes) => counts.push({ name, attributes }),
    duration: (name, _milliseconds, attributes) => durations.push({ name, attributes }),
    log: () => undefined,
  };
  return { port, spans, counts, durations };
}
