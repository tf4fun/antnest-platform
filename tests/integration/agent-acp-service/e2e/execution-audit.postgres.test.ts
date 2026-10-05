import {
  testSecurityEnvironment,
  testAuthentication,
  testHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  startAgentAcpService,
  type RunningAgentAcpService,
} from "../../../../services/agent-acp-service/src/composition.js";
import { loadConfig } from "../../../../services/agent-acp-service/src/config.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresRunRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { PostgresSessionRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { SecretBox } from "../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import { auditDetailSchema } from "../../../../services/agent-acp-service/src/domain/execution-audit.js";
import { LearningWorker } from "../../../../services/agent-acp-service/src/application/learning-worker.js";

const url = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
describe.skipIf(url === undefined)("production audit HTTP composition", () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const kernel = new PostgresKernel(pool);
  const key = randomBytes(32);
  const sessions = new PostgresSessionRepository(kernel, new SecretBox(key));
  const runs = new PostgresRunRepository(kernel);
  const config = {
    ...loadConfig({
      ...testSecurityEnvironment(),
      ...{
        ANTNEST_ACP_DATABASE_URL: url ?? "postgres://unused/unused",
        ANTNEST_ACP_CLIENT_MCP_KEY: key.toString("base64"),
        ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
          process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS ?? "false",
      },
    }),
    listen: { host: "127.0.0.1", port: 0 },
    controlListen: { host: "127.0.0.1", port: 0 },
    authentication: testAuthentication(),
  };
  const ownershipLost = vi.fn();
  let service: RunningAgentAcpService | undefined;
  const headers = {
    "content-type": "application/json",
    "X-Antnest-User-ID": "audit-admin",
    "X-Antnest-Organization-ID": "org-1",
    "X-Antnest-Membership-ID": "membership-1",
    "X-Antnest-System-Role": "user",
    "X-Antnest-Organization-Role": "admin",
  };
  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
  });
  afterAll(async () => {
    try {
      await service?.shutdown();
    } finally {
      await pool.end();
    }
  });
  function request(
    path: string,
    input: unknown,
    override: Record<string, string> = {},
    caller = "admin-console",
  ) {
    const address = service?.address();
    if (address == null || typeof address === "string")
      throw new Error("No listening address");
    const identity: Record<string, string> = { ...headers, ...override };
    if (caller === "edge-gateway") delete identity["X-Antnest-User-ID"];
    return fetch(`http://127.0.0.1:${address.port}/rpc/agent-acp/${path}`, {
      method: "POST",
      headers: testHeaders(identity, caller),
      body: JSON.stringify(input),
    });
  }

  it("reads retained input across service restarts without granting execution or cross-org audit access", async () => {
    service = await startAgentAcpService(config, NOOP_TELEMETRY, ownershipLost);
    const sessionId = randomUUID(),
      runId = randomUUID();
    await sessions.create({
      sessionId,
      binding: {
        connectionId: randomUUID(),
        organizationId: "org-1",
        principalId: "owner-1",
        agentId: "deleted-agent",
      },
      cwd: "/workspace",
      mcpRevisionId: randomUUID(),
      mcpSources: [],
    });
    await runs.createRunIntent({
      runId,
      requestId: randomUUID(),
      sessionId,
      expectedAccessRevision: "access-1",
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "retained trigger" }],
      createdAt: new Date(),
    });
    await runs.rejectRun(runId, "provider_unavailable", new Date());
    await pool.query(
      "UPDATE acp_sessions SET state = 'deleted' WHERE id = $1",
      [sessionId],
    );
    for (let boot = 0; boot < 2; boot++) {
      const response = await request("get-execution-audit", { run_id: runId });
      expect(response.status).toBe(200);
      expect(auditDetailSchema.parse(await response.json())).toMatchObject({
        run_id: runId,
        state: "failed",
        input: [{ type: "text", text: "retained trigger" }],
        execution_snapshot: null,
        error_class: "provider_unavailable",
      });
      expect(
        (
          await request(
            "get-execution-audit",
            { run_id: runId },
            {
              "X-Antnest-Organization-ID": "org-2",
              "X-Antnest-System-Role": "admin",
            },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(
            "list-execution-audits",
            {},
            {
              "X-Antnest-Organization-Role": "member",
            },
          )
        ).status,
      ).toBe(403);
      const execution = await request(
        "get-agent-execution-state",
        {},
        {
          "X-Antnest-Principal-ID": "owner-1",
          "X-Antnest-Agent-ID": "deleted-agent",
        },
        "edge-gateway",
      );
      expect(execution.status).toBe(503);
      expect(await execution.json()).toMatchObject({
        code: "execution_state_unavailable",
      });
      expect(await sessions.replay(sessionId)).toEqual([]);
      if (boot === 0) {
        await service.shutdown();
        service = await startAgentAcpService(
          config,
          NOOP_TELEMETRY,
          ownershipLost,
        );
      }
    }
    expect(ownershipLost).not.toHaveBeenCalled();
  });

  it("starts the configured learning worker and stops it before releasing service ownership", async () => {
    await service?.shutdown();
    const run = vi.spyOn(LearningWorker.prototype, "run").mockImplementation(
      (signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const configured = {
      ...config,
      skillLearningControllerUrl: "http://controller.test:8080",
      skillMaintenanceSigning: {
        kid: "learning-test",
        privateKey: generateKeyPairSync("ed25519").privateKey,
      },
    };
    try {
      service = await startAgentAcpService(
        configured,
        NOOP_TELEMETRY,
        ownershipLost,
      );
      expect(run).toHaveBeenCalledTimes(1);
      const signal = run.mock.calls[0]?.[0];
      expect(signal?.aborted).toBe(false);
      await service.shutdown();
      expect(signal?.aborted).toBe(true);
    } finally {
      run.mockRestore();
    }
  });
});
