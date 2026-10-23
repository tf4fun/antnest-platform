import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { describe, expect, it, vi } from "vitest";
import {
  createOwnedAgentRepositories,
  createLegacyAgentRepositories,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import { AcpApplication } from "../../../../../services/agent-acp-service/src/application/application.js";
import { AccessService } from "../../../../../services/agent-acp-service/src/application/access-service.js";
import { SessionService } from "../../../../../services/agent-acp-service/src/application/session-service.js";
import { SessionConfigurationService } from "../../../../../services/agent-acp-service/src/application/session-configuration.js";
import { RunSupervisor } from "../../../../../services/agent-acp-service/src/application/run-supervisor.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { configurationRevisionToken } from "../../../../../services/agent-acp-service/src/domain/configuration-revision.js";
import type { ExecuteRunResult } from "../../../../../services/agent-acp-service/src/ports/acp-application.js";
import { localExecution } from "../../../../../services/agent-acp-service/test/support/local-execution.js";
import {
  scope,
  withDatabase,
  type FencingFixture,
  type Owned,
  type Session,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
type Repositories = ReturnType<typeof createOwnedAgentRepositories>;
async function application(
  repositories: Repositories,
  supervisor = new RunSupervisor({
    execute: () => Promise.reject(new Error("Unexpected execution")),
  }),
) {
  const { directory } = await localExecution();
  const sessions = new SessionService({
    repository: repositories.sessions,
    id: () => randomUUID(),
    now: () => new Date(),
  });
  const configuration = new SessionConfigurationService({
    sessions,
    repository: repositories.sessionConfiguration,
    directory,
    now: () => new Date(),
  });
  const cancel = vi.spyOn(supervisor, "cancel");
  const cancelTarget = vi.spyOn(supervisor, "cancelTarget");
  const app = new AcpApplication({
    sessions,
    configuration,
    access: new AccessService({ directory }),
    runs: supervisor,
    prompts: {
      accept: () => Promise.reject(new Error("Unexpected Prompt acceptance")),
      checkBridgeIntent: () =>
        Promise.reject(new Error("Unexpected bridge intent")),
    },
  });
  return { app, cancel, cancelTarget, supervisor };
}
async function setup(f: FencingFixture, running = false) {
  const session = await f.session(scope("agent-1"));
  const owner = await f.owner(session.binding);
  const repositories = createOwnedAgentRepositories(
    f.kernelA,
    f.secretBox,
    owner.authority,
  );
  const intent = f.input(session);
  const acceptance = f.acceptance(session, intent.runId);
  if (running) {
    await repositories.runs.createRunIntent(intent);
    await repositories.runs.acceptRun(acceptance);
  }
  return { session, owner, repositories, intent, acceptance };
}
const sessionInput = (session: Session) => ({
  sessionId: session.sessionId,
  binding: { ...session.binding },
});
const workspaceInput = (session: Session) => ({
  ...sessionInput(session),
  cwd: "/workspace",
  additionalDirectories: [],
  mcpServers: [],
});
const configInput = (session: Session) => ({
  ...sessionInput(session),
  configId: "mode",
  value: "auto",
  expectedRevision: configurationRevisionToken(session.sessionId, 0),
});
function successorRepositories(f: FencingFixture, owner: Owned) {
  return createOwnedAgentRepositories(f.kernelB, f.secretBox, owner.authority);
}

describe.skipIf(databaseUrl === undefined)(
  "Session writes retain original Agent authority through Application",
  () => {
    for (const action of [
      "create",
      "fork",
      "resume",
      "close",
      "delete",
      "cancel",
      "target",
      "absent-target",
      "configuration",
    ] as const) {
      it(`rejects stale owner ${action} before persistence or supervisor cancellation`, async () => {
        await withDatabase(async (f) => {
          const a = await setup(
            f,
            !["create", "fork", "resume", "configuration"].includes(action),
          );
          const { app, cancel, cancelTarget } = await application(
            a.repositories,
          );
          await f.successor(a.owner);
          const operation = () => {
            switch (action) {
              case "create":
                return app.createSession(workspaceInput(a.session));
              case "fork":
                return app.forkSession(workspaceInput(a.session));
              case "resume":
                return app.resumeSession({
                  ...workspaceInput(a.session),
                  replayFromStart: true,
                });
              case "close":
                return app.closeSession(sessionInput(a.session));
              case "delete":
                return app.deleteSession(sessionInput(a.session));
              case "cancel":
                return app.cancelRun(sessionInput(a.session));
              case "target":
                return app.cancelRun({
                  ...sessionInput(a.session),
                  expectedRunId: a.intent.runId,
                });
              case "absent-target":
                return app.cancelRun({
                  ...sessionInput(a.session),
                  expectedRunId: randomUUID(),
                });
              case "configuration":
                return app.setSessionConfiguration(configInput(a.session));
            }
          };
          await f.denied(operation);
          expect(cancel).not.toHaveBeenCalled();
          expect(cancelTarget).not.toHaveBeenCalled();
        });
      });
    }

    for (const mode of ["successor", "legacy"] as const) {
      for (const action of [
        "close",
        "delete",
        "cancel",
        "target",
        "configuration",
      ] as const) {
        it(`denies ${mode} ${action} over a predecessor active Run atomically`, async () => {
          await withDatabase(async (f) => {
            const a = await setup(f, true);
            const b = await f.successor(a.owner);
            const repositories =
              mode === "successor"
                ? successorRepositories(f, b)
                : createLegacyAgentRepositories(
                    f.kernelA,
                    f.secretBox,
                    new AbortController().signal,
                  );
            const { app, cancel, cancelTarget } =
              await application(repositories);
            await f.denied(() => {
              switch (action) {
                case "close":
                  return app.closeSession(sessionInput(a.session));
                case "delete":
                  return app.deleteSession(sessionInput(a.session));
                case "cancel":
                  return app.cancelRun(sessionInput(a.session));
                case "target":
                  return app.cancelRun({
                    ...sessionInput(a.session),
                    expectedRunId: a.intent.runId,
                  });
                case "configuration":
                  return app.setSessionConfiguration(configInput(a.session));
              }
            });
            expect(cancel).not.toHaveBeenCalled();
            expect(cancelTarget).not.toHaveBeenCalled();
          });
        });
      }
    }

    it("keeps authorized Session identity fixed across awaits and local cancellation", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const other = await f.session(a.session.binding);
        const { app, cancel } = await application(a.repositories);
        const input = sessionInput(a.session);
        const deleting = f.observe(app.deleteSession(input));
        input.sessionId = other.sessionId;
        await deleting;
        expect(
          (await a.repositories.sessions.get(a.session.sessionId))?.state,
        ).toBe("deleted");
        expect(
          (await a.repositories.sessions.get(other.sessionId))?.state,
        ).toBe("active");
        expect(cancel).toHaveBeenCalledExactlyOnceWith(a.session.sessionId);
      });
    });

    it("rechecks actual Session scope after waiting for its row lock", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const { app, cancel } = await application(a.repositories);
        const held = await f.holdSession(a.session.sessionId);
        const outcome = f.observe(
          app.closeSession(sessionInput(a.session)).then(
            () => null,
            (error: unknown) => error,
          ),
        );
        await f.waitForBlockedWriter();
        await held.query(
          "UPDATE acp_sessions SET agent_id='other-agent' WHERE id=$1",
          [a.session.sessionId],
        );
        await f.release(held, true);
        expect(await outcome).toBeInstanceOf(AgentOwnershipLostError);
        const stored = await a.repositories.sessions.get(a.session.sessionId);
        expect(stored).toMatchObject({
          agentId: "other-agent",
          state: "active",
        });
        expect(cancel).not.toHaveBeenCalled();
      });
    });

    it("commits configuration, revision and its event once and preserves typed CAS conflicts", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const { app } = await application(a.repositories);
        await app.setSessionConfiguration(configInput(a.session));
        expect(
          await a.repositories.sessionConfiguration.get(a.session.sessionId),
        ).toMatchObject({ revision: 1 });
        const output = await a.repositories.sessions.readOutput(
          a.session.sessionId,
          0,
        );
        expect(output.sequence).toBe(1);
        expect(output.events).toHaveLength(1);
        expect(output.events[0]).toMatchObject({ kind: "configuration" });
        const committed = await f.snapshot();
        await expect(
          app.setSessionConfiguration(configInput(a.session)),
        ).rejects.toMatchObject({ code: "configuration_conflict" });
        expect(await f.snapshot()).toBe(committed);
      });
    });

    it("valid owner cancellation persists and waits for the original supervised task to settle", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f, true);
        const execution = Promise.withResolvers<ExecuteRunResult>();
        const started = Promise.withResolvers<AbortSignal>();
        const supervisor = new RunSupervisor({
          execute: ({ signal }) => {
            started.resolve(signal);
            return execution.promise;
          },
        });
        const { app } = await application(a.repositories, supervisor);
        const submitted = await supervisor.submit(
          { ...sessionInput(a.session), outputChanged: () => undefined },
          () =>
            Promise.resolve({
              runId: a.intent.runId,
              requestId: a.intent.requestId,
              sessionId: a.session.sessionId,
              userMessageId: a.intent.userMessageId,
              snapshot: a.acceptance.snapshot,
              outputSequence: 1,
            }),
        );
        let cancelling: Promise<void> | undefined;
        try {
          const signal = await started.promise;
          let settled = false;
          cancelling = f.observe(
            app.cancelRun(sessionInput(a.session)).then(() => {
              settled = true;
            }),
          );
          await expect.poll(() => signal.aborted).toBe(true);
          expect(settled).toBe(false);
          expect(supervisor.occupancy(a.session.binding).busy).toBe(true);
          expect(
            (
              await f.observer.query<{ cancel_requested_at: Date | null }>(
                "SELECT cancel_requested_at FROM runs WHERE id=$1",
                [a.intent.runId],
              )
            ).rows[0]?.cancel_requested_at,
          ).toBeInstanceOf(Date);
        } finally {
          execution.resolve({
            terminalClass: "cancelled",
            executorState: "quiescent",
            toolEffectState: "none",
          });
          await submitted.completion;
          await cancelling;
          await supervisor.shutdown();
        }
        expect(supervisor.occupancy(a.session.binding).busy).toBe(false);
      });
    });

    it("rejects a missing Session inserted after the locking lookup without updating its foreign scope", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const { app } = await application(a.repositories);
        const view = await app.getSessionConfiguration(sessionInput(a.session));
        const missing = randomUUID();
        let inserted = false;
        // Both lookup and concurrent insert are real SQL. Pause only at the exact
        // statement boundary, before READ COMMITTED obtains its next snapshot.
        const pool = new Proxy(f.a, {
          get(target, property) {
            if (property !== "connect")
              return Reflect.get(target, property, target) as unknown;
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(connection, key) {
                  if (key !== "query")
                    return Reflect.get(connection, key, connection) as unknown;
                  return (async (sql: string, values?: unknown[]) => {
                    const result = await connection.query(sql, values);
                    if (
                      sql ===
                        "SELECT id, organization_id, agent_id FROM acp_sessions WHERE id=$1 FOR UPDATE" &&
                      values?.[0] === missing
                    ) {
                      expect(result.rows).toHaveLength(0);
                      await createLegacyAgentRepositories(
                        f.kernelB,
                        f.secretBox,
                        new AbortController().signal,
                      ).sessions.create({
                        sessionId: missing,
                        binding: {
                          ...a.session.binding,
                          agentId: "foreign-agent",
                        },
                        cwd: "/workspace",
                        mcpRevisionId: randomUUID(),
                        mcpSources: [],
                      });
                      inserted = true;
                    }
                    return result;
                  }) as PoolClient["query"];
                },
              });
            };
          },
        });
        const repositories = createOwnedAgentRepositories(
          new PostgresKernel(pool),
          f.secretBox,
          a.owner.authority,
        );
        await expect(
          repositories.sessionConfiguration.save({
            sessionId: missing,
            expectedRevision: 0,
            configuration: {},
            view,
            changedAt: new Date(),
          }),
        ).rejects.toMatchObject({ code: "configuration_conflict" });
        expect(inserted).toBe(true);
        expect(
          (
            await f.observer.query(
              "SELECT agent_id, configuration_revision::text, last_message_sequence::text FROM acp_sessions WHERE id=$1",
              [missing],
            )
          ).rows,
        ).toEqual([
          {
            agent_id: "foreign-agent",
            configuration_revision: "0",
            last_message_sequence: "0",
          },
        ]);
        expect(
          (
            await f.observer.query(
              "SELECT id FROM session_messages WHERE session_id=$1",
              [missing],
            )
          ).rowCount,
        ).toBe(0);
      });
    });

    it("validates predecessor terminal targets but leaves a missing target and the newer Run unchanged", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f, true);
        await a.repositories.executions.finish({
          runId: a.intent.runId,
          terminalClass: "completed",
          executorState: "quiescent",
          toolEffectState: "none",
          stopReason: "end_turn",
          finishedAt: new Date(),
        });
        const b = await f.successor(a.owner);
        const repositories = successorRepositories(f, b);
        const next = f.input(a.session);
        await repositories.runs.createRunIntent(next);
        await repositories.runs.acceptRun(f.acceptance(a.session, next.runId));
        const { app, cancel, cancelTarget } = await application(repositories);
        await f.denied(() =>
          app.cancelRun({
            ...sessionInput(a.session),
            expectedRunId: a.intent.runId,
          }),
        );
        const before = await f.snapshot();
        await app.cancelRun({
          ...sessionInput(a.session),
          expectedRunId: randomUUID(),
        });
        expect(await f.snapshot()).toBe(before);
        expect(cancel).not.toHaveBeenCalled();
        expect(cancelTarget).not.toHaveBeenCalled();
      });
    });

    for (const exists of [true, false]) {
      it(`fences idempotent delete when Session ${exists ? "is already deleted" : "does not exist"}`, async () => {
        await withDatabase(async (f) => {
          const a = await setup(f);
          const original = await application(a.repositories);
          if (exists) await original.app.deleteSession(sessionInput(a.session));
          const input = {
            ...sessionInput(a.session),
            sessionId: exists ? a.session.sessionId : randomUUID(),
          };
          original.cancel.mockClear();
          const b = await f.successor(a.owner);
          await f.denied(() => original.app.deleteSession(input));
          expect(original.cancel).not.toHaveBeenCalled();
          const current = await application(successorRepositories(f, b));
          const before = await f.snapshot();
          await current.app.deleteSession(input);
          expect(await f.snapshot()).toBe(before);
          expect(current.cancel).toHaveBeenCalledWith(input.sessionId);
        });
      });
    }
  },
);
