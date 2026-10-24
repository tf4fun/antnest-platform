import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentApplicationRouter } from "../../../../../services/agent-acp-service/src/application/agent-application-router.js";
import {
  AgentGenerations,
  type AgentGeneration,
} from "../../../../../services/agent-acp-service/src/application/agent-generations.js";
import { AcpApplication } from "../../../../../services/agent-acp-service/src/application/application.js";
import { AccessService } from "../../../../../services/agent-acp-service/src/application/access-service.js";
import { PromptCoordinator } from "../../../../../services/agent-acp-service/src/application/prompt-coordinator.js";
import { RunSupervisor } from "../../../../../services/agent-acp-service/src/application/run-supervisor.js";
import { SessionService } from "../../../../../services/agent-acp-service/src/application/session-service.js";
import { SessionConfigurationService } from "../../../../../services/agent-acp-service/src/application/session-configuration.js";
import { createOwnedAgentRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import {
  RunRecoveryRequiredError,
  type AcpApplicationPort,
} from "../../../../../services/agent-acp-service/src/ports/acp-application.js";
import {
  executionConfiguration,
  runtimeConfiguration,
} from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { localExecution } from "../../../../../services/agent-acp-service/test/support/local-execution.js";
import { binding } from "../../../../../services/agent-acp-service/test/support/fixtures.js";
import {
  expectedOrigin,
  registration,
  withDatabase,
  type FencingFixture,
  type Owned,
} from "../../support/run-fencing-fixture.js";

const outcome = {
  terminalClass: "completed",
  executorState: "quiescent",
  toolEffectState: "none",
  stopReason: "end_turn",
} as const;
const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

async function setup(f: FencingFixture) {
  const local = await localExecution(false);
  const configuration = executionConfiguration();
  configuration.agents.push({
    ...structuredClone(configuration.agents[0]!),
    agent_id: "agent-b",
    runtime: runtimeConfiguration(2),
  });
  await local.directory.apply(configuration);
  const manager = new AgentGenerations<AcpApplicationPort>({
    registration: registration(),
    leases: f.leasesA,
  });
  const access = new AccessService({ directory: local.directory });
  const router = new AgentApplicationRouter({ access, generations: manager });
  const recoveryRequired = vi.fn();
  const supervisors: RunSupervisor[] = [];
  const completionA = Promise.withResolvers<void>();
  const graphs = new Map<
    string,
    {
      generation: AgentGeneration<AcpApplicationPort>;
      repositories: ReturnType<typeof createOwnedAgentRepositories>;
      ownershipLost: ReturnType<typeof vi.fn>;
    }
  >();
  const close = async () => {
    completionA.resolve();
    const results = await Promise.allSettled([
      manager.drain(),
      ...supervisors.map((supervisor) => supervisor.shutdown()),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result): unknown => result.reason),
        "Routing fixture cleanup failed",
      );
  };
  try {
    for (const agentId of ["agent-1", "agent-b"]) {
      const scope = { ...binding(), agentId };
      await manager.prepare(scope, (generation) => {
        const repositories = createOwnedAgentRepositories(
          f.kernelA,
          f.secretBox,
          generation.authority,
        );
        const sessions = new SessionService({
          repository: repositories.sessions,
          id: () => randomUUID(),
          now: () => new Date(),
        });
        // Returning the real close Promise catches an accidental await in persist:
        // close itself must join this same admission before it can settle.
        const ownershipLost = vi.fn((error: AgentOwnershipLostError) =>
          manager.closeScope(scope, error),
        );
        const supervisor = new RunSupervisor({
          execute: async ({ accepted }) => {
            if (agentId === "agent-1") await completionA.promise;
            await repositories.executions.finish({
              ...outcome,
              runId: accepted.runId,
              finishedAt: new Date(),
            });
            local.directory.releaseRuntimeRun(accepted.runId);
            return outcome;
          },
        });
        supervisors.push(supervisor);
        graphs.set(agentId, { generation, repositories, ownershipLost });
        return Promise.resolve(
          new AcpApplication({
            access,
            sessions,
            runs: supervisor,
            configuration: new SessionConfigurationService({
              sessions,
              repository: repositories.sessionConfiguration,
              directory: local.directory,
              now: () => new Date(),
            }),
            prompts: new PromptCoordinator({
              repository: repositories.runs,
              directory: local.directory,
              protection: repositories.executions,
              runTimeoutMs: 60_000,
              recoveryRequired,
              ownershipLost,
              id: () => randomUUID(),
              now: () => new Date(),
            }),
          }),
        );
      });
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Routing fixture initialization failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
  const create = async (agentId: string) => {
    const fixed = { ...binding(), agentId };
    const session = await router.createSession({
      binding: fixed,
      cwd: "/workspace",
      additionalDirectories: [],
      mcpServers: [],
    });
    return {
      binding: fixed,
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Persist this exact Prompt" }],
      outputChanged: () => {},
    };
  };
  return {
    router,
    manager,
    graphs,
    recoveryRequired,
    completionA,
    create,
    close,
  };
}

describe.skipIf(databaseUrl === undefined)(
  "Agent router with real application and PostgreSQL",
  () => {
    it("routes real Session/Prompt writes to their fixed origins while A drains and B completes", async () => {
      await withDatabase(async (f) => {
        const graph = await setup(f);
        try {
          const inputA = await graph.create("agent-1");
          const inputB = await graph.create("agent-b");
          const runA = await graph.router.acceptPrompt(inputA);
          const originalA = graph.graphs.get("agent-1")!;
          expect(await f.origin(runA.runId)).toEqual(
            expectedOrigin({
              authority: originalA.generation.authority,
              runs: originalA.repositories.runs,
            }),
          );
          let stopped = false;
          const closing = graph.manager.closeScope(inputA.binding).then(() => {
            stopped = true;
          });
          const runB = await graph.router.acceptPrompt(inputB);
          expect(await runB.completion).toEqual(outcome);
          expect(
            (
              await f.observer.query("SELECT state FROM runs WHERE id=$1", [
                runB.runId,
              ])
            ).rows,
          ).toEqual([{ state: "completed" }]);
          const originalB = graph.graphs.get("agent-b")!;
          expect(await f.origin(runB.runId)).toEqual(
            expectedOrigin({
              authority: originalB.generation.authority,
              runs: originalB.repositories.runs,
            }),
          );
          expect(stopped).toBe(false);
          const lease = await f.leasesB.read(inputA.binding);
          expect(lease !== null && lease.expiresAt > lease.observedAt).toBe(
            true,
          );
          graph.completionA.resolve();
          await runA.completion;
          await closing;
          expect(
            (
              await f.observer.query("SELECT state FROM runs WHERE id=$1", [
                runA.runId,
              ])
            ).rows,
          ).toEqual([{ state: "completed" }]);
          const released = await f.leasesB.read(inputA.binding);
          expect(
            released !== null && released.expiresAt <= released.observedAt,
          ).toBe(true);
          expect(graph.recoveryRequired).not.toHaveBeenCalled();
        } finally {
          await graph.close();
        }
      });
    });

    it.each(["createRunIntent", "acceptRun"] as const)(
      "real lease takeover at %s closes A without global recovery or a self-join",
      async (boundary) => {
        await withDatabase(async (f) => {
          const graph = await setup(f);
          let next: Owned | undefined;
          try {
            const inputA = await graph.create("agent-1");
            const inputB = await graph.create("agent-b");
            const original = graph.graphs.get("agent-1")!;
            const takeOver = async () => {
              next = await f.successor({
                authority: {
                  fence: { ...original.generation.authority.fence },
                  registration: {
                    ...original.generation.authority.registration,
                  },
                },
                runs: original.repositories.runs,
              });
            };
            if (boundary === "createRunIntent") {
              const operation = original.repositories.runs.createRunIntent.bind(
                original.repositories.runs,
              );
              vi.spyOn(
                original.repositories.runs,
                "createRunIntent",
              ).mockImplementationOnce(async (input) => {
                await takeOver();
                return operation(input);
              });
            } else {
              const operation = original.repositories.runs.acceptRun.bind(
                original.repositories.runs,
              );
              vi.spyOn(
                original.repositories.runs,
                "acceptRun",
              ).mockImplementationOnce(async (input) => {
                await takeOver();
                return operation(input);
              });
            }
            const error = await graph.router
              .acceptPrompt(inputA)
              .catch((error: unknown) => error);
            expect(error).toBeInstanceOf(RunRecoveryRequiredError);
            expect((error as Error).cause).toBeInstanceOf(
              AgentOwnershipLostError,
            );
            expect(original.ownershipLost).toHaveBeenCalledOnce();
            expect(graph.recoveryRequired).not.toHaveBeenCalled();
            expect(() => graph.manager.capture(inputA.binding)).toThrow(
              AgentOwnershipLostError,
            );
            expect(
              (
                await f.observer.query(
                  "SELECT state FROM runs WHERE session_id=$1",
                  [inputA.sessionId],
                )
              ).rows,
            ).toEqual(
              boundary === "createRunIntent" ? [] : [{ state: "admitting" }],
            );
            const runB = await graph.router.acceptPrompt(inputB);
            await runB.completion;
            expect(
              (
                await f.observer.query("SELECT state FROM runs WHERE id=$1", [
                  runB.runId,
                ])
              ).rows,
            ).toEqual([{ state: "completed" }]);
          } finally {
            try {
              await graph.close();
            } finally {
              if (next !== undefined)
                await f.leasesB.release(next.authority.fence);
            }
          }
        });
      },
    );
  },
);
