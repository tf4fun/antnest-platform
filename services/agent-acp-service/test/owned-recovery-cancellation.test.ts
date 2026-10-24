import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { buildComponents } from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import { PostgresAgentLeases } from "../src/adapters/postgres/agent-leases.js";
import { PostgresOwnerRecovery } from "../src/adapters/postgres/owner-recovery.js";
import { PostgresAgentStartup } from "../src/adapters/postgres/agent-startup.js";
import { AgentOwnershipLostError } from "../src/domain/agent-ownership.js";
import { publicExecutionConfiguration } from "../src/domain/execution-configuration.js";
import type { OwnerInspection } from "../src/application/owner-inspection.js";
import { NOOP_TELEMETRY } from "../src/ports/telemetry.js";
import { executionConfiguration } from "./fixtures/execution-configuration.js";
import { testSecurityEnvironment } from "./support/auth-fixture.js";
import { runtimeConnections } from "./support/runtime-connections.js";

it.each(["run", "learning"] as const)(
  "does not start %s recovery after cancellation in the accepted proof return window",
  async (kind) => {
    const cancellation = new AbortController();
    const order: string[] = [];
    const original = {
      registration_id: randomUUID(),
      member_id: "previous-owner",
      incarnation_id: randomUUID(),
    };
    const proof: Extract<OwnerInspection, { state: "stopped" }> = {
      ...original,
      state: "stopped",
      stop_receipt: {
        receipt_id: randomUUID(),
        reason: "container_stopped",
        observed_at: new Date().toISOString(),
      },
    };
    const readProof = vi.fn(() => {
      // Queue loss after inspect's synchronous checks, before its caller's await
      // resumes. No request or transaction should start after this boundary.
      order.push("proof");
      queueMicrotask(() => {
        order.push("abort");
        cancellation.abort(new AgentOwnershipLostError());
      });
      return proof;
    });
    const item = {
      runId: randomUUID(),
      taskId: randomUUID(),
      claimId: randomUUID(),
      generation: 1,
      registration: original,
      get inspection() {
        return readProof();
      },
    };
    const runs = vi
      .spyOn(PostgresOwnerRecovery.prototype, "listPredecessors")
      .mockResolvedValue(kind === "run" ? [item] : []);
    const learning = vi
      .spyOn(PostgresOwnerRecovery.prototype, "listLearningPredecessors")
      .mockResolvedValue(kind === "learning" ? [item] : []);
    const recoverRun = vi
      .spyOn(PostgresOwnerRecovery.prototype, "recoverRun")
      .mockResolvedValue("recovered");
    const recoverLearning = vi
      .spyOn(PostgresOwnerRecovery.prototype, "recoverLearning")
      .mockResolvedValue("recovered");
    const inventory = vi
      .spyOn(PostgresAgentStartup.prototype, "assertAvailable")
      .mockRejectedValue(new AgentOwnershipLostError());
    vi.spyOn(PostgresAgentLeases.prototype, "tryAcquire").mockImplementation(
      (scope, ownerInstanceId) =>
        Promise.resolve({
          fence: { ...scope, ownerInstanceId, epoch: "2" },
          observedAt: new Date(),
          expiresAt: new Date(Date.now() + 30_000),
        }),
    );
    const release = vi.spyOn(PostgresAgentLeases.prototype, "release").mockResolvedValue(true);
    const pool = new Pool();
    const connect = vi.spyOn(pool, "connect").mockImplementation(() => {
      throw new Error("Unexpected database connection in recovery cancellation fixture");
    });
    const query = vi.spyOn(pool, "query").mockImplementation(() => {
      throw new Error("Unexpected database query in recovery cancellation fixture");
    });
    const config = loadConfig({
      ...testSecurityEnvironment(),
      ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
      ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString(
        "base64",
      ),
    });
    const connections = runtimeConnections();
    const components = buildComponents(
      pool,
      config,
      NOOP_TELEMETRY,
      vi.fn(),
      cancellation.signal,
      connections,
      {
        registration_id: randomUUID(),
        member_id: "current-owner",
        incarnation_id: randomUUID(),
      },
    );
    try {
      await expect(
        components.owned!.prepare(publicExecutionConfiguration(executionConfiguration())),
      ).rejects.toBeInstanceOf(AgentOwnershipLostError);
      expect(readProof).toHaveBeenCalledOnce();
      expect(cancellation.signal.aborted).toBe(true);
      expect(order).toEqual(["proof", "abort"]);
      expect(runs).toHaveBeenCalledOnce();
      expect(learning).toHaveBeenCalledTimes(kind === "learning" ? 1 : 0);
      expect(recoverRun).not.toHaveBeenCalled();
      expect(recoverLearning).not.toHaveBeenCalled();
      expect(inventory).not.toHaveBeenCalled();
    } finally {
      try {
        await components.owned!.shutdown();
        await components.supervisor.shutdown();
        await connections.close();
        await pool.end();
        await config.authentication.workload.close();
        expect(release).toHaveBeenCalledOnce();
        expect(connect).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    }
  },
);
