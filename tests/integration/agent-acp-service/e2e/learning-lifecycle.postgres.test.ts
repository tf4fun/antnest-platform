import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CallerContextVerifier } from "../../../../services/agent-acp-service/src/adapters/caller-context.js";
import { PinnedProviderTransport } from "../../../../services/agent-acp-service/src/adapters/model/provider-transport.js";
import { PostgresAgentLeases } from "../../../../services/agent-acp-service/src/adapters/postgres/agent-leases.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import {
  createLegacyLearningRepositories,
  createOwnedLearningRepositories,
} from "../../../../services/agent-acp-service/src/adapters/postgres/learning-repositories.js";
import { PostgresWorkerLock } from "../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import { RuntimeConnections } from "../../../../services/agent-acp-service/src/adapters/runtime-connections.js";
import {
  parseOwnerProbeRequest,
  type OwnerRegistration,
} from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import {
  startAgentAcpService,
  type RunningAgentAcpService,
} from "../../../../services/agent-acp-service/src/composition.js";
import { loadConfig } from "../../../../services/agent-acp-service/src/config.js";
import { learningPolicySchema } from "../../../../services/agent-acp-service/src/domain/learning-policy.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import {
  ModelError,
  ModelTransportCleanupError,
} from "../../../../services/agent-acp-service/src/ports/model.js";
import { OwnerProbeServer } from "../../../../services/agent-acp-service/src/transport/owner-probe-server.js";
import { RequestAuthentication } from "../../../../services/agent-acp-service/src/transport/request-authentication.js";
import {
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { runtimeInformation } from "../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
import {
  testJwks,
  testSecurityEnvironment,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { AcpWireClient } from "../support/acp-wire-client.js";
import {
  readBody,
  serviceOrigin,
  startPeer,
  within,
} from "../support/production-peers.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const scope = { organizationId: "organization-1", agentId: "agent-1" };
const reply = "The independent foreground Run completed.";

describe.skipIf(databaseUrl === undefined)(
  "production Learning original model lifecycle",
  () => {
    it.each([
      { ownership: "legacy", action: "shutdown", closeFailure: "none" },
      { ownership: "owned", action: "shutdown", closeFailure: "none" },
      { ownership: "owned", action: "loss", closeFailure: "none" },
      { ownership: "legacy", action: "shutdown", closeFailure: "close" },
      { ownership: "owned", action: "shutdown", closeFailure: "close" },
      { ownership: "owned", action: "loss", closeFailure: "close" },
      {
        ownership: "owned",
        action: "shutdown",
        closeFailure: "http-and-close",
      },
    ] as const)(
      "$ownership $action cleanup=$closeFailure joins the original model and preserves independent Agent execution",
      async ({ ownership, action, closeFailure }) => {
        expect(new URL(databaseUrl!).pathname).toMatch(/_test$/u);
        const schema = `learning_lifecycle_${randomUUID().replaceAll("-", "")}`;
        const applicationName = `learning-service-${randomUUID()}`;
        const serviceUrl = new URL(databaseUrl!);
        serviceUrl.searchParams.set("options", `-c search_path=${schema}`);
        serviceUrl.searchParams.set("application_name", applicationName);
        const observerUrl = new URL(serviceUrl);
        observerUrl.searchParams.set(
          "application_name",
          applicationName + "-observer",
        );
        const pool = new Pool({
          connectionString: observerUrl.toString(),
          max: 2,
          connectionTimeoutMillis: 5000,
          statement_timeout: 5000,
          query_timeout: 6000,
        });
        const kernel = new PostgresKernel(pool);
        const leases = new PostgresAgentLeases(kernel);
        const peers: Array<Awaited<ReturnType<typeof startPeer>>> = [];
        const handlers: Array<ReturnType<typeof createMcpHandler>> = [];
        const clients: AcpWireClient[] = [];
        const pending: Promise<unknown>[] = [];
        const failures: unknown[] = [];
        const abort = new AbortController();
        const held = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const originalClosed = Promise.withResolvers<void>();
        const cleanupError = new Error(
          "Synthetic internal transport cleanup failure",
        );
        const expectedShutdownFailure = { value: undefined as unknown };
        const ownershipLost = vi.fn();
        const probeListen = vi.spyOn(OwnerProbeServer.prototype, "listen");
        const leaseRelease = vi.spyOn(PostgresAgentLeases.prototype, "release");
        const workerRelease = vi.spyOn(PostgresWorkerLock.prototype, "release");
        const runtimeClose = vi.spyOn(RuntimeConnections.prototype, "close");
        // Every invocation below binds the original method to its real transport.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const originalClose = PinnedProviderTransport.prototype.close;
        const hold = { active: false };
        let holdNext = false,
          nativeClosed = false;
        const close = vi
          .spyOn(PinnedProviderTransport.prototype, "close")
          .mockImplementation(async function (this: PinnedProviderTransport) {
            if (holdNext && !hold.active) {
              hold.active = true;
              held.resolve();
              await release.promise;
              try {
                await originalClose.call(this);
                nativeClosed = true;
                if (closeFailure !== "none") throw cleanupError;
              } finally {
                originalClosed.resolve();
              }
            } else await originalClose.call(this);
          });
        let service: RunningAgentAcpService | undefined;
        let closing = false;
        let registration: OwnerRegistration | undefined;
        let createdSchema = false;
        let automatic = false;
        let retirementAck: { status: number; body: unknown } | undefined;
        const providerSecret = randomBytes(32).toString("base64url");
        const requests: Array<{ review: boolean; messages: unknown }> = [];
        const runtimeReads: string[] = [];
        const policy = learningPolicySchema.parse({
          organization_id: scope.organizationId,
          agent_id: scope.agentId,
          owner_principal_id: "principal-1",
          revision: "b".repeat(64),
          activation_cut_at: new Date(Date.now() - 60_000).toISOString(),
          mode: "automatic",
          scope: { auto_generated_personal: true, adopted_paths: [] },
          pinned_paths: [],
          limits: {
            daily_reviews: 20,
            daily_model_input_tokens: 320000,
            daily_model_output_tokens: 80000,
          },
        });
        function track<T>(promise: Promise<T>): Promise<T> {
          pending.push(promise);
          void promise.catch(() => undefined);
          return promise;
        }
        const token = (name: string) =>
          readFileSync(
            join(
              testSecurityEnvironment().ANTNEST_SERVICE_AUTH_TOKEN_DIR,
              name,
            ),
            "utf8",
          ).trim();
        async function prompt(agentId: string) {
          const client = await within(
            track(
              AcpWireClient.connect(
                serviceOrigin(service!).replace("http:", "ws:") + "/v2/acp",
                { ...executionIdentity(), agentId },
              ).then(async (value) => {
                clients.push(value);
                if (closing) await value.close();
                return value;
              }),
            ),
            "ACP connect",
            5000,
          );
          await within(track(client.initialize(2)), "initialize", 5000);
          const session = await within(
            track(
              client.request("session/new", {
                cwd: "/workspace",
                mcpServers: [],
              }),
            ),
            "session/new",
            5000,
          );
          expect(session.error).toBeUndefined();
          const sessionId = session.result?.sessionId;
          if (typeof sessionId !== "string")
            throw new Error("Missing production Session");
          const response = await within(
            track(
              client.request("session/prompt", {
                sessionId,
                prompt: [
                  { type: "text", text: `Complete foreground for ${agentId}` },
                ],
              }),
            ),
            "session/prompt",
            10000,
          );
          expect(response.error).toBeUndefined();
          await expect
            .poll(
              async () =>
                (
                  await pool.query<{ state: string }>(
                    "SELECT state FROM runs WHERE session_id=$1",
                    [sessionId],
                  )
                ).rows[0]?.state,
              { timeout: 5000 },
            )
            .toBe("completed");
          const rows = (
            await pool.query<{
              id: string;
              execution_owner_registration_id: string | null;
              execution_owner_member_id: string | null;
              execution_owner_incarnation_id: string | null;
              execution_owner_epoch: string | null;
            }>(
              "SELECT id,execution_owner_registration_id,execution_owner_member_id,execution_owner_incarnation_id,execution_owner_epoch::text FROM runs WHERE session_id=$1",
              [sessionId],
            )
          ).rows;
          expect(rows).toHaveLength(1);
          expect(rows[0]!.execution_owner_registration_id).toBe(
            registration?.registration_id ?? null,
          );
          const agentOwner = await leases.read({ ...scope, agentId });
          expect(rows[0]).toMatchObject({
            execution_owner_member_id: registration?.member_id ?? null,
            execution_owner_incarnation_id:
              registration?.incarnation_id ?? null,
            execution_owner_epoch: agentOwner?.fence.epoch ?? null,
          });
          const messages = (
            await pool.query<{ kind: string; content: unknown }>(
              "SELECT kind,payload->'content' AS content FROM session_messages WHERE run_id=$1 AND kind IN ('user_message','agent_message') ORDER BY sequence",
              [rows[0]!.id],
            )
          ).rows;
          expect(messages).toEqual([
            {
              kind: "user_message",
              content: [
                { type: "text", text: `Complete foreground for ${agentId}` },
              ],
            },
            { kind: "agent_message", content: [{ type: "text", text: reply }] },
          ]);
          return { client, run: rows[0]!, sessionId };
        }
        const learningSnapshot = async () =>
          (
            await pool.query<{ value: string }>(`SELECT jsonb_build_object(
      'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM learning_tasks t),
      'calls',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.request_id) FROM learning_model_calls c),
      'candidates',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.task_id) FROM learning_candidates c))::text AS value`)
          ).rows[0]!.value;
        try {
          await pool.query(`CREATE SCHEMA ${schema}`);
          createdSchema = true;
          const controller = await startPeer((request, response) => {
            expect(
              request.headers["antnest-service-authorization"] ===
                `Bearer ${token("agent-controller")}`,
            ).toBe(true);
            const url = new URL(request.url!, "http://controller.invalid");
            expect(request.method).toBe("GET");
            expect(url.searchParams.get("organization_id")).toBe(
              scope.organizationId,
            );
            expect(url.searchParams.get("principal_id")).toBe("principal-1");
            const agentId = url.pathname.split("/")[3];
            expect(["agent-1", "agent-2"]).toContain(agentId);
            expect(url.pathname).toBe(
              `/internal/agents/${agentId}/skill-learning-policy`,
            );
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                ...policy,
                agent_id: agentId,
                mode: automatic && agentId === "agent-1" ? "automatic" : "off",
              }),
            );
            return Promise.resolve();
          });
          peers.push(controller);
          const registrar = await startPeer(async (request, response) => {
            expect(request.method).toBe("POST");
            expect(request.url).toBe("/internal/acp-incarnations/register");
            expect(
              request.headers["antnest-service-authorization"] ===
                `Bearer ${token("runtime-controller")}`,
            ).toBe(true);
            const input = JSON.parse(
              (await readBody(request)).toString("utf8"),
            ) as Record<string, unknown>;
            const challenge = parseOwnerProbeRequest({
              ...input,
              challenge: randomBytes(32).toString("hex"),
            });
            const probe = probeListen.mock.contexts.at(-1);
            const address =
              probe instanceof OwnerProbeServer ? probe.address() : null;
            if (address === null) throw new Error("Missing live owner probe");
            const original = track(
              (async () => {
                const result = await fetch(
                  `http://127.0.0.1:${address.port}/internal/acp-owner/incarnation/probe`,
                  {
                    method: "POST",
                    headers: {
                      ...workloadHeaders("runtime-controller"),
                      "content-type": "application/json",
                    },
                    body: JSON.stringify(challenge),
                    signal: AbortSignal.any([
                      abort.signal,
                      AbortSignal.timeout(5000),
                    ]),
                  },
                );
                expect(result.status).toBe(200);
                expect(await result.json()).toEqual(challenge);
              })(),
            );
            await original;
            registration = {
              registration_id: randomUUID(),
              member_id: challenge.member_id,
              incarnation_id: challenge.incarnation_id,
            };
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify(registration));
          });
          peers.push(registrar);
          const model = await startPeer(async (request, response) => {
            expect(
              request.headers.authorization === `Bearer ${providerSecret}`,
            ).toBe(true);
            expect(request.method).toBe("POST");
            expect(request.url).toBe("/v1/chat/completions");
            const body = JSON.parse(
              (await readBody(request)).toString("utf8"),
            ) as { messages: unknown; model: unknown };
            expect(body.model).toBe("test-model");
            const review = JSON.stringify(body.messages).includes(
              "You are reviewing one completed Agent run",
            );
            requests.push({ review, messages: body.messages });
            if (review && closeFailure === "http-and-close") {
              response.writeHead(503).end();
              return;
            }
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: review
                        ? JSON.stringify({
                            decision: "skip",
                            reason: "No reusable procedure",
                          })
                        : reply,
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 3,
                  completion_tokens: 2,
                  total_tokens: 5,
                },
              }),
            );
          });
          peers.push(model);
          const configuration = executionConfiguration();
          configuration.providers[0]!.base_url = model.origin + "/v1";
          configuration.providers[0]!.credential.secret = providerSecret;
          configuration.agents.push({
            ...structuredClone(configuration.agents[0]!),
            agent_id: "agent-2",
            runtime: runtimeConfiguration(2),
          });
          for (const agent of configuration.agents) {
            const runtime = agent.runtime!;
            const handler = createMcpHandler(
              () => {
                const server = new McpServer({
                  name: "learning-runtime-peer",
                  version: "1.0.0",
                });
                server.registerResource(
                  "runtime-info",
                  "antnest://runtime/info",
                  { mimeType: "application/json" },
                  (uri) => {
                    runtimeReads.push(agent.agent_id);
                    const { executionId: _executionId, ...information } =
                      runtimeInformation();
                    void _executionId;
                    return {
                      contents: [
                        {
                          uri: uri.toString(),
                          mimeType: "application/json",
                          text: JSON.stringify({
                            ...information,
                            execution_id: runtime.runtime_execution_id,
                            instructions: null,
                            skills: [],
                          }),
                        },
                      ],
                    };
                  },
                );
                server.registerTool(
                  "echo",
                  {
                    description: "Unused lifecycle fixture tool",
                    inputSchema: z.object({ text: z.string() }),
                  },
                  () => {
                    throw new Error("No tool execution is expected");
                  },
                );
                return server;
              },
              { legacy: "reject" },
            );
            handlers.push(handler);
            const peer = await startPeer(async (request, response) => {
              expect(
                request.headers["antnest-service-authorization"] ===
                  `Bearer ${runtime.credential!.token}`,
              ).toBe(true);
              expect(request.headers["x-antnest-expected-execution-id"]).toBe(
                runtime.runtime_execution_id,
              );
              const body = await readBody(request);
              const headers = new Headers();
              for (const [name, value] of Object.entries(request.headers))
                if (Array.isArray(value))
                  for (const item of value) headers.append(name, item);
                else if (value !== undefined) headers.set(name, value);
              const init: RequestInit & { duplex?: "half" } = {
                method: request.method ?? "GET",
                headers,
              };
              if (body.length > 0) {
                init.body = new Uint8Array(body);
                init.duplex = "half";
              }
              const result = await handler.fetch(
                new Request(
                  `http://${request.headers.host}${request.url}`,
                  init,
                ),
              );
              response.statusCode = result.status;
              result.headers.forEach((value, name) =>
                response.setHeader(name, value),
              );
              response.end(Buffer.from(await result.arrayBuffer()));
            });
            peers.push(peer);
            runtime.mcp_endpoint = peer.origin + "/mcp";
          }
          const signing = generateKeyPairSync("ed25519")
            .privateKey.export({ format: "der", type: "pkcs8" })
            .toString("base64");
          const loaded = loadConfig({
            ...testSecurityEnvironment(),
            ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
              process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS ?? "false",
            ANTNEST_ACP_DATABASE_URL: serviceUrl.toString(),
            ANTNEST_ACP_CLIENT_MCP_KEY: randomBytes(32).toString("base64"),
            ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: "true",
            ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL: controller.origin,
            ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: "learning-lifecycle",
            ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: signing,
          });
          service = await within(
            track(
              startAgentAcpService(
                {
                  ...loaded,
                  listen: { host: "127.0.0.1", port: 0 },
                  controlListen: { host: "127.0.0.1", port: 0 },
                  databaseTimeoutMs: 5000,
                  runTimeoutMs: 15000,
                  authentication: new RequestAuthentication(
                    loaded.authentication.workload,
                    new CallerContextVerifier("http://identity.invalid/", () =>
                      Promise.resolve(Response.json(testJwks())),
                    ),
                  ),
                  ...(ownership === "owned"
                    ? {
                        ownerIncarnation: {
                          memberId: "acp-learning-owned",
                          listen: { host: "127.0.0.1", port: 0 },
                          runtimeControllerUrl: registrar.origin,
                          registrationTimeoutMs: 5000,
                        },
                      }
                    : {}),
                },
                NOOP_TELEMETRY,
                ownershipLost,
              ).then(async (value) => {
                service = value;
                void value.failure.then((error) => failures.push(error));
                if (closing) await value.shutdown();
                return value;
              }),
            ),
            "production service startup",
            15000,
          );
          await within(
            track(
              (async () => {
                const response = await fetch(
                  serviceOrigin(service!, true) +
                    "/rpc/agent-acp/apply-execution-snapshot",
                  {
                    method: "POST",
                    headers: {
                      ...workloadHeaders("agent-controller"),
                      "content-type": "application/json",
                    },
                    body: JSON.stringify(configuration),
                    signal: AbortSignal.any([
                      abort.signal,
                      AbortSignal.timeout(5000),
                    ]),
                  },
                );
                const body: unknown = await response.json();
                expect({ status: response.status, body }).toEqual({
                  status: 200,
                  body: {
                    organization_id: scope.organizationId,
                    applied_revision: 1,
                  },
                });
              })(),
            ),
            "publication",
            10000,
          );
          const a = await prompt("agent-1");
          expect(requests).toHaveLength(1);
          const owner = await leases.read(scope);
          if (
            ownership === "owned" &&
            (owner === null || registration === undefined)
          )
            throw new Error(
              "Owned production service did not acquire its Agent",
            );
          const repositories =
            ownership === "owned"
              ? createOwnedLearningRepositories(kernel, {
                  fence: owner!.fence,
                  registration: registration!,
                })
              : createLegacyLearningRepositories(
                  kernel,
                  new AbortController().signal,
                );
          const learningScope = { ...scope, ownerId: "principal-1" };
          // Only prepare the pending task. Claim, evidence, budget, model and
          // cancellation are executed by the actual production background loop.
          holdNext = true;
          await repositories.scan.activate(
            learningScope,
            policy.revision,
            policy.activation_cut_at,
          );
          const task = await repositories.scan.enqueue(
            learningScope,
            a.run.id,
            policy,
          );
          expect(task).not.toBeNull();
          automatic = true;
          // Age only the completed source after the final policy is available;
          // do not bypass the actual worker's quiet-period or claim predicates.
          await pool.query(
            "UPDATE runs SET updated_at=clock_timestamp()-interval '20 seconds' WHERE id=$1 AND state='completed'",
            [a.run.id],
          );
          const source = (
            await pool.query<{ value: string }>(
              "SELECT to_jsonb(r)::text AS value FROM runs r WHERE id=$1",
              [a.run.id],
            )
          ).rows[0]!.value;
          await within(held.promise, "original background model close", 10000);
          expect(requests.filter((request) => request.review)).toHaveLength(1);
          expect(JSON.stringify(requests.at(-1)!.messages)).toContain(a.run.id);
          const claim = (
            await pool.query<{
              state: string;
              authority_mode: string;
              execution_owner_registration_id: string | null;
              claim_owner_member_id: string | null;
              claim_owner_incarnation_id: string | null;
              claim_owner_epoch: string | null;
            }>(
              "SELECT state,authority_mode,claim_owner_registration_id AS execution_owner_registration_id,claim_owner_member_id,claim_owner_incarnation_id,claim_owner_epoch::text FROM learning_tasks WHERE id=$1",
              [task!.taskId],
            )
          ).rows[0]!;
          expect(claim).toMatchObject({
            state: "running",
            authority_mode: ownership,
            execution_owner_registration_id:
              registration?.registration_id ?? null,
            claim_owner_member_id: registration?.member_id ?? null,
            claim_owner_incarnation_id: registration?.incarnation_id ?? null,
            claim_owner_epoch: owner?.fence.epoch ?? null,
          });
          expect(
            (
              await pool.query(
                "SELECT request_id FROM learning_model_calls WHERE task_id=$1",
                [task!.taskId],
              )
            ).rowCount,
          ).toBe(1);
          let shutdown: Promise<void> | undefined;
          let stopped = false;
          let lostSnapshot: string | undefined;
          if (action === "loss") {
            expect(
              (
                await pool.query(
                  "UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND agent_id=$2 AND owner_instance_id=$3 AND epoch=$4::bigint",
                  [
                    scope.organizationId,
                    scope.agentId,
                    owner!.fence.ownerInstanceId,
                    owner!.fence.epoch,
                  ],
                )
              ).rowCount,
            ).toBe(1);
            const denied = await within(
              track(
                a.client.request("session/new", {
                  cwd: "/workspace",
                  mcpServers: [],
                }),
              ),
              "fenced Agent A write",
              5000,
            );
            expect(denied.error).toBeDefined();
            const b = await prompt("agent-2");
            const bOwner = await leases.read({ ...scope, agentId: "agent-2" });
            expect(b.run.execution_owner_epoch).toBe(bOwner!.fence.epoch);
            expect(b.run.execution_owner_incarnation_id).toBe(
              registration!.incarnation_id,
            );
            expect(runtimeReads).toContain("agent-2");
            expect(requests).toHaveLength(3);
            lostSnapshot = await learningSnapshot();
          } else {
            // A completed WS must not mask a missing model join in server.close().
            await Promise.all(clients.map((client) => client.close()));
            shutdown = track(
              service!.shutdown().then(() => {
                stopped = true;
              }),
            );
          }
          await delay(500);
          expect(nativeClosed).toBe(false);
          expect(stopped).toBe(false);
          expect(workerRelease).not.toHaveBeenCalled();
          expect(runtimeClose).not.toHaveBeenCalled();
          expect(
            leaseRelease.mock.calls.filter(
              ([fence]) => fence.agentId === "agent-1",
            ),
          ).toHaveLength(0);
          expect(ownershipLost).not.toHaveBeenCalled();
          expect(failures).toEqual([]);
          release.resolve();
          await within(originalClosed.promise, "native transport close", 5000);
          expect(nativeClosed).toBe(true);
          if (action === "loss") {
            await expect
              .poll(
                () =>
                  leaseRelease.mock.calls.filter(
                    ([fence]) => fence.agentId === "agent-1",
                  ).length,
              )
              .toBe(1);
            expect(await learningSnapshot()).toBe(lostSnapshot);
            expect(
              (
                await pool.query<{ value: string }>(
                  "SELECT to_jsonb(r)::text AS value FROM runs r WHERE id=$1",
                  [a.run.id],
                )
              ).rows[0]!.value,
            ).toBe(source);
            // A late cleanup failure must stay scoped after its original
            // inference settles, not only while the close barrier is held.
            await prompt("agent-2");
            expect(requests).toHaveLength(4);
            expect(failures).toEqual([]);
            const response = await track(
              fetch(
                serviceOrigin(service!, true) +
                  "/rpc/agent-acp/apply-execution-snapshot",
                {
                  method: "POST",
                  headers: {
                    ...workloadHeaders("agent-controller"),
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({
                    ...configuration,
                    revision: 2,
                    agents: configuration.agents.filter(
                      (agent) => agent.agent_id !== "agent-1",
                    ),
                  }),
                  signal: AbortSignal.any([
                    abort.signal,
                    AbortSignal.timeout(5000),
                  ]),
                },
              ),
            );
            retirementAck = {
              status: response.status,
              body: (await response.json()) as unknown,
            };
            await Promise.all(clients.map((client) => client.close()));
            shutdown = track(service!.shutdown());
          }
          let shutdownError: unknown;
          try {
            await within(shutdown!, "original service shutdown", 10000);
          } catch (error) {
            shutdownError = error;
          }
          if (closeFailure === "none") {
            expect(shutdownError).toBeUndefined();
          } else {
            const errors = errorTree(shutdownError);
            expect(errors).toContain(cleanupError);
            const modelCleanup = errors.find(
              (error) => error instanceof ModelTransportCleanupError,
            );
            expect(modelCleanup).toMatchObject({
              code: "model_unavailable",
              retryable: false,
            });
            expect(Object.keys(modelCleanup!)).not.toContain("cause");
            if (closeFailure === "close")
              expect(
                (modelCleanup as ModelTransportCleanupError).usage,
              ).toMatchObject({ inputTokens: 3, outputTokens: 2 });
            const causes = errors.filter(
              (error) =>
                !(error instanceof AggregateError) &&
                !(error instanceof ModelTransportCleanupError),
            );
            if (closeFailure === "http-and-close") {
              expect(causes).toHaveLength(2);
              expect(
                causes.some(
                  (error) =>
                    error instanceof ModelError &&
                    error.code === "model_http_error" &&
                    error.status === 503,
                ),
              ).toBe(true);
            } else expect(causes).toEqual([cleanupError]);
            expectedShutdownFailure.value = shutdownError;
          }
          if (action === "loss") {
            expect(retirementAck?.status).toBe(
              closeFailure === "none" ? 200 : 503,
            );
            if (closeFailure !== "none")
              expect(retirementAck?.body).toMatchObject({
                code: "configuration_unavailable",
              });
          }
          expect(workerRelease).toHaveBeenCalledTimes(1);
          if (ownership === "owned")
            expect(
              leaseRelease.mock.calls.filter(
                ([fence]) => fence.agentId === "agent-1",
              ),
            ).toHaveLength(1);
          // The client close completes before PostgreSQL necessarily retires
          // the backend. Require its actual disappearance within a fixed budget.
          await expect
            .poll(
              async () =>
                (
                  await pool.query(
                    "SELECT pid FROM pg_stat_activity WHERE application_name=$1",
                    [applicationName],
                  )
                ).rowCount,
              { timeout: 2000, interval: 20 },
            )
            .toBe(0);
          expect(ownershipLost).not.toHaveBeenCalled();
        } catch (error) {
          failures.push(error);
        } finally {
          closing = true;
          release.resolve();
          abort.abort(new Error("Learning lifecycle fixture is closing"));
          const settle = async (operation: () => Promise<unknown>) => {
            try {
              await operation();
            } catch (error) {
              failures.push(error);
            }
          };
          await settle(() =>
            Promise.all(clients.map((client) => client.close())),
          );
          if (service !== undefined)
            await settle(async () => {
              try {
                await service!.shutdown();
              } catch (error) {
                if (error !== expectedShutdownFailure.value) throw error;
              }
            });
          if (hold.active) await settle(() => originalClosed.promise);
          await Promise.allSettled(pending);
          for (const handler of handlers.toReversed())
            await settle(() => handler.close());
          for (const peer of peers.toReversed())
            await settle(() => peer.close());
          for (const context of runtimeClose.mock.contexts)
            if (
              context instanceof RuntimeConnections &&
              existsSync(context.directory)
            )
              failures.push(
                new Error(
                  "Runtime sender directory survived production shutdown",
                ),
              );
          if (createdSchema)
            await settle(() => pool.query(`DROP SCHEMA ${schema} CASCADE`));
          await settle(() => pool.end());
          close.mockRestore();
          probeListen.mockRestore();
          leaseRelease.mockRestore();
          workerRelease.mockRestore();
          runtimeClose.mockRestore();
        }
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            "Production Learning lifecycle or cleanup failed",
          );
      },
      60000,
    );
  },
);

function errorTree(error: unknown): unknown[] {
  const found = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (found.has(value)) return;
    found.add(value);
    if (value instanceof AggregateError)
      for (const nested of value.errors as unknown[]) visit(nested);
    if (value instanceof Error && value.cause !== undefined) visit(value.cause);
  };
  visit(error);
  return [...found];
}
