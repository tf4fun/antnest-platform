import { testSecurityEnvironment } from "./support/auth-fixture.js";
import { existsSync } from "node:fs";
import { Pool } from "pg";
import { RuntimeConnections } from "../src/adapters/runtime-connections.js";
import { describe, expect, it, vi } from "vitest";
import { NOOP_TELEMETRY, type TelemetryPort } from "../src/ports/telemetry.js";

import * as migrations from "../src/adapters/postgres/migrate.js";
import { WorkerOwnershipLostError } from "../src/adapters/postgres/worker-lock.js";
import {
  dependenciesReady,
  startAgentAcpService,
  waitForStartupRecovery,
  type RunningAgentAcpService,
} from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import { createShutdownReason, isShutdownReason } from "../src/shutdown.js";
import { AgentAcpHttpServer } from "../src/transport/http-server.js";

describe("development startup diagnostics", () => {
  it("logs exactly one variable-only WARN for each admitted development secret", async () => {
    const failure = new Error("stop before connecting dependencies");
    const migration = vi.spyOn(migrations, "migrate").mockRejectedValue(failure);
    const log = vi.fn<TelemetryPort["log"]>();
    const config = loadConfig({
      ...testSecurityEnvironment(),
      ANTNEST_ACP_DATABASE_URL: "postgres://acp:antnest-agent-acp-dev@postgres/acp",
      ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.alloc(32).toString("base64"),
      ANTNEST_ALLOW_PUBLIC_DEV_SECRETS: "true",
    });
    try {
      await expect(startAgentAcpService(config, { ...NOOP_TELEMETRY, log }, vi.fn())).rejects.toBe(
        failure,
      );
      expect(log.mock.calls).toEqual([
        ["warn", "published_development_secret_enabled", { variable: "ANTNEST_ACP_DATABASE_URL" }],
        [
          "warn",
          "published_development_secret_enabled",
          { variable: "ANTNEST_ACP_CLIENT_MCP_KEY" },
        ],
      ]);
    } finally {
      migration.mockRestore();
    }
  });
  it.each([new Error("migration failed"), new WorkerOwnershipLostError()])(
    "removes owned Runtime sender storage on startup failure: %s",
    async (failure) => {
      const migration = vi.spyOn(migrations, "migrate").mockRejectedValue(failure);
      const cleanup = vi.spyOn(RuntimeConnections.prototype, "close");
      const config = loadConfig({
        ...testSecurityEnvironment(),
        ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
        ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString(
          "base64",
        ),
      });
      const workloadCleanup = vi.spyOn(config.authentication.workload, "close");
      const poolPrototype = Pool.prototype as { end(this: Pool): Promise<void> };
      const poolCleanup = vi.spyOn(poolPrototype, "end");
      const failures: unknown[] = [];
      try {
        await expect(startAgentAcpService(config, NOOP_TELEMETRY, vi.fn())).rejects.toBe(failure);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(workloadCleanup).toHaveBeenCalledOnce();
        expect(poolCleanup).toHaveBeenCalledOnce();
        const directories = cleanup.mock.contexts.flatMap((instance) =>
          instance instanceof RuntimeConnections ? [instance.directory] : [],
        );
        expect(directories).toHaveLength(1);
        expect(directories.every((directory) => !existsSync(directory))).toBe(true);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          const pending = [
            ...workloadCleanup.mock.results.flatMap((result) =>
              result.type === "return" ? [result.value] : [],
            ),
            ...poolCleanup.mock.results.flatMap((result) =>
              result.type === "return" ? [result.value] : [],
            ),
          ];
          if (workloadCleanup.mock.calls.length === 0)
            pending.push(config.authentication.workload.close());
          for (const [pool] of migration.mock.calls)
            if (!poolCleanup.mock.contexts.includes(pool)) pending.push(pool.end());
          const results = await Promise.allSettled(pending);
          for (const result of results)
            if (result.status === "rejected") failures.push(result.reason as unknown);
        } finally {
          poolCleanup.mockRestore();
          workloadCleanup.mockRestore();
          migration.mockRestore();
          cleanup.mockRestore();
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Startup storage cleanup fixture did not close");
    },
  );
  it.each([undefined, "agent-debug"])(
    "warns only when a debug Agent is configured: %j",
    async (agentId) => {
      const startupFailure = new Error("test stops startup before opening dependencies");
      const migration = vi.spyOn(migrations, "migrate").mockRejectedValue(startupFailure);
      const log = vi.fn<TelemetryPort["log"]>();
      try {
        const config = loadConfig({
          ...testSecurityEnvironment(),
          ...{
            ANTNEST_ACP_DATABASE_URL: "postgres://agent:secret@postgres/agent_acp",
            ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString(
              "base64",
            ),
            ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS: "true",
            ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID: agentId,
          },
        });
        await expect(
          startAgentAcpService(config, { ...NOOP_TELEMETRY, log }, vi.fn()),
        ).rejects.toBe(startupFailure);
        expect(migration).toHaveBeenCalledOnce();
        if (agentId === undefined) {
          expect(log).not.toHaveBeenCalled();
        } else {
          expect(log).toHaveBeenCalledExactlyOnceWith(
            "warn",
            "Skill learning debug mode is active",
            { agent_id: agentId },
          );
        }
      } finally {
        migration.mockRestore();
      }
    },
  );
});

describe("startup cleanup failure aggregation", () => {
  it.each(["workload.close", "pool.end"] as const)(
    "preserves shutdown and %s failure after both real cleanups complete",
    async (cleanupTarget) => {
      const config = loadConfig({
        ...testSecurityEnvironment(),
        ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
        ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString(
          "base64",
        ),
      });
      const reason = createShutdownReason();
      const cleanupFailure = new Error(`${cleanupTarget} failed after actual cleanup`);
      const startup = new AbortController();
      startup.abort(reason);
      const workload = config.authentication.workload;
      const rawWorkloadClose = workload.close.bind(workload);
      let workloadClosePromise: Promise<void> | undefined;
      const closeActualWorkload = () =>
        (workloadClosePromise ??= Promise.resolve().then(rawWorkloadClose));
      // Composition consumes Pool.end's Promise overload. Preserve the real
      // implementation and each actual Pool while observing that overload.
      const poolPrototype = Pool.prototype as { end(this: Pool): Promise<void> };
      // Capture before spying; every invocation below supplies its actual Pool with .call.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const rawPoolEnd = poolPrototype.end;
      const actualPoolEnds = new Map<Pool, Promise<void>>();
      let workloadCompletions = 0;
      let poolCompletions = 0;
      const workloadClose = vi.spyOn(workload, "close").mockImplementation(async () => {
        await closeActualWorkload();
        workloadCompletions++;
        if (cleanupTarget === "workload.close") throw cleanupFailure;
      });
      const poolEnd = vi.spyOn(poolPrototype, "end").mockImplementation(async function (
        this: Pool,
      ) {
        let actual = actualPoolEnds.get(this);
        if (actual === undefined) {
          actual = Promise.resolve().then(() => rawPoolEnd.call(this));
          actualPoolEnds.set(this, actual);
        }
        await actual;
        poolCompletions++;
        if (cleanupTarget === "pool.end") throw cleanupFailure;
      });
      const migration = vi.spyOn(migrations, "migrate");
      const workspace = vi.spyOn(AgentAcpHttpServer.prototype, "listen");
      const control = vi.spyOn(AgentAcpHttpServer.prototype, "listenControl");
      const ownershipLost = vi.fn();
      let service: RunningAgentAcpService | undefined;
      let failure: unknown;
      const cleanupFixture = async (): Promise<void> => {
        try {
          const results = await Promise.allSettled([
            ...(service === undefined ? [] : [service.shutdown()]),
            ...actualPoolEnds.values(),
            closeActualWorkload(),
          ]);
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason as unknown] : [],
          );
          if (failures.length !== 0)
            throw new AggregateError(failures, "startup cleanup regression fixture did not close");
        } finally {
          control.mockRestore();
          workspace.mockRestore();
          migration.mockRestore();
          poolEnd.mockRestore();
          workloadClose.mockRestore();
        }
      };
      try {
        try {
          service = await startAgentAcpService(
            config,
            NOOP_TELEMETRY,
            ownershipLost,
            startup.signal,
          );
        } catch (error) {
          failure = error;
        }
        expect(poolEnd).toHaveBeenCalledOnce();
        expect(workloadClose).toHaveBeenCalledOnce();
        expect(poolCompletions).toBe(1);
        expect(workloadCompletions).toBe(1);
        expect(actualPoolEnds.size).toBe(1);
        expect(migration).not.toHaveBeenCalled();
        expect(workspace).not.toHaveBeenCalled();
        expect(control).not.toHaveBeenCalled();
        expect(ownershipLost).not.toHaveBeenCalled();
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError))
          throw new Error("startup discarded its cleanup failure");
        const errors = failure.errors as unknown[];
        expect(errors).toContain(reason);
        expect(errors).toContain(cleanupFailure);
        expect(isShutdownReason(failure)).toBe(false);
      } finally {
        await cleanupFixture();
      }
    },
  );
});

