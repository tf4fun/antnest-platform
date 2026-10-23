import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { buildComponents } from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import { AgentGenerations, type AgentGeneration } from "../src/application/agent-generations.js";
import { LearningForegroundGate } from "../src/application/learning-foreground-gate.js";
import { PostgresAgentLeases } from "../src/adapters/postgres/agent-leases.js";
import { PostgresAgentStartup } from "../src/adapters/postgres/agent-startup.js";
import { PostgresExecutionConfiguration } from "../src/adapters/postgres/execution-configuration.js";
import { AgentOwnershipLostError } from "../src/domain/agent-ownership.js";
import { publicExecutionConfiguration } from "../src/domain/execution-configuration.js";
import type { AcpApplicationPort } from "../src/ports/acp-application.js";
import { NOOP_TELEMETRY } from "../src/ports/telemetry.js";
import { executionConfiguration } from "./fixtures/execution-configuration.js";
import { testSecurityEnvironment } from "./support/auth-fixture.js";
import { runtimeConnections } from "./support/runtime-connections.js";

describe("owned source read lifetime", () => {
  it("releases the acquired read when ownership is lost before returning its finish handle", async () => {
    const configuration = executionConfiguration();
    vi.spyOn(PostgresExecutionConfiguration.prototype, "load").mockResolvedValue(
      publicExecutionConfiguration(configuration),
    );
    vi.spyOn(PostgresExecutionConfiguration.prototype, "loadAuthority").mockResolvedValue(
      configuration,
    );
    vi.spyOn(PostgresExecutionConfiguration.prototype, "loadOwnedAuthority").mockResolvedValue(
      configuration,
    );
    vi.spyOn(PostgresExecutionConfiguration.prototype, "confirmOwnedAuthority").mockResolvedValue();
    vi.spyOn(PostgresExecutionConfiguration.prototype, "save").mockResolvedValue(true);
    vi.spyOn(PostgresAgentStartup.prototype, "assertAvailable").mockResolvedValue();
    vi.spyOn(PostgresAgentLeases.prototype, "tryAcquire").mockImplementation(
      (scope, ownerInstanceId) =>
        Promise.resolve({
          fence: { ...scope, ownerInstanceId, epoch: "1" },
          observedAt: new Date(),
          expiresAt: new Date(Date.now() + 30_000),
        }),
    );
    const release = vi.spyOn(PostgresAgentLeases.prototype, "release").mockResolvedValue(true);
    const capture = vi.spyOn(AgentGenerations.prototype, "capture");
    // Invoked below with the actual gate as its receiver via .call(this, ...args).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalRead = LearningForegroundGate.prototype.beginSourceRead;
    let finish: (() => void) | undefined;
    vi.spyOn(LearningForegroundGate.prototype, "beginSourceRead").mockImplementation(
      async function (this: LearningForegroundGate, ...args) {
        const read = await originalRead.call(this, ...args);
        finish = vi.fn(() => read.finish());
        return { signal: read.signal, finish };
      },
    );
    const pool = new Pool();
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
      new AbortController().signal,
      connections,
      {
        registration_id: "abcdef01-2345-4abc-8abc-1234567890ab",
        member_id: "acp-a",
        incarnation_id: "abcdef02-2345-4abc-8abc-1234567890ab",
      },
    );
    let delivered: { finish(): void } | undefined;
    try {
      await components.directory.apply(configuration);
      const manager = components.owned!;
      const generation = capture.mock.results.at(-1)?.value as AgentGeneration<AcpApplicationPort>;
      const dispatch = generation.dispatch.bind(generation);
      // Hold the actual return window: operation has acquired its read, while
      // the generation's final authority check has not run yet.
      vi.spyOn(generation, "dispatch").mockImplementation((operation) =>
        dispatch(async (value, signal) => {
          const result = await operation(value, signal);
          if (
            typeof result === "object" &&
            result !== null &&
            "finish" in result &&
            typeof result.finish === "function"
          ) {
            delivered = result as { finish(): void };
            manager.withdraw(configuration.organization_id);
          }
          return result;
        }),
      );
      await expect(
        manager.beginSourceRead(
          {
            organizationId: configuration.organization_id,
            agentId: configuration.agents[0]!.agent_id,
          },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(AgentOwnershipLostError);
      expect(finish).toHaveBeenCalledOnce();
      await manager.shutdown();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      // This cleanup also joins the unfixed regression without abandoning its
      // retained task when the assertion above fails.
      delivered?.finish();
      await components.owned?.shutdown();
      await components.supervisor.shutdown();
      await connections.close();
      await pool.end();
      await config.authentication.workload.close();
      vi.restoreAllMocks();
    }
  });
});
