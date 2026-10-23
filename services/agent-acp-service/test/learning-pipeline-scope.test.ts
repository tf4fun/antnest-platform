import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { buildLearningPipeline, type LearningPipelineInput } from "../src/composition-learning.js";
import { loadConfig } from "../src/config.js";
import { McpToolCatalog } from "../src/adapters/mcp/tool-catalog.js";
import { createLegacyAgentRepositories } from "../src/adapters/postgres/agent-repositories.js";
import { PostgresKernel } from "../src/adapters/postgres/kernel.js";
import { createLegacyLearningRepositories } from "../src/adapters/postgres/learning-repositories.js";
import { PostgresLearningTaskOutcomes } from "../src/adapters/postgres/learning-task-outcomes.js";
import { SecretBox } from "../src/adapters/postgres/secret-box.js";
import { LearningForegroundGate } from "../src/application/learning-foreground-gate.js";
import { TemporarySkills } from "../src/application/temporary-skills.js";
import { NOOP_TELEMETRY } from "../src/ports/telemetry.js";
import { testSecurityEnvironment } from "./support/auth-fixture.js";
import { localExecution } from "./support/local-execution.js";

describe("fixed legacy Learning pipeline scope", () => {
  it.each(["replace scope", "mutate scope fields"] as const)(
    "keeps paused recovery scoped after callers %s",
    async (mutation) => {
      const pool = new Pool({ connectionString: "postgres://unused/unused" });
      const listPaused = vi
        .spyOn(PostgresLearningTaskOutcomes.prototype, "listPaused")
        .mockResolvedValue([]);
      const failures: unknown[] = [];
      let config: ReturnType<typeof loadConfig> | undefined;
      let local: Awaited<ReturnType<typeof localExecution>> | undefined;
      try {
        local = await localExecution(false);
        config = loadConfig({
          ...testSecurityEnvironment(),
          ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
          ANTNEST_ACP_CLIENT_MCP_KEY: randomBytes(32).toString("base64"),
          ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL: "http://controller:8080",
          ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "learning-scope-test",
          ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: generateKeyPairSync("ed25519")
            .privateKey.export({ type: "pkcs8", format: "der" })
            .toString("base64"),
        });
        const controller = vi
          .fn<typeof fetch>()
          .mockRejectedValue(new Error("Unexpected Controller request"));
        config.dependencyFetchers.controller = controller;
        const signal = new AbortController().signal;
        const kernel = new PostgresKernel(pool);
        const repositories = createLegacyAgentRepositories(
          kernel,
          new SecretBox(config.clientMcpKey),
          signal,
        );
        const connect = vi.fn(() => Promise.reject(new Error("Unexpected Runtime connection")));
        const temporaryRuntime = {
          install: vi.fn(() => Promise.reject(new Error("Unexpected temporary install"))),
          cleanup: vi.fn(() => Promise.reject(new Error("Unexpected temporary cleanup"))),
        };
        const scope = { organizationId: "organization-a", agentId: "agent-a" };
        const expected = { ...scope };
        const input: LearningPipelineInput = {
          config,
          learningRepositories: createLegacyLearningRepositories(kernel, signal),
          kernel,
          directory: local.directory,
          providers: local.clients,
          rawTools: new McpToolCatalog({
            revisions: repositories.sessions,
            runtimeDialer: { connect },
          }),
          gate: new LearningForegroundGate(() => false),
          telemetry: NOOP_TELEMETRY,
          temporarySkills: new TemporarySkills(repositories.temporarySkills, temporaryRuntime),
          runtimeConnections: local.connections,
          recoveryScope: scope,
        };
        const pipeline = buildLearningPipeline(input);
        expect(pipeline).toBeDefined();
        if (pipeline === undefined) throw new Error("Expected the configured Learning pipeline");
        if (mutation === "replace scope") Object.assign(input, { recoveryScope: undefined });
        else {
          scope.organizationId = "organization-b";
          scope.agentId = "agent-b";
        }

        await pipeline.paused.next(null, signal);
        expect(listPaused).toHaveBeenCalledExactlyOnceWith(null, 100, expected);
        expect(controller).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        expect(temporaryRuntime.install).not.toHaveBeenCalled();
        expect(temporaryRuntime.cleanup).not.toHaveBeenCalled();
      } catch (error) {
        failures.push(error);
      } finally {
        listPaused.mockRestore();
        const closed = await Promise.allSettled([
          pool.end(),
          ...(config === undefined ? [] : [config.authentication.workload.close()]),
          ...(local === undefined ? [] : [local.connections.close()]),
        ]);
        for (const result of closed)
          if (result.status === "rejected") failures.push(result.reason as unknown);
        if (local !== undefined) {
          try {
            expect(existsSync(local.connections.directory)).toBe(false);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Learning pipeline scope or cleanup failed");
    },
  );
});
