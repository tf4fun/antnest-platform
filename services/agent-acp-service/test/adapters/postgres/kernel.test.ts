import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";

import { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import type { TelemetryAttributes, TelemetryPort } from "../../../src/ports/telemetry.js";

describe("PostgresKernel telemetry", () => {
  it("refuses a lease created after the locking SELECT missed its row", async () => {
    const query = vi.fn((sql: string) =>
      Promise.resolve(
        sql.includes("FOR SHARE")
          ? { rows: [], rowCount: 0, command: "SELECT" }
          : sql.includes(" AS owned")
            ? { rows: [{ owned: true }], rowCount: 1, command: "SELECT" }
            : { rows: [], rowCount: 0, command: sql },
      ),
    );
    const release = vi.fn();
    const client = Object.assign(new EventEmitter(), { query, release }) as unknown as PoolClient;
    const kernel = new PostgresKernel({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);
    const business = vi.fn(() => Promise.resolve("must not execute"));
    await expect(
      kernel.agentTransaction(
        {
          organizationId: "organization-1",
          agentId: "agent-1",
          ownerInstanceId: "worker-a",
          epoch: "1",
        },
        business,
      ),
    ).rejects.toMatchObject({ name: "AgentOwnershipLostError" });
    expect(business).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes(" AS owned"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(client.listenerCount("error")).toBe(0);
  });

  it("does not return a business result when COMMIT reports a rollback", async () => {
    const query = vi.fn((sql: string) =>
      Promise.resolve({
        rows: [],
        rowCount: 0,
        command: sql === "COMMIT" ? "ROLLBACK" : sql,
      }),
    );
    const release = vi.fn();
    const client = Object.assign(new EventEmitter(), { query, release }) as unknown as PoolClient;
    const kernel = new PostgresKernel({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);
    await expect(kernel.transaction(() => Promise.resolve("uncommitted result"))).rejects.toThrow(
      "PostgreSQL transaction did not commit",
    );
    expect(release).toHaveBeenCalledOnce();
    expect(client.listenerCount("error")).toBe(0);
  });

  it("counts a query without duplicating driver spans or recording bind values", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [], rowCount: 0 }));
    const telemetry = recordedTelemetry();
    const kernel = new PostgresKernel({ query } as unknown as Pool, telemetry.port);

    await kernel.query("SELECT secret FROM private_table WHERE token = $1", ["hidden"]);

    expect(telemetry.spans).toEqual([]);
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
