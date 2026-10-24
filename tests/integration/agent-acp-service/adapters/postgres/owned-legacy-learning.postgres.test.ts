import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as learningRepositories from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-repositories.js";
import { RuntimeConnections } from "../../../../../services/agent-acp-service/src/adapters/runtime-connections.js";
import { buildComponents } from "../../../../../services/agent-acp-service/src/composition.js";
import { loadConfig } from "../../../../../services/agent-acp-service/src/config.js";
import type { LearningTaskClaim } from "../../../../../services/agent-acp-service/src/domain/learning-scan.js";
import { NOOP_TELEMETRY } from "../../../../../services/agent-acp-service/src/ports/telemetry.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { testSecurityEnvironment } from "../../../../../services/agent-acp-service/test/support/auth-fixture.js";
import {
  registration,
  withDatabase,
} from "../../support/run-fencing-fixture.js";
import {
  learning,
  pendingLearning,
  worker,
} from "../../support/startup-recovery-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const a = { organizationId: "organization-1", agentId: "agent-1" };
const b = { organizationId: "organization-2", agentId: "agent-1" };

describe.skipIf(databaseUrl === undefined)(
  "owned composition legacy Learning authority",
  () => {
    it("keeps legacy recovery authority after A retires and releases the global review slot for B", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        const failures: unknown[] = [];
        let originalA: Awaited<ReturnType<typeof learning>> | undefined;
        let pendingB: Awaited<ReturnType<typeof pendingLearning>> | undefined;
        let claimB: LearningTaskClaim | null = null;
        let config: ReturnType<typeof loadConfig> | undefined;
        let connections: RuntimeConnections | undefined;
        let components: ReturnType<typeof buildComponents> | undefined;
        let restoreFactory = () => {};
        const cleanup = async (action: () => Promise<unknown>) => {
          try {
            await action();
          } catch (error) {
            failures.push(error);
          }
        };

        try {
          originalA = await learning(f, a, w.signal, false);
          await originalA.repositories.budget.settle(
            originalA.claim,
            originalA.modelRequestId,
            { inputTokens: 10, outputTokens: 10, durationMs: 100 },
          );
          await originalA.repositories.outcomes.pauseRunning(
            originalA.claim,
            "foreground_preempted",
          );
          pendingB = await pendingLearning(f, b, w.signal, true);

          const createLegacy =
            learningRepositories.createLegacyLearningRepositories;
          const created: ReturnType<typeof createLegacy>[] = [];
          const factory = vi
            .spyOn(learningRepositories, "createLegacyLearningRepositories")
            .mockImplementation((...args) => {
              const repositories = createLegacy(...args);
              created.push(repositories);
              return repositories;
            });
          restoreFactory = () => factory.mockRestore();
          config = loadConfig({
            ...testSecurityEnvironment(),
            ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
              process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS ?? "false",
            ANTNEST_ACP_DATABASE_URL: databaseUrl!,
            ANTNEST_ACP_CLIENT_MCP_KEY: randomBytes(32).toString("base64"),
            ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL:
              "http://controller.invalid:8080",
            ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID:
              "owned-legacy-learning-test",
            ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: generateKeyPairSync(
              "ed25519",
            )
              .privateKey.export({ type: "pkcs8", format: "der" })
              .toString("base64"),
          });
          connections = new RuntimeConnections({
            authMode: "token",
            allowInsecureTransport: "true",
          });
          components = buildComponents(
            f.a,
            config,
            NOOP_TELEMETRY,
            (error) => failures.push(error),
            w.signal,
            connections,
            registration(),
          );
          expect(components.owned).toBeDefined();
          const beforePreparation = created.length;
          expect(beforePreparation).toBeGreaterThan(0);
          await components.directory.apply(executionConfiguration());
          expect(created.length).toBeGreaterThan(beforePreparation);
          const compatibility = created.at(-1)!;

          // No background worker or model request runs here. These are the real
          // repositories built for the owned graph's legacy recovery lane.
          await expect(
            compatibility.outcomes.resumePaused(
              originalA.claim,
              originalA.policy,
            ),
          ).resolves.toEqual({ state: "running" });
          components.owned!.withdraw(a.organizationId);
          expect(w.lock.isHeld()).toBe(true);
          expect(w.signal.aborted).toBe(false);
          await expect(
            compatibility.outcomes.pauseRunning(originalA.claim, "worker_lost"),
          ).resolves.toEqual({ state: "paused", reason: "worker_lost" });
          expect(
            (
              await f.observer.query(
                `SELECT state,pause_reason,claim_id,generation,authority_mode,
                  claim_owner_registration_id,claim_owner_member_id,
                  claim_owner_incarnation_id,claim_owner_epoch
                 FROM learning_tasks WHERE id=$1`,
                [originalA.taskId],
              )
            ).rows,
          ).toEqual([
            {
              state: "paused",
              pause_reason: "worker_lost",
              claim_id: originalA.claim.claimId,
              generation: originalA.claim.generation,
              authority_mode: "legacy",
              claim_owner_registration_id: null,
              claim_owner_member_id: null,
              claim_owner_incarnation_id: null,
              claim_owner_epoch: null,
            },
          ]);
          claimB = await pendingB.repositories.scan.claimNext(
            pendingB.policy,
            pendingB.taskId,
          );
          expect(claimB).toMatchObject({ taskId: pendingB.taskId, ...b });
          expect(
            (
              await f.observer.query(
                "SELECT state,authority_mode FROM learning_tasks WHERE id=$1",
                [pendingB.taskId],
              )
            ).rows,
          ).toEqual([{ state: "running", authority_mode: "owned" }]);
        } catch (error) {
          failures.push(error);
        } finally {
          await cleanup(async () => {
            if (originalA === undefined) return;
            const current = await f.observer.query<{ state: string }>(
              "SELECT state FROM learning_tasks WHERE id=$1",
              [originalA.taskId],
            );
            if (current.rows[0]?.state === "running")
              await originalA.repositories.outcomes.pauseRunning(
                originalA.claim,
                "worker_lost",
              );
          });
          await cleanup(async () => {
            if (pendingB !== undefined && claimB !== null)
              await pendingB.repositories.outcomes.pauseRunning(
                claimB,
                "worker_lost",
              );
          });
          await cleanup(() =>
            Promise.resolve(components?.learningNotices.stop()),
          );
          await cleanup(async () => components?.owned?.shutdown());
          await cleanup(async () => components?.supervisor.shutdown());
          await cleanup(async () => {
            if (connections === undefined) return;
            await connections.close();
            expect(existsSync(connections.directory)).toBe(false);
          });
          await cleanup(async () => config?.authentication.workload.close());
          restoreFactory();
          await cleanup(() => w.close());
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            "Legacy Learning authority business or cleanup failed",
          );
      });
    });
  },
);
