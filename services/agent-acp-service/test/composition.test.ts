import { testSecurityEnvironment } from "./support/auth-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { NOOP_TELEMETRY, type TelemetryPort } from "../src/ports/telemetry.js";

import * as migrations from "../src/adapters/postgres/migrate.js";
import { WorkerOwnershipLostError } from "../src/adapters/postgres/worker-lock.js";
import {
  dependenciesReady,
  startAgentAcpService,
  waitForStartupRecovery,
} from "../src/composition.js";
import { loadConfig } from "../src/config.js";

describe("development startup diagnostics", () => {
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
            ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.alloc(32, 7).toString("base64"),
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
  it("surfaces worker ownership loss without waiting for recovery cleanup", async () => {
    const recovery = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<Error>();
    const waiting = waitForStartupRecovery(recovery.promise, failure.promise);

    failure.resolve(new WorkerOwnershipLostError());

    await expect(waiting).rejects.toBeInstanceOf(WorkerOwnershipLostError);
    recovery.resolve();
  });
});
