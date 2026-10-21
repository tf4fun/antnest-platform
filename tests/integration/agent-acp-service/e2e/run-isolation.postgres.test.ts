import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startAgentAcpService,
  type RunningAgentAcpService,
} from "../../../../services/agent-acp-service/src/composition.js";
import { loadConfig } from "../../../../services/agent-acp-service/src/config.js";
import { OpenAICompatibleModel } from "../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { OfficialMcpDialer } from "../../../../services/agent-acp-service/src/adapters/mcp/official-client.js";
import type { McpConnection } from "../../../../services/agent-acp-service/src/adapters/mcp/tool-catalog.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import {
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { runtimeInformation } from "../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
import {
  testAuthentication,
  testSecurityEnvironment,
  testHeaders,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { AcpWireClient, type WireFrame } from "../support/acp-wire-client.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const requestBudgetMs = 12_000;

type RunLabel = "a" | "b";
type StoredOutcome = {
  state: string;
  terminal_class: string | null;
  executor_state: string | null;
  tool_effect_state: string | null;
  unknown_effect_source: string | null;
  stop_reason: string | null;
  error_class: string | null;
};

afterEach(() => vi.restoreAllMocks());

describe.skipIf(databaseUrl === undefined)(
  "production ACP Run isolation",
  () => {
    it("v2 contains one Run's usage failure while another Agent completes", async () => {
      expect(new URL(databaseUrl!).pathname).toMatch(/_test$/u);
      const pool = new Pool({
        connectionString: databaseUrl,
        max: 4,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        query_timeout: 5000,
      });
      const clients: AcpWireClient[] = [];
      const requests: Promise<WireFrame>[] = [];
      const connections = new Set<McpConnection>();
      const releaseA = Promise.withResolvers<void>();
      const aFinalEntered = Promise.withResolvers<void>();
      const releaseB = Promise.withResolvers<void>();
      const bToolEntered = Promise.withResolvers<void>();
      const rejectedWrite = Promise.withResolvers<void>();
      let rejectedTransactions = 0;
      const counts = { a: { model: 0, tool: 0 }, b: { model: 0, tool: 0 } };
      const ownershipLost = vi.fn();
      const log = vi.fn<typeof NOOP_TELEMETRY.log>();
      const count = vi.fn<typeof NOOP_TELEMETRY.count>((name, attributes) => {
        if (
          name === "antnest.acp.repository.requests" &&
          attributes.operation === "transaction" &&
          attributes.result === "error"
        ) {
          rejectedTransactions++;
          if (rejectedTransactions === 3) rejectedWrite.resolve();
        }
      });
      let service: RunningAgentAcpService | undefined;
      let serviceFailure: Error | undefined;
      let bSignal: AbortSignal | undefined;
      let bCancelled = false;
      let faultInstalled = false;
      let closing = false;
      const errors: unknown[] = [];

      function origin(control = false): string {
        const address = control
          ? service?.controlAddress()
          : service?.address();
        if (!address || typeof address === "string")
          throw new Error("ACP did not listen");
        return `http://127.0.0.1:${address.port}`;
      }

      function request(
        client: AcpWireClient,
        method: string,
        params: Record<string, unknown>,
      ): Promise<WireFrame> {
        const pending = client.request(method, params);
        requests.push(pending);
        void pending.catch(() => undefined);
        return within(pending, method, requestBudgetMs);
      }

      async function connect(agentId: string): Promise<AcpWireClient> {
        const pending = AcpWireClient.connect(
          origin().replace("http:", "ws:") + "/v2/acp",
          { ...executionIdentity(), agentId },
        ).then(async (client) => {
          clients.push(client);
          if (closing) await client.close();
          return client;
        });
        const client = await within(pending, `connect ${agentId}`, 5000);
        await within(
          client.initialize(2),
          `initialize ${agentId}`,
          requestBudgetMs,
        );
        return client;
      }

      async function outcome(runId: string): Promise<StoredOutcome> {
        const result = await pool.query<StoredOutcome>(
          `SELECT state, terminal_class, executor_state, tool_effect_state,
                unknown_effect_source, stop_reason, error_class
           FROM runs WHERE id = $1`,
          [runId],
        );
        expect(result.rows).toHaveLength(1);
        return result.rows[0]!;
      }

      async function healthy(): Promise<void> {
        const response = await fetch(origin() + "/status", {
          signal: AbortSignal.timeout(5000),
        });
        await response.text();
        expect(serviceFailure).toBeUndefined();
        expect(response.status).toBe(200);
      }

      try {
        await pool.query("DROP SCHEMA public CASCADE");
        await pool.query("CREATE SCHEMA public");

        // Only outbound Runtime/model boundaries are fake. Service composition,
        // worker ownership, persistence and recovery run through production code.
        vi.spyOn(OfficialMcpDialer.prototype, "connect").mockImplementation(
          (input) => {
            input.signal.throwIfAborted();
            const executionId = input.runtimeBinding?.executionId;
            const label = runLabel(executionId);
            const { executionId: _fixtureExecutionId, ...information } =
              runtimeInformation();
            void _fixtureExecutionId;
            const connection: McpConnection = {
              readResource: (_uri, signal) => {
                signal.throwIfAborted();
                return Promise.resolve({
                  contents: [
                    {
                      uri: "antnest://runtime/info",
                      mimeType: "application/json",
                      text: JSON.stringify({
                        ...information,
                        execution_id: executionId,
                        instructions: null,
                        skills: [],
                      }),
                    },
                  ],
                });
              },
              listTools: (signal) => {
                signal.throwIfAborted();
                return Promise.resolve([
                  {
                    name: "read",
                    description: "Read",
                    inputSchema: { type: "object" },
                  },
                ]);
              },
              callTool: async (call, signal) => {
                signal.throwIfAborted();
                expect(call).toEqual({
                  name: "read",
                  arguments: { path: `${label}.txt` },
                });
                counts[label].tool++;
                if (label === "b") {
                  bSignal = signal;
                  const cancelled = () => {
                    bCancelled = true;
                  };
                  signal.addEventListener("abort", cancelled, { once: true });
                  bToolEntered.resolve();
                  try {
                    await waitForGate(
                      releaseB.promise,
                      signal,
                      "B tool",
                      30_000,
                    );
                  } finally {
                    signal.removeEventListener("abort", cancelled);
                  }
                }
                signal.throwIfAborted();
                return {
                  content: [{ type: "text", text: `${label} tool result` }],
                  isError: false,
                  structuredContent: {
                    effect_state: "settled",
                    effect_source: null,
                  },
                };
              },
              close: () => {
                connections.delete(connection);
                return Promise.resolve();
              },
            };
            connections.add(connection);
            return Promise.resolve(connection);
          },
        );
        vi.spyOn(
          OpenAICompatibleModel.prototype,
          "complete",
        ).mockImplementation(async (input) => {
          input.signal.throwIfAborted();
          const label = runLabel(input.snapshot.runtime.executionId);
          const attempt = ++counts[label].model;
          if (attempt === 1) {
            return {
              kind: "tool_calls",
              content: [],
              calls: [
                {
                  id: `${label}-call`,
                  name: "read",
                  arguments: { path: `${label}.txt` },
                },
              ],
              usage: { inputTokens: 4, outputTokens: 2 },
            };
          }
          expect(attempt).toBe(2);
          if (label === "a") {
            aFinalEntered.resolve();
            await waitForGate(
              releaseA.promise,
              input.signal,
              "A final model result",
              30_000,
            );
          }
          input.signal.throwIfAborted();
          return {
            kind: "message",
            content: [{ type: "text", text: `${label} complete` }],
            stopReason: "end_turn",
            usage: { inputTokens: 8, outputTokens: 3 },
          };
        });

        const config = {
          ...loadConfig({
            ...testSecurityEnvironment(),
            ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
              process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS ?? "false",
            ANTNEST_ACP_DATABASE_URL: databaseUrl!,
            ANTNEST_ACP_CLIENT_MCP_KEY: randomBytes(32).toString("base64"),
          }),
          listen: { host: "127.0.0.1", port: 0 },
          controlListen: { host: "127.0.0.1", port: 0 },
          databaseTimeoutMs: 5000,
          runTimeoutMs: 60_000,
          authentication: testAuthentication(),
        };
        service = await startAgentAcpService(
          config,
          { ...NOOP_TELEMETRY, log, count },
          ownershipLost,
        );
        const originalService = service;
        const originalAddress = origin();
        void service.failure.then((error) => {
          serviceFailure = error;
        });

        await pool.query(`
        CREATE TABLE run_isolation_usage_fault (run_id text PRIMARY KEY);
        CREATE SEQUENCE run_isolation_usage_fault_hits;
        CREATE FUNCTION reject_run_isolation_usage() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'usage' AND EXISTS (
            SELECT 1 FROM run_isolation_usage_fault WHERE run_id = NEW.run_id
          ) THEN
            -- nextval survives the rejected transaction's rollback.
            PERFORM nextval('run_isolation_usage_fault_hits');
            RAISE EXCEPTION 'controlled Run usage persistence failure'
              USING ERRCODE = 'P0050';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER reject_run_isolation_usage
          BEFORE INSERT ON session_messages FOR EACH ROW
          EXECUTE FUNCTION reject_run_isolation_usage();
        CREATE SEQUENCE run_isolation_terminal_fault_hits;
        CREATE FUNCTION reject_run_isolation_terminal() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state NOT IN ('admitting', 'running') AND EXISTS (
            SELECT 1 FROM run_isolation_usage_fault WHERE run_id = NEW.id
          ) THEN
            PERFORM nextval('run_isolation_terminal_fault_hits');
            RAISE EXCEPTION 'controlled Run terminal persistence failure'
              USING ERRCODE = 'P0051';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER reject_run_isolation_terminal
          BEFORE UPDATE ON runs FOR EACH ROW
          EXECUTE FUNCTION reject_run_isolation_terminal();
      `);
        faultInstalled = true;

        const configuration = executionConfiguration();
        const agentA = configuration.agents[0]!;
        agentA.default_authorization.mode = "auto";
        configuration.agents.push({
          ...structuredClone(agentA),
          agent_id: "agent-2",
          runtime: runtimeConfiguration(2),
        });
        const applied = await fetch(
          origin(true) + "/rpc/agent-acp/apply-execution-snapshot",
          {
            method: "POST",
            headers: {
              ...workloadHeaders("agent-controller"),
              "content-type": "application/json",
            },
            body: JSON.stringify(configuration),
            signal: AbortSignal.timeout(5000),
          },
        );
        expect(await applied.json()).toMatchObject({ applied_revision: 1 });
        expect(applied.status).toBe(200);

        const clientA = await connect("agent-1");
        const clientB = await connect("agent-2");
        const sessions: Record<RunLabel, string> = { a: "", b: "" };
        for (const [label, client] of [
          ["a", clientA],
          ["b", clientB],
        ] as const) {
          const created = await request(client, "session/new", {
            cwd: "/workspace",
            mcpServers: [],
          });
          expect(created.error).toBeUndefined();
          expect(typeof created.result?.sessionId).toBe("string");
          sessions[label] = created.result!.sessionId as string;
        }
        const pendingB = request(clientB, "session/prompt", {
          sessionId: sessions.b,
          prompt: [{ type: "text", text: "run-b" }],
        });
        void pendingB.catch(() => undefined);
        await within(bToolEntered.promise, "B entered its tool", 5000);
        const pendingA = request(clientA, "session/prompt", {
          sessionId: sessions.a,
          prompt: [{ type: "text", text: "run-a" }],
        });
        void pendingA.catch(() => undefined);
        await within(aFinalEntered.promise, "A completed its tool", 5000);

        const savedRuns = await pool.query<{ id: string; session_id: string }>(
          "SELECT id, session_id FROM runs WHERE session_id = ANY($1::text[])",
          [[sessions.a, sessions.b]],
        );
        expect(savedRuns.rows).toHaveLength(2);
        const runA = savedRuns.rows.find(
          (run) => run.session_id === sessions.a,
        )!.id;
        const runB = savedRuns.rows.find(
          (run) => run.session_id === sessions.b,
        )!.id;
        const toolEvidence = async (runId: string) =>
          (
            await pool.query<{
              state: string;
              tool_effect_state: string;
              runtime_call_stopped: boolean;
            }>(
              `SELECT state, tool_effect_state, runtime_call_stopped
           FROM tool_attempts WHERE run_id = $1`,
              [runId],
            )
          ).rows;
        expect(await toolEvidence(runA)).toEqual([
          {
            state: "completed",
            tool_effect_state: "settled",
            runtime_call_stopped: true,
          },
        ]);
        expect(await toolEvidence(runB)).toEqual([
          {
            state: "in_progress",
            tool_effect_state: "none",
            runtime_call_stopped: false,
          },
        ]);
        expect(counts).toEqual({
          a: { model: 2, tool: 1 },
          b: { model: 1, tool: 1 },
        });

        await pool.query(
          "INSERT INTO run_isolation_usage_fault(run_id) VALUES ($1)",
          [runA],
        );
        releaseA.resolve();
        await expect
          .poll(
            async () => {
              const hits = await pool.query<{
                is_called: boolean;
                last_value: string;
              }>(
                "SELECT is_called, last_value FROM run_isolation_usage_fault_hits",
              );
              return hits.rows[0]!.is_called
                ? Number(hits.rows[0]!.last_value)
                : 0;
            },
            { timeout: 5000 },
          )
          .toBeGreaterThanOrEqual(3);
        await within(
          rejectedWrite.promise,
          "A exhausted all three usage write attempts",
          5000,
        );
        // Let the real rejected write propagate through the executor before
        // asserting containment. No recovery callback is stubbed by this test.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await healthy();
        await expect
          .poll(
            async () =>
              (
                await pool.query<{ is_called: boolean }>(
                  "SELECT is_called FROM run_isolation_terminal_fault_hits",
                )
              ).rows[0]?.is_called,
            { timeout: 5000 },
          )
          .toBe(true);
        expect((await outcome(runA)).state).toBe("running");
        const recovering = await fetch(
          origin() + "/rpc/agent-acp/get-agent-execution-state",
          {
            method: "POST",
            headers: {
              ...testHeaders({ "X-Antnest-Agent-ID": "agent-1" }),
              "content-type": "application/json",
            },
            body: "{}",
            signal: AbortSignal.timeout(5000),
          },
        );
        expect(recovering.status).toBe(200);
        expect(await recovering.json()).toMatchObject({
          availability: "busy",
          active_session_id: sessions.a,
        });
        const refused = await request(clientA, "session/prompt", {
          sessionId: sessions.a,
          prompt: [{ type: "text", text: "must stay isolated" }],
        });
        expect(refused.error).toMatchObject({ data: { code: "agent_busy" } });
        expect(bCancelled).toBe(false);
        expect(bSignal).toBeDefined();
        expect(bSignal!.aborted).toBe(false);
        expect((await outcome(runB)).state).toBe("running");
        expect(await toolEvidence(runB)).toEqual([
          {
            state: "in_progress",
            tool_effect_state: "none",
            runtime_call_stopped: false,
          },
        ]);

        releaseB.resolve();
        expect((await pendingB).error).toBeUndefined();
        await expect
          .poll(async () => (await outcome(runB)).state, { timeout: 10_000 })
          .toBe("completed");
        const completedB = await outcome(runB);
        expect(completedB).toEqual({
          state: "completed",
          terminal_class: "completed",
          executor_state: "quiescent",
          tool_effect_state: "settled",
          unknown_effect_source: null,
          stop_reason: "end_turn",
          error_class: null,
        });
        expect((await outcome(runA)).state).toBe("running");

        await pool.query(
          "DELETE FROM run_isolation_usage_fault WHERE run_id = $1",
          [runA],
        );
        await expect
          .poll(async () => (await outcome(runA)).state, { timeout: 20_000 })
          .toBe("failed");
        const recoveredA = await outcome(runA);
        expect(recoveredA.terminal_class).toBe(recoveredA.state);
        expect(recoveredA.executor_state).toBe("quiescent");
        expect(recoveredA.tool_effect_state).toBe("settled");
        expect(recoveredA.unknown_effect_source).toBeNull();
        expect(recoveredA.stop_reason).toBeNull();
        expect(recoveredA.error_class).toBe("persistence_interrupted");
        await pendingA;
        expect(await toolEvidence(runA)).toEqual([
          {
            state: "completed",
            tool_effect_state: "settled",
            runtime_call_stopped: true,
          },
        ]);
        expect(await outcome(runB)).toEqual(completedB);
        expect(counts).toEqual({
          a: { model: 2, tool: 1 },
          b: { model: 2, tool: 1 },
        });

        for (const [sessionId, client] of [
          [sessions.a, clientA],
          [sessions.b, clientB],
        ] as const) {
          const replay = await request(client, "session/resume", {
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
            replayFrom: { type: "start" },
          });
          expect(replay.error).toBeUndefined();
        }
        expect(counts).toEqual({
          a: { model: 2, tool: 1 },
          b: { model: 2, tool: 1 },
        });
        expect(
          (await pool.query("SELECT id FROM runs ORDER BY id")).rows,
        ).toEqual([runA, runB].sort().map((id) => ({ id })));
        expect(bCancelled).toBe(false);
        expect(ownershipLost).not.toHaveBeenCalled();
        expect(
          log.mock.calls.filter(([, event]) => event === "service_started"),
        ).toHaveLength(1);
        expect(service).toBe(originalService);
        expect(origin()).toBe(originalAddress);
        await healthy();
      } catch (error) {
        errors.push(error);
      } finally {
        closing = true;
        releaseA.resolve();
        releaseB.resolve();
        const cleanup = async (
          label: string,
          operation: () => Promise<unknown>,
        ) => {
          try {
            await within(operation(), label, requestBudgetMs);
          } catch (error) {
            errors.push(error);
          }
        };
        if (faultInstalled)
          await cleanup("clear usage fault", () =>
            pool.query("DELETE FROM run_isolation_usage_fault"),
          );
        await cleanup("close ACP clients", async () => {
          const closed = await Promise.allSettled(
            clients.map((client) => client.close()),
          );
          for (const result of closed)
            if (result.status === "rejected") errors.push(result.reason);
        });
        await cleanup("join ACP requests", async () => {
          const joined = await Promise.allSettled(requests);
          for (const result of joined)
            if (result.status === "rejected") errors.push(result.reason);
        });
        await cleanup(
          "shutdown ACP",
          () => service?.shutdown() ?? Promise.resolve(),
        );
        if (connections.size !== 0)
          errors.push(new Error("Runtime connections leaked"));
        if (faultInstalled)
          await cleanup("remove usage fault fixture", () =>
            pool.query(`
        DROP TRIGGER reject_run_isolation_usage ON session_messages;
        DROP FUNCTION reject_run_isolation_usage();
        DROP TRIGGER reject_run_isolation_terminal ON runs;
        DROP FUNCTION reject_run_isolation_terminal();
        DROP TABLE run_isolation_usage_fault;
        DROP SEQUENCE run_isolation_usage_fault_hits;
        DROP SEQUENCE run_isolation_terminal_fault_hits;
      `),
          );
        await cleanup("close PostgreSQL pool", () => pool.end());
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Run isolation component or cleanup failed",
        );
    }, 90_000);
  },
);

function runLabel(executionId: string | undefined): RunLabel {
  if (executionId === "runtime-execution-1") return "a";
  if (executionId === "runtime-execution-2") return "b";
  throw new Error(`Unexpected Runtime execution ${executionId}`);
}

async function within<T>(
  pending: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function waitForGate(
  gate: Promise<void>,
  signal: AbortSignal,
  label: string,
  timeoutMs: number,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      if (error === undefined) resolve();
      else
        reject(
          error instanceof Error
            ? error
            : new Error(`${label} failed`, { cause: error }),
        );
    };
    const cancelled = () => finish(signal.reason);
    const timer = setTimeout(
      () => finish(new Error(`Timed out: ${label}`)),
      timeoutMs,
    );
    signal.addEventListener("abort", cancelled, { once: true });
    void gate.then(() => finish(), finish);
    if (signal.aborted) cancelled();
  });
}
