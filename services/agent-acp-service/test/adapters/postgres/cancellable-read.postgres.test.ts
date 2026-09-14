import { randomUUID } from "node:crypto";
import { getEventListeners, once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresKernel, postgresPoolOptions } from "../../../src/adapters/postgres/kernel.js";
import { PostgresExecutionRepository } from "../../../src/adapters/postgres/execution-repository.js";
import { migrate } from "../../../src/adapters/postgres/migrate.js";
import { AgentSettlement } from "../../../src/application/agent-settlement.js";
import { RunSupervisor } from "../../../src/application/run-supervisor.js";
import { executionConfiguration } from "../../fixtures/execution-configuration.js";
import { localExecution } from "../../support/local-execution.js";

const url = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(url === undefined)("cancellable PostgreSQL reads", () => {
  let pool: Pool;
  let observer: Pool;
  let kernel: PostgresKernel;
  let application: string;
  beforeEach(() => {
    application = `acp-read-${randomUUID()}`;
    pool = new Pool({
      ...postgresPoolOptions(url!, 1000),
      max: 1,
      application_name: application,
    });
    observer = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 1000 });
    kernel = new PostgresKernel(pool);
  });
  afterEach(async () => {
    await pool.end();
    await observer.end();
    vi.restoreAllMocks();
  });

  async function queryState() {
    return (
      await observer.query<{ state: string; wait_event_type: string | null }>(
        "SELECT state, wait_event_type FROM pg_stat_activity WHERE application_name = $1",
        [application],
      )
    ).rows;
  }

  it("uses bounded production pool settings and passes the statement limit to PostgreSQL", async () => {
    expect(postgresPoolOptions("postgres://unused/db", 1000)).toMatchObject({
      connectionString: "postgres://unused/db",
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
      query_timeout: 1000,
    });
    expect(
      (await kernel.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows,
    ).toEqual([{ statement_timeout: "1s" }]);
  });

  it("does not acquire a connection for an already cancelled read", async () => {
    const connect = vi.spyOn(pool, "connect");
    const reason = new Error("Already stopped");
    await expect(kernel.read("SELECT 1", [], AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(connect).not.toHaveBeenCalled();
  });

  it("reuses the connection after a normally completed read and removes its listener", async () => {
    const cancellation = new AbortController();
    const first = await kernel.read<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
      [],
      cancellation.signal,
    );
    const next = await kernel.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    expect(first.rows).toEqual(next.rows);
    expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
    expect(pool.idleCount).toBe(1);
  });

  it("aborts a running read, discards its connection and bounds backend work", async () => {
    const cancellation = new AbortController();
    const reason = new Error("Read deadline");
    const result = kernel
      .read("SELECT pg_sleep(30)", [], cancellation.signal)
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(async () =>
        expect(await queryState()).toContainEqual({ state: "active", wait_event_type: "Timeout" }),
      );
      cancellation.abort(reason);
      expect(await result).toBe(reason);
      expect(pool.totalCount).toBe(0);
      expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
      await vi.waitFor(async () => expect(await queryState()).toEqual([]), { timeout: 2500 });
    } finally {
      cancellation.abort(reason);
      await result;
    }
  });

  it("releases a late pool acquisition without dispatching the cancelled SQL", async () => {
    const held = await pool.connect();
    const query = vi.spyOn(held, "query");
    const cancellation = new AbortController();
    const reason = new Error("Waiting ended");
    const result = kernel
      .read("SELECT pg_sleep(30)", [], cancellation.signal)
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(pool.waitingCount).toBe(1));
      cancellation.abort(reason);
      expect(await result).toBe(reason);
    } finally {
      cancellation.abort(reason);
      held.release();
      await result;
    }
    await vi.waitFor(() => {
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(1);
    });
    expect(query).not.toHaveBeenCalled();
    expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
  });

  it("bounds a pool queue even if a cancelled request's connection never becomes free", async () => {
    const held = await pool.connect();
    const cancellation = new AbortController();
    const result = kernel
      .read("SELECT 1", [], cancellation.signal)
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(pool.waitingCount).toBe(1));
      cancellation.abort(new Error("Cancelled while queued"));
      expect(await result).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(pool.waitingCount).toBe(0), { timeout: 2500 });
    } finally {
      cancellation.abort();
      held.release();
      await result;
    }
  });

  it("bounds SQL without a caller signal and leaves subsequent reads usable", async () => {
    await expect(kernel.read("SELECT pg_sleep(30)")).rejects.toThrow(/timeout/u);
    await expect(kernel.read("SELECT 1 AS value")).resolves.toHaveProperty("rows", [{ value: 1 }]);
  });

  it.each(["read", "transaction"])(
    "contains a TCP reset during a borrowed %s and permits a new connection",
    async (operation) => {
      const address = new URL(url!);
      const peers = new Set<Socket>();
      const accepted = Promise.withResolvers<Socket>();
      const proxy = createServer((peer) => {
        const upstream = connect(Number(address.port || "5432"), address.hostname);
        peers.add(peer);
        peers.add(upstream);
        peer.on("error", () => upstream.destroy());
        upstream.on("error", () => peer.destroy());
        peer.once("close", () => {
          peers.delete(peer);
          upstream.destroy();
        });
        upstream.once("close", () => {
          peers.delete(upstream);
          peer.destroy();
        });
        peer.pipe(upstream).pipe(peer);
        accepted.resolve(peer);
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      const listening = proxy.address();
      if (listening === null || typeof listening === "string")
        throw new Error("Proxy missing address");
      const forwarded = new URL(address);
      forwarded.hostname = "127.0.0.1";
      forwarded.port = String(listening.port);
      const connections = new Pool({
        ...postgresPoolOptions(forwarded.href, 1000),
        max: 1,
        application_name: application,
      });
      const reader = new PostgresKernel(connections);
      const cancellation = new AbortController();
      const pending =
        operation === "read"
          ? reader.read("SELECT pg_sleep(30)", [], cancellation.signal)
          : reader.transaction((client) => client.query("SELECT pg_sleep(30)"));
      const result = pending.catch((error: unknown) => error);
      try {
        const peer = await accepted.promise;
        await vi.waitFor(async () =>
          expect(await queryState()).toContainEqual({
            state: "active",
            wait_event_type: "Timeout",
          }),
        );
        peer.resetAndDestroy();
        expect(await result).toBeInstanceOf(Error);
        expect(connections.totalCount).toBe(0);
        await expect(
          reader.read("SELECT 1 AS value", [], cancellation.signal),
        ).resolves.toHaveProperty("rows", [{ value: 1 }]);
        expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
      } finally {
        cancellation.abort();
        for (const peer of peers) peer.destroy();
        await result;
        await connections.end();
        await new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it("ends settlement on its deadline while locked evidence does not block configuration publication", async () => {
    await observer.query("DROP SCHEMA public CASCADE");
    await observer.query("CREATE SCHEMA public");
    await migrate(observer);
    const local = await localExecution();
    const closed = executionConfiguration();
    closed.revision = 2;
    closed.agents[0]!.accepting_runs = false;
    closed.agents[0]!.operation_id = "operation-1";
    await local.directory.apply(closed);
    const supervisor = new RunSupervisor({
      execute: () => Promise.reject(new Error("No Run expected")),
    });
    const service = new AgentSettlement({
      directory: local.directory,
      supervisor,
      protection: new PostgresExecutionRepository(kernel),
      now: () => new Date(),
    });
    const blocker = await observer.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE tool_attempts IN ACCESS EXCLUSIVE MODE");
    const result = service.settle({
      organization_id: "organization-1",
      agent_id: "agent-1",
      minimum_revision: 2,
      operation_id: "operation-1",
      mode: "wait",
      deadline_at: new Date(Date.now() + 350).toISOString(),
    });
    const settled = result.catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => {
        expect(await queryState()).toEqual([{ state: "active", wait_event_type: "Lock" }]);
      });
      await expect(local.directory.apply({ ...closed, revision: 3 })).resolves.toHaveProperty(
        "applied_revision",
        3,
      );
      expect(await settled).toEqual({ outcome: "not_settled", applied_revision: 3 });
      expect(pool.totalCount).toBe(0);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await settled;
      await supervisor.shutdown();
    }
    await vi.waitFor(async () => expect(await queryState()).toEqual([]), { timeout: 2500 });
  });
});
