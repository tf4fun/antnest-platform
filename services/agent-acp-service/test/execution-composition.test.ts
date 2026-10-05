import { testSecurityEnvironment } from "./support/auth-fixture.js";
import { runtimeConnections } from "./support/runtime-connections.js";
import { getEventListeners } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildComponents } from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import { PostgresExecutionConfiguration } from "../src/adapters/postgres/execution-configuration.js";
import { RunExecutor } from "../src/application/run-executor.js";
import { LearningWorker } from "../src/application/learning-worker.js";
import { LifecycleLearningStopped } from "../src/application/learning-foreground-gate.js";
import type { PublicExecutionConfiguration } from "../src/domain/execution-configuration.js";
import type { ExecuteRunResult, SessionOutputSnapshot } from "../src/ports/acp-application.js";
import { NOOP_TELEMETRY } from "../src/ports/telemetry.js";
import { binding, snapshot } from "./support/fixtures.js";
import { executionConfiguration } from "./fixtures/execution-configuration.js";
import { PostgresTemporarySkills } from "../src/adapters/postgres/temporary-skills.js";
import { RuntimeSkillTemporaryClient } from "../src/adapters/runtime-skill-temporary-client.js";
import { TemporarySkillCleanupWorker } from "../src/application/temporary-skill-cleanup-worker.js";

