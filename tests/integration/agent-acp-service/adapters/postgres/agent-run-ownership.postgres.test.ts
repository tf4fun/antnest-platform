import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import type { PostgresRunRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { createLegacyRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { PostgresExecutionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-repository.js";
import { publicExecutionConfiguration } from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { runSnapshot } from "../../../../../services/agent-acp-service/src/domain/run-snapshot.js";
import type { ConnectionBinding } from "../../../../../services/agent-acp-service/src/domain/types.js";
import type { CreateRunIntentInput } from "../../../../../services/agent-acp-service/src/ports/run-repository.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import type { Command, Reply } from "../../support/run-intent-child.fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const IPC_TIMEOUT_MS = 10_000;
const servicePackage = new URL(
  "../../../../../services/agent-acp-service/package.json",
  import.meta.url,
);
const childFile = new URL(
  "../../support/run-intent-child.fixture.ts",
  import.meta.url,
);
type Ready = Extract<Reply, { kind: "ready" }>;
type IntentResult = Extract<Reply, { kind: "result" }>;
type Stopped = Extract<Reply, { kind: "stopped" }>;
type Closed = { code: number | null; signal: NodeJS.Signals | null };
type OwnedSession = {
  sessionId: string;
  mcpRevisionId: string;
  binding: ConnectionBinding;
};

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class IntentChild {
  private readonly child: ChildProcess;
  private readonly ready = Promise.withResolvers<Ready>();
  private readonly stopped = Promise.withResolvers<Stopped>();
  private readonly closed = Promise.withResolvers<Closed>();
  private readonly pending = new Map<
    string,
    PromiseWithResolvers<IntentResult>
  >();
  private readonly observed = new Set<Promise<unknown>>();
  private closeResult: Closed | undefined;
  private stopReceipt: Stopped | undefined;
  private failure: Error | undefined;
  private stopping: Promise<void> | undefined;
  // Keep stderr private and bounded. Neither it nor the start command is printed
  // or attached to an assertion/error, because either may contain a database URL.
  private stderr = "";

  public constructor(public readonly applicationName: string) {
    const loader = createRequire(servicePackage).resolve("tsx");
    this.child = fork(fileURLToPath(childFile), [], {
      cwd: fileURLToPath(new URL(".", servicePackage)),
      execArgv: ["--import", loader],
      // Service typecheck aliases point at declaration files, not runtime code.
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL(
            "../../support/run-intent-child.tsconfig.json",
            import.meta.url,
          ),
        ),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "json",
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8192);
    });
    this.child.on("message", (value: unknown) => this.receive(value));
    this.child.on("error", () => this.fail("Run intent child process failed"));
    this.child.once("close", (code, signal) => {
      this.closeResult = { code, signal };
      const failure = new Error(
        "Run intent child closed before its IPC request completed",
      );
      this.ready.reject(failure);
      this.stopped.reject(failure);
      for (const request of this.pending.values()) request.reject(failure);
      this.pending.clear();
      this.closed.resolve(this.closeResult);
    });
    void this.observe(this.ready.promise);
    void this.observe(this.stopped.promise);
  }

  private observe<T>(operation: Promise<T>): Promise<T> {
    this.observed.add(operation);
    void operation.catch(() => undefined);
    return operation;
  }

  private fail(message: string): void {
    this.failure ??= new Error(
      message + (this.stderr.length > 0 ? " (stderr captured privately)" : ""),
    );
    this.ready.reject(this.failure);
    this.stopped.reject(this.failure);
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
  }

  private receive(value: unknown): void {
    if (typeof value !== "object" || value === null || !("kind" in value)) {
      this.fail("Invalid Run intent child IPC reply");
      return;
    }
    const reply = value as Reply;
    switch (reply.kind) {
      case "ready":
        this.ready.resolve(reply);
        break;
      case "result": {
        const request = this.pending.get(reply.commandId);
        if (request === undefined) {
          this.fail("Unexpected Run intent child command receipt");
          return;
        }
        this.pending.delete(reply.commandId);
        request.resolve(reply);
        break;
      }
      case "stopped":
        this.stopReceipt = reply;
        this.stopped.resolve(reply);
        break;
      case "fixture-error":
        this.fail("Run intent child reported a fixture error");
        break;
      default:
        this.fail("Unknown Run intent child IPC reply");
    }
  }

  private send(command: Command): Promise<void> {
    return this.observe(
      new Promise<void>((resolve, reject) => {
        if (!this.child.connected) {
          reject(new Error("Run intent child IPC is disconnected"));
          return;
        }
        try {
          this.child.send(command, (error) => {
            if (error)
              reject(new Error("Run intent child IPC delivery failed"));
            else resolve();
          });
        } catch {
          reject(new Error("Run intent child IPC delivery failed"));
        }
      }),
    );
  }

  public start(url: string): Promise<Ready> {
    return this.observe(
      bounded(
        Promise.all([
          this.send({
            kind: "start",
            databaseUrl: url,
            applicationName: this.applicationName,
          }),
          this.ready.promise,
        ]).then(([, ready]) => {
          expect(ready.pid).toBe(this.child.pid);
          expect(ready.pid).not.toBe(process.pid);
          expect(
            Number.isSafeInteger(ready.backendPid) && ready.backendPid > 0,
          ).toBe(true);
          return ready;
        }),
        IPC_TIMEOUT_MS,
        "Run intent child startup exceeded its deadline",
      ),
    );
  }

  public intent(input: CreateRunIntentInput): Promise<IntentResult> {
    if (this.failure !== undefined)
      return this.observe(Promise.reject(this.failure));
    const commandId = randomUUID();
    const request = Promise.withResolvers<IntentResult>();
    this.pending.set(commandId, request);
    void this.observe(request.promise);
    return this.observe(
      bounded(
        Promise.all([
          this.send({
            kind: "intent",
            commandId,
            input: { ...input, createdAt: input.createdAt.toISOString() },
          }),
          request.promise,
        ]).then(([, reply]) => reply),
        IPC_TIMEOUT_MS,
        "Run intent child command exceeded its deadline",
      ),
    );
  }

  public stop(): Promise<void> {
    return (this.stopping ??= this.stopOnce());
  }

  private async stopOnce(): Promise<void> {
    const failures: unknown[] = [];
    try {
      if (this.closeResult === undefined) {
        await bounded(
          Promise.all([this.send({ kind: "stop" }), this.stopped.promise]),
          IPC_TIMEOUT_MS,
          "Run intent child stop receipt exceeded its deadline",
        );
      }
      const closed = await bounded(
        this.closed.promise,
        IPC_TIMEOUT_MS,
        "Run intent child did not close its process and stdio",
      );
      if (
        closed.code !== 0 ||
        closed.signal !== null ||
        this.stopReceipt?.pending !== 0 ||
        this.stopReceipt.pid !== this.child.pid
      )
        throw new Error(
          "Run intent child did not stop cleanly with zero pending work",
        );
      if (this.failure !== undefined) throw this.failure;
    } catch (error) {
      failures.push(error);
      if (this.closeResult === undefined) {
        failures.push(
          new Error("Run intent child required forced termination"),
        );
        this.child.kill("SIGTERM");
        try {
          await bounded(
            this.closed.promise,
            1_500,
            "Run intent child ignored TERM",
          );
        } catch {
          this.child.kill("SIGKILL");
          try {
            await bounded(
              this.closed.promise,
              3_000,
              "Run intent child did not close after KILL",
            );
          } catch (failure) {
            failures.push(failure);
          }
        }
      }
    } finally {
      // A timeout only stops waiting for evidence; real process close rejects any
      // outstanding IPC receipts. Join those actual requests after close too.
      try {
        await bounded(
          Promise.allSettled([...this.observed]),
          3_000,
          "Run intent child IPC requests did not join",
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Run intent child cleanup failed");
  }
}

async function withDatabase(
  work: (fixture: {
    pool: Pool;
    runs: PostgresRunRepository;
    executions: PostgresExecutionRepository;
    createSession: (
      organizationId?: string,
      agentId?: string,
      principalId?: string,
    ) => Promise<OwnedSession>;
    input: (session: OwnedSession) => CreateRunIntentInput;
    children: () => Promise<{
      peers: [IntentChild, IntentChild];
      ready: [Ready, Ready];
    }>;
    state: () => Promise<{
      runs: Array<{
        id: string;
        session_id: string;
        state: string;
        cancellation_requested: boolean;
      }>;
      sessions: Array<{
        id: string;
        append_version: string;
        last_message_sequence: string;
      }>;
      messages: Array<{
        id: string;
        session_id: string;
        run_id: string | null;
        visible: boolean;
      }>;
    }>;
  }) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined)
    throw new Error("PostgreSQL test database is not configured");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    application_name: `acp-run-owner-parent-${randomUUID()}`,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
  });
  const kernel = new PostgresKernel(pool);
  const sessions = new PostgresSessionRepository(
    kernel,
    new SecretBox(randomBytes(32)),
  );
  const runs = createLegacyRunRepositories(
    kernel,
    new AbortController().signal,
  ).runs;
  const executions = new PostgresExecutionRepository(kernel);
  const children: IntentChild[] = [];
  const sessionIds: string[] = [];
  const knownRunIds = new Set<string>();
  const failures: unknown[] = [];
  try {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    await work({
      pool,
      runs,
      executions,
      async createSession(
        organizationId = "organization-1",
        agentId = "agent-1",
        principalId = "principal-1",
      ) {
        const session = {
          sessionId: randomUUID(),
          mcpRevisionId: randomUUID(),
          binding: {
            connectionId: randomUUID(),
            organizationId,
            agentId,
            principalId,
          },
        };
        sessionIds.push(session.sessionId);
        await sessions.create({
          ...session,
          cwd: "/workspace",
          mcpSources: [],
        });
        return session;
      },
      input(session) {
        const input: CreateRunIntentInput = {
          runId: randomUUID(),
          requestId: randomUUID(),
          sessionId: session.sessionId,
          expectedAccessRevision: "access-1",
          userMessageId: randomUUID(),
          prompt: [{ type: "text", text: "Synthetic two-process admission" }],
          createdAt: new Date(),
        };
        knownRunIds.add(input.runId);
        return input;
      },
      async children() {
        const first = new IntentChild(`acp-run-owner-first-${randomUUID()}`);
        children.push(first);
        const second = new IntentChild(`acp-run-owner-second-${randomUUID()}`);
        children.push(second);
        const peers: [IntentChild, IntentChild] = [first, second];
        const ready = await Promise.all([
          peers[0].start(databaseUrl),
          peers[1].start(databaseUrl),
        ]);
        expect(ready[0].pid).not.toBe(ready[1].pid);
        expect(ready[0].backendPid).not.toBe(ready[1].backendPid);
        const backends = await pool.query<{
          pid: number;
          application_name: string;
        }>(
          "SELECT pid, application_name FROM pg_stat_activity WHERE pid = ANY($1::int[]) ORDER BY pid",
          [ready.map((entry) => entry.backendPid)],
        );
        expect(backends.rows).toEqual(
          ready
            .map((entry, index) => ({
              pid: entry.backendPid,
              application_name: peers[index]!.applicationName,
            }))
            .sort((left, right) => left.pid - right.pid),
        );
        return { peers, ready };
      },
      async state() {
        const storedRuns = await pool.query<{
          id: string;
          session_id: string;
          state: string;
          cancellation_requested: boolean;
        }>(
          `SELECT id, session_id, state, cancel_requested_at IS NOT NULL AS cancellation_requested
             FROM runs WHERE session_id=ANY($1::text[]) ORDER BY id`,
          [sessionIds],
        );
        const storedSessions = await pool.query<{
          id: string;
          append_version: string;
          last_message_sequence: string;
        }>(
          `SELECT id, append_version::text, last_message_sequence::text
             FROM acp_sessions WHERE id=ANY($1::text[]) ORDER BY id`,
          [sessionIds],
        );
        const messages = await pool.query<{
          id: string;
          session_id: string;
          run_id: string | null;
          visible: boolean;
        }>(
          `SELECT id, session_id, run_id, visible FROM session_messages
            WHERE session_id=ANY($1::text[]) ORDER BY id`,
          [sessionIds],
        );
        return {
          runs: storedRuns.rows,
          sessions: storedSessions.rows,
          messages: messages.rows,
        };
      },
    });
  } catch (error) {
    failures.push(error);
  } finally {
    const stopped = await Promise.allSettled(
      children.map((child) => child.stop()),
    );
    for (const result of stopped)
      if (result.status === "rejected") failures.push(result.reason as unknown);
    // Discover committed work by owned Session as well as every submitted ID:
    // the old implementation can commit both contenders before the first assert.
    try {
      const pending = await pool.query<{ id: string; state: string }>(
        `SELECT id, state FROM runs WHERE (session_id=ANY($1::text[]) OR id=ANY($2::text[]))
           AND state IN ('admitting','running') ORDER BY id`,
        [sessionIds, [...knownRunIds]],
      );
      for (const run of pending.rows) {
        try {
          if (run.state === "admitting")
            await runs.rejectRun(run.id, "test_cleanup", new Date());
          else
            await executions.finish({
              runId: run.id,
              terminalClass: "cancelled",
              executorState: "quiescent",
              toolEffectState: "none",
              finishedAt: new Date(),
            });
        } catch (error) {
          failures.push(error);
        }
      }
      const remaining = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM runs WHERE (session_id=ANY($1::text[]) OR id=ANY($2::text[]))
           AND state IN ('admitting','running')`,
        [sessionIds, [...knownRunIds]],
      );
      expect(remaining.rows).toEqual([{ count: "0" }]);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await pool.end();
        expect(pool.totalCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Run ownership business or cleanup failed",
    );
}

function together(
  peers: [IntentChild, IntentChild],
  inputs: [CreateRunIntentInput, CreateRunIntentInput],
) {
  const go = Promise.withResolvers<void>();
  const requests = [
    go.promise.then(() => peers[0].intent(inputs[0])),
    go.promise.then(() => peers[1].intent(inputs[1])),
  ] as const;
  go.resolve();
  return Promise.all(requests);
}

function expectBusy(result: IntentResult): void {
  expect(result.ok).toBe(false);
  if (result.ok)
    throw new Error(
      "Another Session unexpectedly acquired the Agent reservation",
    );
  expect(result.error).toStrictEqual({
    name: "DomainError",
    code: "agent_busy",
  });
}

function snapshot(session: OwnedSession) {
  const configuration = executionConfiguration();
  configuration.organization_id = session.binding.organizationId;
  configuration.agents[0]!.agent_id = session.binding.agentId;
  configuration.agents[0]!.principal_ids = [session.binding.principalId];
  return runSnapshot({
    configuration: publicExecutionConfiguration(configuration),
    identity: session.binding,
    overrides: {},
    accessRevision: "access-1",
    clientMcpRevisionId: session.mcpRevisionId,
    deadlineAt: new Date(Date.now() + 60_000),
  });
}

describe.skipIf(databaseUrl === undefined)(
  "durable Agent Run ownership across Node processes",
  () => {
    it("retains one reservation through admitting, running, cancellation and owner exit until terminal commit", async () => {
      await withDatabase(async (fixture) => {
        const sessions: [OwnedSession, OwnedSession] = [
          await fixture.createSession(),
          await fixture.createSession(
            "organization-1",
            "agent-1",
            "principal-2",
          ),
        ];
        const { peers, ready } = await fixture.children();
        const inputs: [CreateRunIntentInput, CreateRunIntentInput] = [
          fixture.input(sessions[0]),
          fixture.input(sessions[1]),
        ];
        const results = await together(peers, inputs);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok)).toHaveLength(1);
        const winnerIndex = results[0].ok ? 0 : 1;
        const loserIndex = winnerIndex === 0 ? 1 : 0;
        const winner = results[winnerIndex];
        if (!winner.ok)
          throw new Error("Concurrent admission returned no winning intent");
        expectBusy(results[loserIndex]);
        expect(winner.intent).toMatchObject({
          id: inputs[winnerIndex].runId,
          requestId: inputs[winnerIndex].requestId,
          userMessageId: inputs[winnerIndex].userMessageId,
          sessionId: sessions[winnerIndex].sessionId,
          clientMcpRevisionId: sessions[winnerIndex].mcpRevisionId,
          expectedAccessRevision: "access-1",
          state: "admitting",
          prompt: inputs[winnerIndex].prompt,
        });
        const initial = await fixture.state();
        expect(initial.runs).toEqual([
          {
            id: winner.intent.id,
            session_id: sessions[winnerIndex].sessionId,
            state: "admitting",
            cancellation_requested: false,
          },
        ]);
        expect(
          initial.sessions.find(
            (row) => row.id === sessions[winnerIndex].sessionId,
          ),
        ).toMatchObject({ append_version: "1", last_message_sequence: "0" });
        expect(
          initial.sessions.find(
            (row) => row.id === sessions[loserIndex].sessionId,
          ),
        ).toMatchObject({ append_version: "0", last_message_sequence: "0" });
        expect(initial.messages).toEqual([]);
        expectBusy(
          await peers[loserIndex].intent(fixture.input(sessions[loserIndex])),
        );
        expect(await fixture.state()).toEqual(initial);

        expect(
          await fixture.runs.acceptRun({
            runId: winner.intent.id,
            snapshot: snapshot(sessions[winnerIndex]),
            environmentFact: null,
            acceptedAt: new Date(),
          }),
        ).toBe("accepted");
        expect(await fixture.executions.getState(winner.intent.id)).toBe(
          "running",
        );
        const running = await fixture.state();
        expect(running.runs).toEqual([
          {
            id: winner.intent.id,
            session_id: sessions[winnerIndex].sessionId,
            state: "running",
            cancellation_requested: false,
          },
        ]);
        expectBusy(
          await peers[loserIndex].intent(fixture.input(sessions[loserIndex])),
        );
        expect(await fixture.state()).toEqual(running);
        await fixture.runs.requestCancellation(winner.intent.id, new Date());
        const cancelled = await fixture.state();
        expect(cancelled.runs).toEqual([
          {
            id: winner.intent.id,
            session_id: sessions[winnerIndex].sessionId,
            state: "running",
            cancellation_requested: true,
          },
        ]);
        expect(cancelled.messages).toEqual([
          {
            id: inputs[winnerIndex].userMessageId,
            session_id: sessions[winnerIndex].sessionId,
            run_id: winner.intent.id,
            visible: true,
          },
        ]);
        expectBusy(
          await peers[loserIndex].intent(fixture.input(sessions[loserIndex])),
        );
        expect(await fixture.state()).toEqual(cancelled);

        await peers[winnerIndex].stop();
        await expect
          .poll(
            async () =>
              (
                await fixture.pool.query<{ count: string }>(
                  "SELECT count(*)::text FROM pg_stat_activity WHERE pid=$1 AND application_name=$2",
                  [
                    ready[winnerIndex].backendPid,
                    peers[winnerIndex].applicationName,
                  ],
                )
              ).rows[0]?.count,
            { timeout: 3_000 },
          )
          .toBe("0");
        expect(await fixture.state()).toEqual(cancelled);
        expectBusy(
          await peers[loserIndex].intent(fixture.input(sessions[loserIndex])),
        );
        expect(await fixture.state()).toEqual(cancelled);

        await fixture.executions.finish({
          runId: winner.intent.id,
          terminalClass: "cancelled",
          executorState: "quiescent",
          toolEffectState: "none",
          finishedAt: new Date(),
        });
        expect(
          await fixture.executions.getRecoveryState(winner.intent.id),
        ).toEqual({
          kind: "terminal",
          outcome: {
            terminalClass: "cancelled",
            executorState: "quiescent",
            toolEffectState: "none",
          },
        });
        const nextInput = fixture.input(sessions[loserIndex]);
        const next = await peers[loserIndex].intent(nextInput);
        expect(next.ok).toBe(true);
        if (!next.ok)
          throw new Error(
            "Committed terminal transition did not release Agent admission",
          );
        expect(next.intent).toMatchObject({
          id: nextInput.runId,
          sessionId: nextInput.sessionId,
          state: "admitting",
        });
        const released = await fixture.state();
        expect(
          released.runs.filter((run) =>
            ["admitting", "running"].includes(run.state),
          ),
        ).toEqual([
          {
            id: nextInput.runId,
            session_id: nextInput.sessionId,
            state: "admitting",
            cancellation_requested: false,
          },
        ]);
        expect(released.runs).toHaveLength(2);
        expect(
          released.sessions.find((row) => row.id === nextInput.sessionId),
        ).toMatchObject({ append_version: "1", last_message_sequence: "0" });
        expect(released.messages).toEqual(cancelled.messages);
      });
    }, 60_000);

    it("admits independent Agents and the same Agent identity in another organization through different processes", async () => {
      await withDatabase(async (fixture) => {
        const first = await fixture.createSession(
          "organization-1",
          "agent-shared",
          "principal-1",
        );
        const otherAgent = await fixture.createSession(
          "organization-1",
          "agent-independent",
          "principal-1",
        );
        const otherOrganization = await fixture.createSession(
          "organization-2",
          "agent-shared",
          "principal-1",
        );
        const { peers } = await fixture.children();
        const inputs: [CreateRunIntentInput, CreateRunIntentInput] = [
          fixture.input(first),
          fixture.input(otherAgent),
        ];
        const results = await together(peers, inputs);
        expect(results.map((result) => result.ok)).toEqual([true, true]);
        for (const [index, result] of results.entries()) {
          if (!result.ok)
            throw new Error(
              "An independent Agent was blocked by another Agent reservation",
            );
          expect(result.intent).toMatchObject({
            id: inputs[index]!.runId,
            sessionId: inputs[index]!.sessionId,
            state: "admitting",
          });
        }
        const crossOrgInput = fixture.input(otherOrganization);
        // The first process's same-name Agent remains admitting while the second
        // process requests that Agent string in a different organization.
        const crossOrg = await peers[1].intent(crossOrgInput);
        expect(crossOrg.ok).toBe(true);
        if (!crossOrg.ok)
          throw new Error("Agent admission leaked across organization scope");
        expect(crossOrg.intent).toMatchObject({
          id: crossOrgInput.runId,
          sessionId: otherOrganization.sessionId,
          state: "admitting",
        });
        const current = await fixture.state();
        expect(current.runs.map((run) => run.id).sort()).toEqual(
          [...inputs.map((input) => input.runId), crossOrgInput.runId].sort(),
        );
        expect(
          current.runs.every(
            (run) => run.state === "admitting" && !run.cancellation_requested,
          ),
        ).toBe(true);
        expect(current.sessions).toHaveLength(3);
        expect(
          current.sessions.every(
            (row) =>
              row.append_version === "1" && row.last_message_sequence === "0",
          ),
        ).toBe(true);
        expect(current.messages).toEqual([]);
      });
    }, 60_000);
  },
);