describe("local readiness", () => {
  it("checks only owned PostgreSQL and reports its failure", async () => {
    const query = vi.fn<(sql: string) => Promise<unknown>>().mockResolvedValue({ rows: [] });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Controller unavailable"));
    try {
      expect(await dependenciesReady({ query }, NOOP_TELEMETRY)).toBe(true);
      expect(query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
      expect(network).not.toHaveBeenCalled();
      query.mockRejectedValue(new Error("storage unavailable"));
      expect(await dependenciesReady({ query }, NOOP_TELEMETRY)).toBe(false);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
});

describe("waitForStartupRecovery", () => {
  it("joins original recovery cleanup before surfacing worker ownership loss", async () => {
    const recovery = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<Error>();
    const loss = new WorkerOwnershipLostError();
    const waiting = waitForStartupRecovery(recovery.promise, failure.promise);
    let settled = false;
    const joined = waiting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      failure.resolve(loss);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      recovery.resolve();
      await expect(waiting).rejects.toBe(loss);
    } finally {
      failure.resolve(loss);
      recovery.resolve();
      await Promise.allSettled([recovery.promise, waiting, joined]);
    }
  });

  it("preserves ownership loss and a distinct original recovery failure after joining", async () => {
    const recovery = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<Error>();
    const loss = new WorkerOwnershipLostError();
    const recoveryError = new Error("Original recovery cleanup failed");
    const waiting = waitForStartupRecovery(recovery.promise, failure.promise);
    let settled = false;
    const outcome = waiting.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    try {
      failure.resolve(loss);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      recovery.reject(recoveryError);
      const error = await outcome;
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError))
        throw new Error("Startup recovery discarded its original failure");
      expect(error.errors).toEqual([loss, recoveryError]);
    } finally {
      failure.resolve(loss);
      recovery.reject(recoveryError);
      await Promise.allSettled([recovery.promise, waiting, outcome]);
    }
  });
});