beforeEach(() => {
  vi.spyOn(PostgresTemporarySkills.prototype, "forAgent").mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe("production execution configuration composition", () => {
  it("keeps temporary cleanup and its foreground admission guard even with discovery disabled", async () => {
    const pool = new Pool();
    const scope = {
      revision: `rtv_${"a".repeat(32)}`,
      connectionId: `rci_${"b".repeat(32)}`,
      organizationId: binding().organizationId,
      agentId: binding().agentId,
      runId: "previous-run",
      executionId: "old-execution",
      mcpEndpoint: "http://runtime:8093/mcp",
    };
    vi.spyOn(PostgresTemporarySkills.prototype, "forAgent").mockResolvedValue([scope]);
    const cleanup = vi
      .spyOn(RuntimeSkillTemporaryClient.prototype, "cleanup")
      .mockRejectedValue(new Error("not-confirmed"));
    const components = buildComponents(
      pool,
      loadConfig({
        ...testSecurityEnvironment(),
        ...{
          ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
          ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString(
            "base64",
          ),
        },
      }),
      NOOP_TELEMETRY,
      vi.fn(),
      new AbortController().signal,
      runtimeConnections(),
    );
    const accept = vi.fn();
    try {
      expect(components.temporarySkillCleanupWorker).toBeInstanceOf(TemporarySkillCleanupWorker);
      await expect(
        components.supervisor.submit(
          { binding: binding(), sessionId: "session-1", outputChanged: vi.fn() },
          accept,
        ),
      ).rejects.toMatchObject({ code: "runtime_barrier_required" });
      expect(cleanup).toHaveBeenCalledWith(scope, expect.any(AbortSignal));
      expect(accept).not.toHaveBeenCalled();
    } finally {
      await components.supervisor.shutdown();
      await pool.end();
    }
  });
  it("closes active Skill learning when Controller publishes a lifecycle-closed Agent", async () => {
    const stored = new Map<string, PublicExecutionConfiguration>();
    vi.spyOn(PostgresExecutionConfiguration.prototype, "load").mockImplementation((id) =>
      Promise.resolve(stored.get(id) ?? null),
    );
    vi.spyOn(PostgresExecutionConfiguration.prototype, "save").mockImplementation((value) => {
      stored.set(value.organization_id, value);
      return Promise.resolve(true);
    });
    const pool = new Pool();
    try {
      const components = buildComponents(
        pool,
        loadConfig({
          ...testSecurityEnvironment(),
          ...{
            ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
            ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString(
              "base64",
            ),
          },
        }),
        NOOP_TELEMETRY,
        vi.fn(),
        new AbortController().signal,
        runtimeConnections(),
      );
      const open = executionConfiguration();
      await components.directory.apply(open);
      const scope = { organizationId: open.organization_id, agentId: open.agents[0]!.agent_id };
      const maintenance = components.learningGate.begin(scope, new AbortController().signal);
      const closed = structuredClone(open);
      closed.revision += 1;
      closed.agents[0]!.accepting_runs = false;
      delete closed.agents[0]!.runtime?.credential;
      closed.agents[0]!.operation_id = "operation-1";
      await components.directory.apply(closed);
      expect(maintenance.signal.reason).toBeInstanceOf(LifecycleLearningStopped);
      maintenance.finish(true);
      expect(() => components.learningGate.begin(scope, new AbortController().signal)).toThrow();
    } finally {
      await pool.end();
    }
  });

  it("assembles Skill learning only with both a Controller endpoint and signing identity", async () => {
    const pool = new Pool();
    const basic = {
      ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
      ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString(
        "base64",
      ),
    };
    const signer = {
      ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "learning-test",
      ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "der" })
        .toString("base64"),
    };
    const configured = buildComponents(
      pool,
      loadConfig({
        ...testSecurityEnvironment(),
        ...{
          ...basic,
          ...signer,
          ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL: "http://controller:8080",
        },
      }),
      NOOP_TELEMETRY,
      vi.fn(),
      new AbortController().signal,
      runtimeConnections(),
    );
    try {
      expect(
        buildComponents(
          pool,
          loadConfig({ ...testSecurityEnvironment(), ...basic }),
          NOOP_TELEMETRY,
          vi.fn(),
          new AbortController().signal,
          runtimeConnections(),
        ).learningWorker,
      ).toBeUndefined();
      expect(
        buildComponents(
          pool,
          loadConfig({ ...testSecurityEnvironment(), ...{ ...basic, ...signer } }),
          NOOP_TELEMETRY,
          vi.fn(),
          new AbortController().signal,
          runtimeConnections(),
        ).learningWorker,
      ).toBeUndefined();
      expect(configured.learningWorker).toBeInstanceOf(LearningWorker);
    } finally {
      await pool.end();
    }
  });

  it.each([false, true])(
    "publishes local revocation to every active consumer (publication failure: %s)",
    async (failPublication) => {
      const stored = new Map<string, PublicExecutionConfiguration>();
      vi.spyOn(PostgresExecutionConfiguration.prototype, "load").mockImplementation((id) =>
        Promise.resolve(stored.get(id) ?? null),
      );
      vi.spyOn(PostgresExecutionConfiguration.prototype, "save").mockImplementation((value) => {
        stored.set(value.organization_id, value);
        return Promise.resolve(true);
      });
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network request"));
      const completed: ExecuteRunResult = {
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "none",
        stopReason: "end_turn",
      };
      const finish = Promise.withResolvers<ExecuteRunResult>();
      const execute = vi.spyOn(RunExecutor.prototype, "execute").mockReturnValue(finish.promise);
      const pool = new Pool();
      const config = loadConfig({
        ...testSecurityEnvironment(),
        ...{
          ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
          ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString(
            "base64",
          ),
        },
      });
      const components = buildComponents(
        pool,
        config,
        NOOP_TELEMETRY,
        vi.fn(),
        new AbortController().signal,
        runtimeConnections(),
      );
      const lifetime = new AbortController();
      const pendingOutput = Promise.withResolvers<SessionOutputSnapshot>();
      let attachment: Promise<boolean> | undefined;
      try {
        await expect(
          components.application.assertAccess({ binding: binding() }),
        ).rejects.toMatchObject({ code: "configuration_not_ready" });
        await components.directory.apply(executionConfiguration());
        await components.application.assertAccess({ binding: binding() });
        const running = await components.supervisor.submit(
          { binding: binding(), sessionId: "session-1", outputChanged: vi.fn() },
          () =>
            Promise.resolve({
              runId: "run-1",
              requestId: "request-1",
              sessionId: "session-1",
              userMessageId: "message-1",
              outputSequence: 0,
              snapshot: snapshot(),
            }),
        );
        const executionState = vi.fn(() => Promise.resolve());
        await components.executionState.read(binding(), executionState, lifetime.signal);
        expect(executionState).toHaveBeenCalledWith(
          expect.objectContaining({ availability: "busy", active_session_id: "session-1" }),
          expect.any(AbortSignal),
        );
        components.permissionConnections.attach({
          binding: binding(),
          sessionId: "session-1",
          signal: lifetime.signal,
          request: vi.fn(),
        });
        const send = vi.fn(() => Promise.resolve());
        attachment = components.outputs.attach({
          identity: binding(),
          key: "session-1",
          connectionId: "connection-1",
          read: () => pendingOutput.promise,
          signal: lifetime.signal,
          send,
          onFailure: vi.fn(),
        });
        const closed = executionConfiguration();
        closed.revision = 2;
        closed.agents[0]!.accepting_runs = false;
        delete closed.agents[0]!.runtime?.credential;
        closed.agents[0]!.unavailable_reason = "Rebuilding";
        await components.directory.apply(closed);
        expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(false);
        expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(2);
        const changed = { ...closed, revision: 3, agents: [] };
        if (failPublication) {
          vi.spyOn(components.outputs, "revokeAccess").mockImplementationOnce(() => {
            throw new Error("Publication failed");
          });
          await expect(components.directory.apply(changed)).rejects.toThrow("Publication failed");
        } else {
          await expect(components.directory.apply(changed)).resolves.toHaveProperty(
            "applied_revision",
            3,
          );
        }
        expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(true);
        expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(0);
        await attachment;
        pendingOutput.resolve({
          sequence: 1,
          events: [
            {
              kind: "agent_message",
              messageId: "private",
              content: [{ type: "text", text: "private output" }],
            },
          ],
          state: { kind: "state", state: "idle" },
        });
        await components.outputs.flush("session-1");
        expect(send).not.toHaveBeenCalled();
        await expect(
          components.application.assertAccess({ binding: binding() }),
        ).rejects.toMatchObject({
          code: failPublication ? "configuration_not_ready" : "access_denied",
        });
        await components.directory.apply({ ...executionConfiguration(), revision: 4 });
        await components.application.assertAccess({ binding: binding() });
        expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(true);
        expect(network).not.toHaveBeenCalled();
        finish.resolve(completed);
        await running.completion;
      } finally {
        finish.resolve(completed);
        lifetime.abort();
        pendingOutput.resolve({ sequence: 0, events: [], state: { kind: "state", state: "idle" } });
        await attachment;
        await components.supervisor.shutdown();
        await pool.end();
      }
    },
  );
});
