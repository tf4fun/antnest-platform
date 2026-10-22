import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startAgentAcpService,
  type RunningAgentAcpService,
} from "../../../../services/agent-acp-service/src/composition.js";
import { loadConfig } from "../../../../services/agent-acp-service/src/config.js";
import type { ExecutionConfiguration } from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { OpenAICompatibleModel } from "../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { OfficialMcpDialer } from "../../../../services/agent-acp-service/src/adapters/mcp/official-client.js";
import type { McpConnection } from "../../../../services/agent-acp-service/src/adapters/mcp/tool-catalog.js";
import { PostgresExecutionAudits } from "../../../../services/agent-acp-service/src/adapters/postgres/execution-audit.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import {
  executionConfiguration,
  executionIdentity,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { runtimeInformation } from "../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
import {
  testAuthentication,
  testSecurityEnvironment,
  testHeaders,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import {
  AcpWireClient,
  type ProtocolVersion,
} from "../support/acp-wire-client.js";
import {
  startProxy,
  type FaultReceipt,
  type ProxyStatus,
} from "../support/persistence/proxy.mjs";
import {
  assertDurable,
  assertRecovered,
  assertReplay,
} from "../support/persistence/evidence.mjs";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "production ACP committed-response loss",
  () => {
    let pool: Pool;
    let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
    let service: RunningAgentAcpService | undefined;
    let clients: AcpWireClient[];
    let requests: Promise<unknown>[];
    let releaseFinal:
      ReturnType<typeof Promise.withResolvers<void>> | undefined;
    let key: string;
    const ownershipLost = vi.fn();

    beforeEach(async () => {
      clients = [];
      requests = [];
      key = randomBytes(32).toString("base64");
      releaseFinal = undefined;
      pool = new Pool({ connectionString: databaseUrl, max: 2 });
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      const upstream = new URL(databaseUrl!);
      proxy = await startProxy({
        upstreamHost: upstream.hostname,
        upstreamPort: Number(upstream.port),
        host: "127.0.0.1",
        dbPort: 0,
        httpPort: 0,
        holdMs: 15_000,
      });
    });

    afterEach(async () => {
      releaseFinal?.resolve();
      const results = await Promise.allSettled(
        clients.map((client) => client.close()),
      );
      await Promise.allSettled(requests);
      for (const close of [
        () => service?.shutdown(),
        () => proxy?.close(),
        () => pool.end(),
      ]) {
        try {
          await close();
        } catch (error) {
          results.push({ status: "rejected", reason: error });
        }
      }
      service = undefined;
      proxy = undefined;
      const errors = results.filter((result) => result.status === "rejected");
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason as unknown),
          "Persistence component cleanup failed",
        );
    });

    function origin(control = false) {
      const address = control ? service?.controlAddress() : service?.address();
      if (!address || typeof address === "string")
        throw new Error("ACP did not listen");
      return `http://127.0.0.1:${address.port}`;
    }

    async function start() {
      const proxied = new URL(databaseUrl!);
      proxied.hostname = "127.0.0.1";
      proxied.port = String((proxy!.tcp.address() as AddressInfo).port);
      const config = {
        ...loadConfig({
          ...testSecurityEnvironment(),
          ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
            process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS ?? "false",
          ANTNEST_ACP_DATABASE_URL: proxied.href,
          ANTNEST_ACP_CLIENT_MCP_KEY: key,
        }),
        listen: { host: "127.0.0.1", port: 0 },
        controlListen: { host: "127.0.0.1", port: 0 },
        databaseTimeoutMs: 15_000,
        authentication: testAuthentication(),
      };
      service = await startAgentAcpService(
        config,
        NOOP_TELEMETRY,
        ownershipLost,
      );
      const configuration: ExecutionConfiguration = executionConfiguration();
      configuration.agents[0]!.default_authorization.mode = "auto";
      const response = await fetch(
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
      expect(await response.json()).toMatchObject({ applied_revision: 1 });
      expect(response.status).toBe(200);
    }

    async function connect(version: ProtocolVersion) {
      const client = await AcpWireClient.connect(
        origin().replace("http:", "ws:") + `/v${version}/acp`,
        executionIdentity(),
      );
      clients.push(client);
      await client.initialize(version);
      return client;
    }

    async function control(
      path = "/status",
      body?: Record<string, unknown>,
      status = 200,
    ): Promise<ProxyStatus> {
      const address = proxy!.http.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: body ? "POST" : "GET",
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(status);
      return response.json() as Promise<ProxyStatus>;
    }

    async function saved(runId: string) {
      const repository = new PostgresExecutionAudits(new PostgresKernel(pool));
      const signal = AbortSignal.timeout(5000);
      const run = await repository.get("organization-1", runId, signal);
      expect(run).not.toBeNull();
      const items = await repository.events(
        { organizationId: "organization-1", runId, limit: 100 },
        signal,
      );
      expect(items).not.toBeNull();
      return { run: run!, events: { items: items!, next_cursor: null } };
    }

    for (const version of [1, 2] as const)
      for (const phase of ["intent", "accept", "finish"] as const) {
        const recovery =
          phase === "finish"
            ? "recovers the committed finish in the same instance"
            : "stops admission and recovers committed state";
        it(`v${version} ${phase}: ${recovery} and never replays effects`, async () => {
          // Only the outbound Runtime/model boundaries are fake. Composition,
          // repositories, worker ownership and admission/recovery paths are real.
          const tool = vi.fn<McpConnection["callTool"]>().mockResolvedValue({
            content: [{ type: "text", text: "component tool result" }],
            isError: false,
            structuredContent: { effect_state: "settled", effect_source: null },
          });
          const connections = new Set<McpConnection>();
          vi.spyOn(OfficialMcpDialer.prototype, "connect").mockImplementation(
            async (input) => {
              input.signal.throwIfAborted();
              const { executionId, ...information } = runtimeInformation();
              expect(input.runtimeBinding?.executionId).toBe(executionId);
              const connection: McpConnection = {
                readResource: () =>
                  Promise.resolve({
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
                  }),
                listTools: () =>
                  Promise.resolve([
                    {
                      name: "read",
                      description: "Read",
                      inputSchema: { type: "object" },
                    },
                  ]),
                callTool: tool,
                close: () => {
                  connections.delete(connection);
                  return Promise.resolve();
                },
              };
              connections.add(connection);
              return Promise.resolve(connection);
            },
          );
          if (phase === "finish") releaseFinal = Promise.withResolvers<void>();
          let modelRequests = 0;
          const model = vi
            .spyOn(OpenAICompatibleModel.prototype, "complete")
            .mockImplementation(async () => {
              modelRequests++;
              if (modelRequests % 2 === 1)
                return {
                  kind: "tool_calls",
                  content: [],
                  usage: { inputTokens: 4, outputTokens: 2 },
                  calls: [
                    {
                      id: `call-${modelRequests}`,
                      name: "read",
                      arguments: { path: "component.txt" },
                    },
                  ],
                };
              await releaseFinal?.promise;
              return {
                kind: "message",
                content: [{ type: "text", text: "component complete" }],
                stopReason: "end_turn",
                usage: { inputTokens: 8, outputTokens: 3 },
              };
            });
          await start();
          const originalService = service!;
          let failure: Error | undefined;
          void originalService.failure.then((error) => {
            failure = error;
          });
          const client = await connect(version);
          const observer = await connect(version);
          const created = await client.request("session/new", {
            cwd: "/workspace",
            mcpServers: [],
          });
          expect(created.error).toBeUndefined();
          const sessionId = created.result?.sessionId;
          expect(typeof sessionId).toBe("string");
          if (phase !== "finish")
            await control("/arm", { phase, session_id: sessionId });
          let resolved = false;
          const faultPrompt = [
            { type: "text", text: `v${version}-${phase}-fault` },
          ];
          const pending = client
            .request("session/prompt", {
              sessionId,
              prompt: faultPrompt,
            })
            .then(
              (frame) => {
                resolved = true;
                return { frame };
              },
              (error: unknown) => {
                resolved = true;
                return { error };
              },
            );
          requests.push(pending);
          if (phase === "finish") {
            await expect
              .poll(
                () => ({
                  models: modelRequests,
                  tools: tool.mock.calls.length,
                }),
                { timeout: 5000 },
              )
              .toEqual({ models: 2, tools: 1 });
            const runs = await pool.query<{ id: string }>(
              "SELECT id FROM runs WHERE session_id = $1",
              [sessionId],
            );
            expect(runs.rows).toHaveLength(1);
            await control("/arm", {
              phase,
              session_id: sessionId,
              run_id: runs.rows[0]!.id,
            });
            releaseFinal!.resolve();
          }
          let held: FaultReceipt | undefined;
          await expect
            .poll(
              async () => {
                held = (await control()).held ?? undefined;
                return held;
              },
              { timeout: 5000 },
            )
            .toBeDefined();
          const before = await saved(held!.run_id);
          assertDurable(before, held);
          expect(before.run.input).toEqual(faultPrompt);
          if (phase !== "intent") {
            const input = before.events.items.filter(
              (event) => event.kind === "user_message",
            );
            expect(input).toHaveLength(1);
            expect(input[0]).toMatchObject({
              visible: true,
              payload: { content: faultPrompt },
            });
          }
          expect(before.run.usage_measurements).toEqual(
            phase === "finish"
              ? [
                  { inputTokens: 4, outputTokens: 2 },
                  { inputTokens: 8, outputTokens: 3 },
                ]
              : [],
          );
          expect(failure).toBeUndefined();
          expect(model).toHaveBeenCalledTimes(phase === "finish" ? 2 : 0);
          expect(tool).toHaveBeenCalledTimes(phase === "finish" ? 1 : 0);
          const callsBeforeReplay = modelRequests;
          const toolsBeforeReplay = tool.mock.calls.length;
          if (version === 2 && phase === "finish") {
            const acknowledged = await pending;
            const inputs = before.events.items.filter(
              (event) => event.kind === "user_message",
            );
            expect(inputs).toHaveLength(1);
            const message = inputs[0]!.payload as { messageId: string };
            expect(message.messageId).toEqual(expect.any(String));
            expect(message.messageId.length).toBeGreaterThan(0);
            expect(acknowledged).toHaveProperty(
              "frame.result.messageId",
              message.messageId,
            );
            expect(acknowledged).not.toHaveProperty("frame.error");
          } else expect(resolved).toBe(false);
          const state = await fetch(
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
          expect(state.status).toBe(200);
          expect(await state.json()).toMatchObject({ availability: "busy" });
          await control("/drop", { receipt_id: "foreign" }, 409);
          await control("/drop", { receipt_id: held!.receipt_id });
          if (phase === "finish") {
            const outcome = await pending;
            expect(outcome).not.toHaveProperty("error");
            expect(outcome).not.toHaveProperty("frame.error");
            if (version === 1) {
              expect(outcome).toHaveProperty("frame.result", {
                stopReason: "end_turn",
              });
            } else {
              await expect
                .poll(
                  () =>
                    client.frames
                      .filter(
                        (frame) =>
                          frame.method === "session/update" &&
                          frame.params?.sessionId === sessionId,
                      )
                      .map((frame) => frame.params?.update)
                      .filter(
                        (update) =>
                          update?.sessionUpdate === "state_update" &&
                          update.state === "idle",
                      ),
                  { timeout: 5000 },
                )
                .toEqual([
                  expect.objectContaining({
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "end_turn",
                  }),
                ]);
            }
            // Durable output can expose idle before the held write returns.
            // Ready admission additionally proves that the original executor joined.
            await expect
              .poll(
                async () => {
                  const ready = await fetch(
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
                  const body: unknown = await ready.json();
                  expect(ready.status).toBe(200);
                  return body;
                },
                { timeout: 5000 },
              )
              .toMatchObject({
                availability: "ready",
                active_session_id: null,
                unavailable_reason: null,
              });
            const healthy = await fetch(origin() + "/status", {
              signal: AbortSignal.timeout(5000),
            });
            await healthy.text();
            expect(healthy.status).toBe(200);
            expect(service).toBe(originalService);
            expect(failure).toBeUndefined();
          } else {
            await expect
              .poll(() => failure, { timeout: 5000 })
              .toBeInstanceOf(Error);
            expect(failure!.cause).toBeInstanceOf(Error);
            const unavailable = await fetch(origin() + "/status");
            expect(unavailable.status).toBe(503);
            await unavailable.text();
            const outcome = await pending;
            // A valid connection opened before fail-stop must also lose admission.
            const refused = await observer.request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "must-not-admit" }],
            });
            expect(refused.error).toEqual({
              code: -32034,
              message: "Agent ACP Service is not accepting new Runs",
              data: { code: "service_stopping", retryable: true },
            });
            expect(outcome).toHaveProperty(
              "frame.error.data.code",
              "database_error",
            );
          }
          expect(
            (
              await pool.query("SELECT id FROM runs WHERE session_id = $1", [
                sessionId,
              ])
            ).rows,
          ).toEqual([{ id: held!.run_id }]);
          expect(modelRequests).toBe(callsBeforeReplay);
          expect(tool).toHaveBeenCalledTimes(toolsBeforeReplay);
          if (phase !== "finish") {
            await client.close();
            await observer.close();
            await service!.shutdown();
            service = undefined;
            await start();
          }
          const after = await saved(held!.run_id);
          assertRecovered(before, after, phase);
          expect(modelRequests).toBe(callsBeforeReplay);
          expect(tool).toHaveBeenCalledTimes(toolsBeforeReplay);
          for (let replay = 0; replay < 2; replay++) {
            const reader = await connect(version);
            const offset = reader.frames.length;
            const response = await reader.request(
              version === 1 ? "session/load" : "session/resume",
              {
                sessionId,
                cwd: "/workspace",
                mcpServers: [],
                ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
              },
            );
            expect(response.error).toBeUndefined();
            const updates = reader.frames
              .slice(offset)
              .filter((frame) => frame.method === "session/update")
              .map((frame) => frame.params);
            assertReplay(version, updates, after, sessionId);
            await reader.close();
          }
          expect(modelRequests).toBe(callsBeforeReplay);
          expect(tool).toHaveBeenCalledTimes(toolsBeforeReplay);
          const reader = phase === "finish" ? observer : await connect(version);
          const loaded = await reader.request(
            version === 1 ? "session/load" : "session/resume",
            { sessionId, cwd: "/workspace", mcpServers: [] },
          );
          expect(loaded.error).toBeUndefined();
          const next = await reader.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "post-recovery" }],
          });
          expect(next.error).toBeUndefined();
          await expect
            .poll(
              async () =>
                (
                  await pool.query<{ state: string }>(
                    "SELECT state FROM runs WHERE session_id = $1 AND id <> $2",
                    [sessionId, held!.run_id],
                  )
                ).rows,
              { timeout: 5000 },
            )
            .toEqual([{ state: "completed" }]);
          expect(modelRequests).toBe(callsBeforeReplay + 2);
          expect(tool).toHaveBeenCalledTimes(toolsBeforeReplay + 1);
          expect(await saved(held!.run_id)).toEqual(after);
          expect((await control()).records).toEqual([
            { ...held, delivery: "dropped" },
          ]);
          expect((await control()).errors).toEqual([]);
          expect(ownershipLost).not.toHaveBeenCalled();
          expect(connections.size).toBe(0);
          if (phase === "finish") {
            expect(service).toBe(originalService);
            expect(failure).toBeUndefined();
          }
        });
      }
  },
);
