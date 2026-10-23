import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RuntimeConnections } from "../../../../services/agent-acp-service/src/adapters/runtime-connections.js";
import { OwnerProbeServer } from "../../../../services/agent-acp-service/src/transport/owner-probe-server.js";
import { CallerContextVerifier } from "../../../../services/agent-acp-service/src/adapters/caller-context.js";
import { RequestAuthentication } from "../../../../services/agent-acp-service/src/transport/request-authentication.js";
import {
  parseOwnerProbeRequest,
  type OwnerRegistration,
} from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import {
  startAgentAcpService,
  type RunningAgentAcpService,
} from "../../../../services/agent-acp-service/src/composition.js";
import { loadConfig } from "../../../../services/agent-acp-service/src/config.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import {
  executionConfiguration,
  executionIdentity,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { runtimeInformation } from "../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
import {
  testJwks,
  testSecurityEnvironment,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { AcpWireClient, type WireFrame } from "../support/acp-wire-client.js";
import {
  serviceOrigin,
  startPeer,
  readBody,
  within,
} from "../support/production-peers.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const reply = "The sealed warm configuration admitted this Run.";
type Boot = "published" | "restored";
type StoredRun = {
  id: string;
  state: string;
  terminal_class: string | null;
  executor_state: string | null;
  tool_effect_state: string | null;
  unknown_effect_source: string | null;
  stop_reason: string | null;
  error_class: string | null;
  execution_snapshot: unknown;
  organization_id: string;
  agent_id: string;
  principal_id: string;
  execution_owner_registration_id: string | null;
  execution_owner_member_id: string | null;
  execution_owner_incarnation_id: string | null;
  execution_owner_epoch: string | null;
};

describe.skipIf(databaseUrl === undefined)(
  "production ACP warm admission",
  () => {
    it.each([
      { version: 1, ownership: "legacy" },
      { version: 2, ownership: "legacy" },
      { version: 1, ownership: "owned" },
      { version: 2, ownership: "owned" },
    ] as const)(
      "$ownership v$version admits a persisted new Run before republication and uses a newer revision in the same restarted instance",
      async ({ version, ownership }) => {
        expect(new URL(databaseUrl!).pathname).toMatch(/_test$/u);
        const pool = new Pool({
          connectionString: databaseUrl,
          max: 2,
          connectionTimeoutMillis: 5000,
          statement_timeout: 5000,
          query_timeout: 5000,
        });
        const key = randomBytes(32).toString("base64");
        const providerSecret = randomBytes(32).toString("base64url");
        const runtimeToken = randomBytes(32).toString("base64url");
        const runtimeExecutionId =
          "warm-execution-" + randomBytes(8).toString("hex");
        const connectionId = "rci_" + randomBytes(16).toString("hex");
        const services: RunningAgentAcpService[] = [];
        const clients: AcpWireClient[] = [];
        const pending: Promise<unknown>[] = [];
        const peers: Array<Awaited<ReturnType<typeof startPeer>>> = [];
        const failures: unknown[] = [];
        const ownershipLost = vi.fn();
        const requestAbort = new AbortController();
        const prepare = vi.spyOn(RuntimeConnections.prototype, "prepare");
        const close = vi.spyOn(RuntimeConnections.prototype, "close");
        const probeListen = vi.spyOn(OwnerProbeServer.prototype, "listen");
        const registrations: OwnerRegistration[] = [];
        let registrationOrigin: string | undefined;
        const modelRequests: Array<{
          boot: Boot;
          authorized: boolean;
          model: unknown;
          messages: unknown;
        }> = [];
        const runtimeRequests: Array<{
          boot: Boot;
          authorized: boolean;
          executionId: string | string[] | undefined;
        }> = [];
        const resourceReads: Boot[] = [];
        let boot: Boot = "published";
        let closing = false;
        let publicationCount = 0;

        function track<T>(promise: Promise<T>): Promise<T> {
          pending.push(promise);
          void promise.catch(() => undefined);
          return promise;
        }

        function senderDirectories(): string[] {
          return [
            ...new Set(
              prepare.mock.contexts.flatMap((context) =>
                context instanceof RuntimeConnections
                  ? [context.directory]
                  : [],
              ),
            ),
          ];
        }

        function assertSender(directory: string): void {
          const sender = join(directory, connectionId);
          const tokenFile = join(sender, "antnest-runtime");
          expect(lstatSync(directory).isDirectory()).toBe(true);
          expect(lstatSync(directory).mode & 0o777).toBe(0o700);
          expect(lstatSync(sender).isDirectory()).toBe(true);
          expect(lstatSync(sender).mode & 0o777).toBe(0o700);
          expect(lstatSync(tokenFile).isFile()).toBe(true);
          expect(lstatSync(tokenFile).mode & 0o777).toBe(0o600);
          expect(readFileSync(tokenFile, "utf8") === runtimeToken).toBe(true);
        }

        async function start(): Promise<RunningAgentAcpService> {
          const loaded = loadConfig({
            ...testSecurityEnvironment(),
            ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
              process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS ?? "false",
            ANTNEST_ACP_DATABASE_URL: databaseUrl!,
            ANTNEST_ACP_CLIENT_MCP_KEY: key,
            ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: "true",
          });
          // The running service owns this authentication instance. Do not also
          // register it for a second fixture-level close after shutdown.
          const authentication = new RequestAuthentication(
            loaded.authentication.workload,
            new CallerContextVerifier("http://identity.invalid/", () =>
              Promise.resolve(Response.json(testJwks())),
            ),
          );
          return within(
            track(
              startAgentAcpService(
                {
                  ...loaded,
                  listen: { host: "127.0.0.1", port: 0 },
                  controlListen: { host: "127.0.0.1", port: 0 },
                  databaseTimeoutMs: 5000,
                  runTimeoutMs: 15_000,
                  authentication,
                  ...(registrationOrigin === undefined
                    ? {}
                    : {
                        ownerIncarnation: {
                          memberId: "acp-warm-owned",
                          listen: { host: "127.0.0.1", port: 0 },
                          runtimeControllerUrl: registrationOrigin,
                          registrationTimeoutMs: 5000,
                        },
                      }),
                },
                NOOP_TELEMETRY,
                ownershipLost,
              ).then(async (service) => {
                services.push(service);
                void service.failure.then((error) => failures.push(error));
                if (closing) await service.shutdown();
                return service;
              }),
            ),
            "service startup",
            20_000,
          );
        }

        function http(
          service: RunningAgentAcpService,
          path: string,
          init?: RequestInit,
          control = false,
        ) {
          const origin = serviceOrigin(service, control);
          return track(
            (async () => {
              const response = await fetch(origin + path, {
                ...init,
                signal: AbortSignal.any([
                  requestAbort.signal,
                  AbortSignal.timeout(5000),
                ]),
              });
              return {
                status: response.status,
                body: (await response.json()) as unknown,
              };
            })(),
          );
        }

        async function stored(sessionId: string): Promise<StoredRun[]> {
          return (
            await pool.query<StoredRun>(
              `SELECT r.id, r.state, r.terminal_class, r.executor_state,
                  r.tool_effect_state, r.unknown_effect_source, r.stop_reason,
                  r.error_class, r.execution_snapshot,
                  s.organization_id, s.agent_id, s.principal_id,
                  r.execution_owner_registration_id, r.execution_owner_member_id,
                  r.execution_owner_incarnation_id, r.execution_owner_epoch::text
           FROM runs r JOIN acp_sessions s ON s.id = r.session_id
           WHERE r.session_id = $1 ORDER BY r.id`,
              [sessionId],
            )
          ).rows;
        }

        async function exercise(
          service: RunningAgentAcpService,
          expected = {
            configurationRevision: 1,
            model: "test-model",
            modelRequestCount: 1,
          },
        ) {
          const connected = track(
            AcpWireClient.connect(
              serviceOrigin(service).replace("http:", "ws:") +
                `/v${version}/acp`,
              executionIdentity(),
            ).then(async (client) => {
              clients.push(client);
              if (closing) await client.close();
              return client;
            }),
          );
          const client = await within(connected, "ACP connect", 5000);
          await within(
            track(client.initialize(version)),
            "ACP initialize",
            10_000,
          );
          const request = (
            method: string,
            params: Record<string, unknown>,
          ): Promise<WireFrame> =>
            within(track(client.request(method, params)), method, 10_000);
          const created = await request("session/new", {
            cwd: "/workspace",
            mcpServers: [],
          });
          expect(created.error).toBeUndefined();
          const sessionId = created.result?.sessionId;
          expect(typeof sessionId).toBe("string");
          if (typeof sessionId !== "string")
            throw new Error("Missing warm Session ID");
          const text = `warm-v${version}-${boot}`;
          const prompted = await request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text }],
          });
          expect(prompted.error).toBeUndefined();
          await expect
            .poll(async () => (await stored(sessionId))[0]?.state, {
              timeout: 10_000,
            })
            .toBe("completed");
          const rows = await stored(sessionId);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            state: "completed",
            terminal_class: "completed",
            executor_state: "quiescent",
            tool_effect_state: "none",
            unknown_effect_source: null,
            stop_reason: "end_turn",
            error_class: null,
            organization_id: "organization-1",
            agent_id: "agent-1",
            principal_id: "principal-1",
            execution_snapshot: {
              configurationRevision: expected.configurationRevision,
              providerConnectionId: "provider-1",
              runtime: { executionId: runtimeExecutionId, connectionId },
            },
          });
          const messages = await pool.query<{ kind: string; content: unknown }>(
            `SELECT kind, payload->'content' AS content FROM session_messages WHERE run_id = $1
           AND kind IN ('user_message', 'agent_message') ORDER BY sequence`,
            [rows[0]!.id],
          );
          expect(messages.rows).toEqual([
            { kind: "user_message", content: [{ type: "text", text }] },
            { kind: "agent_message", content: [{ type: "text", text: reply }] },
          ]);
          const models = modelRequests.filter(
            (request) => request.boot === boot,
          );
          expect(models).toHaveLength(expected.modelRequestCount);
          const latestModel = models.at(-1)!;
          expect(latestModel).toMatchObject({
            authorized: true,
            model: expected.model,
          });
          expect(JSON.stringify(latestModel.messages)).toContain(text);
          const runtimes = runtimeRequests.filter(
            (request) => request.boot === boot,
          );
          expect(runtimes.length).toBeGreaterThan(0);
          expect(
            runtimes.every(
              (request) =>
                request.authorized &&
                request.executionId === runtimeExecutionId,
            ),
          ).toBe(true);
          expect(resourceReads).toContain(boot);
          if (ownership === "owned") {
            const registered = registrations.at(-1)!;
            expect(registered).toBeDefined();
            expect(rows[0]!.execution_owner_registration_id).toBe(
              registered.registration_id,
            );
            expect(rows[0]).toMatchObject({
              execution_owner_registration_id: registered.registration_id,
              execution_owner_member_id: registered.member_id,
              execution_owner_incarnation_id: registered.incarnation_id,
            });
            const lease = (
              await pool.query<{
                owner_instance_id: string;
                epoch: string;
                current: boolean;
              }>(
                "SELECT owner_instance_id,epoch::text,expires_at>clock_timestamp() AS current FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                ["organization-1", "agent-1"],
              )
            ).rows;
            expect(lease).toEqual([
              {
                owner_instance_id: registered.incarnation_id,
                epoch: rows[0]!.execution_owner_epoch,
                current: true,
              },
            ]);
          } else
            expect(rows[0]).toMatchObject({
              execution_owner_registration_id: null,
              execution_owner_member_id: null,
              execution_owner_incarnation_id: null,
              execution_owner_epoch: null,
            });
          await client.close();
          return { sessionId, rows };
        }

        const handler = createMcpHandler(
          () => {
            const server = new McpServer({
              name: "warm-runtime-peer",
              version: "1.0.0",
            });
            server.registerResource(
              "runtime-info",
              "antnest://runtime/info",
              { mimeType: "application/json" },
              (uri) => {
                resourceReads.push(boot);
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
                        execution_id: runtimeExecutionId,
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
                description: "Unused warm-admission fixture Tool",
                inputSchema: z.object({ text: z.string() }),
              },
              () => {
                throw new Error("Warm admission must not execute a Tool");
              },
            );
            return server;
          },
          { legacy: "reject" },
        );

        try {
          await pool.query("DROP SCHEMA public CASCADE");
          await pool.query("CREATE SCHEMA public");
          if (ownership === "owned") {
            // This peer supplies only registration. Prompt, persistence, warm
            // restoration, provider calls and the probe remain actual service paths.
            const registration = await startPeer(async (request, response) => {
              expect(request.method).toBe("POST");
              expect(request.url).toBe("/internal/acp-incarnations/register");
              const expectedToken = readFileSync(
                join(
                  testSecurityEnvironment().ANTNEST_SERVICE_AUTH_TOKEN_DIR,
                  "runtime-controller",
                ),
                "utf8",
              ).trim();
              expect(
                request.headers["antnest-service-authorization"] ===
                  `Bearer ${expectedToken}`,
              ).toBe(true);
              const input: unknown = JSON.parse(
                (await readBody(request)).toString("utf8"),
              );
              const challenge = parseOwnerProbeRequest({
                ...(input as Record<string, unknown>),
                challenge: randomBytes(32).toString("hex"),
              });
              const ownerProbe = probeListen.mock.contexts.at(-1);
              const address =
                ownerProbe instanceof OwnerProbeServer
                  ? ownerProbe.address()
                  : null;
              if (address === null)
                throw new Error(
                  "Owner probe did not listen before registration",
                );
              const probeResponse = await fetch(
                `http://127.0.0.1:${address.port}/internal/acp-owner/incarnation/probe`,
                {
                  method: "POST",
                  headers: {
                    ...workloadHeaders("runtime-controller"),
                    "content-type": "application/json",
                  },
                  body: JSON.stringify(challenge),
                  signal: AbortSignal.any([
                    requestAbort.signal,
                    AbortSignal.timeout(2000),
                  ]),
                },
              );
              const probeBody: unknown = await probeResponse.json();
              expect(probeResponse.status).toBe(200);
              expect(probeBody).toEqual(challenge);
              const receipt = {
                registration_id: randomUUID(),
                member_id: challenge.member_id,
                incarnation_id: challenge.incarnation_id,
              };
              registrations.push(receipt);
              response
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify(receipt));
            });
            peers.push(registration);
            registrationOrigin = registration.origin;
          }
          // These are real local HTTP peers, not a second Antnest service or a
          // fixture that reconstructs secrets and republishes on every boot.
          const model = await startPeer(async (request, response) => {
            const payload = JSON.parse(
              (await readBody(request)).toString("utf8"),
            ) as { model?: unknown; messages?: unknown };
            const authorized =
              request.headers.authorization === "Bearer " + providerSecret;
            modelRequests.push({
              boot,
              authorized,
              model: payload.model,
              messages: payload.messages,
            });
            if (
              !authorized ||
              request.method !== "POST" ||
              request.url !== "/v1/chat/completions"
            ) {
              response.writeHead(401).end();
              return;
            }
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    message: { role: "assistant", content: reply },
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
          const runtime = await startPeer(async (request, response) => {
            const executionId =
              request.headers["x-antnest-expected-execution-id"];
            const authorized =
              request.headers["antnest-service-authorization"] ===
                "Bearer " + runtimeToken && executionId === runtimeExecutionId;
            runtimeRequests.push({ boot, authorized, executionId });
            if (!authorized) {
              response.writeHead(401).end();
              return;
            }
            const body = await readBody(request);
            const headers = new Headers();
            for (const [name, value] of Object.entries(request.headers)) {
              if (Array.isArray(value))
                for (const item of value) headers.append(name, item);
              else if (value !== undefined) headers.set(name, value);
            }
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
                `http://${request.headers.host}${request.url ?? "/"}`,
                init,
              ),
            );
            response.statusCode = result.status;
            result.headers.forEach((value, name) =>
              response.setHeader(name, value),
            );
            response.end(Buffer.from(await result.arrayBuffer()));
          });
          peers.push(runtime);
          const configuration = executionConfiguration();
          configuration.providers[0]!.base_url = model.origin + "/v1";
          configuration.providers[0]!.credential.secret = providerSecret;
          configuration.agents[0]!.runtime = {
            runtime_revision: "rtv_" + randomBytes(16).toString("hex"),
            runtime_execution_id: runtimeExecutionId,
            mcp_endpoint: runtime.origin + "/mcp",
            connection_id: connectionId,
            credential: { caller: "agent-acp-service", token: runtimeToken },
          };
          const first = await start();
          publicationCount++;
          expect(
            await http(
              first,
              "/rpc/agent-acp/apply-execution-snapshot",
              {
                method: "POST",
                headers: {
                  ...workloadHeaders("agent-controller"),
                  "content-type": "application/json",
                },
                body: JSON.stringify(configuration),
              },
              true,
            ),
          ).toEqual({
            status: 200,
            body: { organization_id: "organization-1", applied_revision: 1 },
          });
          const before = await exercise(first);
          expect(senderDirectories()).toHaveLength(1);
          const firstDirectory = senderDirectories()[0]!;
          assertSender(firstDirectory);
          await first.shutdown();
          expect(existsSync(firstDirectory)).toBe(false);

          boot = "restored";
          const second = await start();
          expect((await http(second, "/status")).status).toBe(200);
          // Capture at readiness, before any ACP request could trigger lazy restore.
          const directoriesAtReadiness = senderDirectories();
          const privateFilesAtReadiness = directoriesAtReadiness
            .filter((directory) => directory !== firstDirectory)
            .map((directory) => {
              const sender = join(directory, connectionId);
              const file = join(sender, "antnest-runtime");
              return (
                existsSync(file) &&
                (lstatSync(directory).mode & 0o777) === 0o700 &&
                (lstatSync(sender).mode & 0o777) === 0o700 &&
                (lstatSync(file).mode & 0o777) === 0o600 &&
                readFileSync(file, "utf8") === runtimeToken
              );
            });
          expect(await stored(before.sessionId)).toEqual(before.rows);
          expect(modelRequests).toHaveLength(1);
          // Deliberately no apply(), control publication or Controller resync here.
          const after = await exercise(second);
          expect(after.sessionId).not.toBe(before.sessionId);
          expect(after.rows[0]!.id).not.toBe(before.rows[0]!.id);
          expect(await stored(before.sessionId)).toEqual(before.rows);
          expect(publicationCount).toBe(1);
          expect(directoriesAtReadiness).toHaveLength(2);
          expect(privateFilesAtReadiness).toEqual([true]);
          const secondDirectory = directoriesAtReadiness.find(
            (directory) => directory !== firstDirectory,
          );
          expect(secondDirectory).toBeDefined();
          if (secondDirectory === undefined)
            throw new Error("Missing restored sender directory");
          assertSender(secondDirectory);
          expect(existsSync(firstDirectory)).toBe(false);
          expect(ownershipLost).not.toHaveBeenCalled();

          // This same warm instance must accept the next real control
          // publication and use it for new work, without replaying either Run.
          expect(modelRequests).toHaveLength(2);
          const replacement = structuredClone(configuration);
          replacement.revision = configuration.revision + 1;
          const replacementModel = "test-model-after-warm-publication";
          replacement.models[0]!.model = replacementModel;
          publicationCount++;
          expect(
            await http(
              second,
              "/rpc/agent-acp/apply-execution-snapshot",
              {
                method: "POST",
                headers: {
                  ...workloadHeaders("agent-controller"),
                  "content-type": "application/json",
                },
                body: JSON.stringify(replacement),
              },
              true,
            ),
          ).toEqual({
            status: 200,
            body: {
              organization_id: configuration.organization_id,
              applied_revision: replacement.revision,
            },
          });
          expect(modelRequests).toHaveLength(2);
          expect(await stored(before.sessionId)).toEqual(before.rows);
          expect(await stored(after.sessionId)).toEqual(after.rows);

          const republished = await exercise(second, {
            configurationRevision: replacement.revision,
            model: replacementModel,
            modelRequestCount: 2,
          });
          expect([before.sessionId, after.sessionId]).not.toContain(
            republished.sessionId,
          );
          expect([before.rows[0]!.id, after.rows[0]!.id]).not.toContain(
            republished.rows[0]!.id,
          );
          expect(modelRequests.map((request) => request.model)).toEqual([
            "test-model",
            "test-model",
            replacementModel,
          ]);
          expect(await stored(before.sessionId)).toEqual(before.rows);
          expect(await stored(after.sessionId)).toEqual(after.rows);
          expect(publicationCount).toBe(2);
          expect(services).toHaveLength(2);
          expect(services[0]).toBe(first);
          expect(services[1]).toBe(second);
          if (ownership === "owned") {
            expect(registrations).toHaveLength(2);
            expect(registrations[0]!.incarnation_id).not.toBe(
              registrations[1]!.incarnation_id,
            );
          }
          assertSender(secondDirectory);
          expect(existsSync(firstDirectory)).toBe(false);
          expect(ownershipLost).not.toHaveBeenCalled();
        } catch (error) {
          failures.push(error);
        } finally {
          closing = true;
          requestAbort.abort(new Error("Warm admission fixture is closing"));
          const settle = async (operation: () => Promise<unknown>) => {
            try {
              await operation();
            } catch (error) {
              failures.push(error);
            }
          };
          await settle(async () => {
            const results = await Promise.allSettled(
              clients.map((client) => client.close()),
            );
            for (const result of results)
              if (result.status === "rejected") failures.push(result.reason);
          });
          for (const service of services.toReversed())
            await settle(() => service.shutdown());
          await Promise.allSettled(pending);
          await settle(() => handler.close());
          for (const peer of peers.toReversed())
            await settle(() => peer.close());
          await settle(() => pool.end());
          const directories = new Set([
            ...senderDirectories(),
            ...close.mock.contexts.flatMap((context) =>
              context instanceof RuntimeConnections ? [context.directory] : [],
            ),
          ]);
          prepare.mockRestore();
          close.mockRestore();
          probeListen.mockRestore();
          for (const directory of directories) {
            if (existsSync(directory))
              failures.push(
                new Error("Owned Runtime sender directory survived shutdown"),
              );
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            "Warm admission or cleanup failed",
          );
      },
      90_000,
    );
  },
);
