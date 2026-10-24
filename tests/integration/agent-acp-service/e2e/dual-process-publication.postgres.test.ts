import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresWorkerLock } from "../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import {
  parseOwnerProbeRequest,
  type OwnerRegistration,
} from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import {
  closedExecutionAgent,
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { runtimeInformation } from "../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
import { identityHeaders } from "../../../../services/agent-acp-service/test/support/fixtures.js";
import {
  testJwks,
  testSecurityEnvironment,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { AcpWireClient, type WireFrame } from "../support/acp-wire-client.js";
import { ProductionAcpChild } from "../support/production-acp-child.js";
import { readBody, startPeer, within } from "../support/production-peers.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const reply = "Two real ACP processes completed their assigned work.";

type FixtureClient = Pick<AcpWireClient, "initialize" | "request" | "close">;

class AcpHttpClient implements FixtureClient {
  public readonly updates: acp.SessionUpdate[] = [];
  private readonly connection: acp.ClientConnection;

  public constructor(
    url: string,
    identity: ReturnType<typeof executionIdentity>,
  ) {
    this.connection = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        this.updates.push(params.update);
      })
      .connect(createHttpStream(url, { headers: identityHeaders(identity) }));
  }

  public async initialize(version: 1 | 2): Promise<WireFrame> {
    if (version !== 1) throw new Error("The HTTP fixture only supports ACP v1");
    const frame = await this.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(frame.error).toBeUndefined();
    return frame;
  }

  public async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<WireFrame> {
    try {
      let result: Record<string, unknown>;
      switch (method) {
        case acp.methods.agent.initialize:
          result = await this.connection.agent.request<Record<string, unknown>>(
            acp.methods.agent.initialize,
            params,
          );
          break;
        case acp.methods.agent.session.new:
          result = await this.connection.agent.request<Record<string, unknown>>(
            acp.methods.agent.session.new,
            params,
          );
          break;
        case acp.methods.agent.session.prompt:
          result = await this.connection.agent.request<Record<string, unknown>>(
            acp.methods.agent.session.prompt,
            params,
          );
          break;
        default:
          throw new Error(`Unsupported HTTP fixture request: ${method}`);
      }
      return { result };
    } catch (error) {
      if (!(error instanceof acp.RequestError)) throw error;
      return {
        error: error.toErrorResponse() as NonNullable<WireFrame["error"]>,
      };
    }
  }

  public async close(): Promise<void> {
    this.connection.close();
    await this.connection.closed;
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No reserved port");
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function refused(port: number): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port });
  let outcome = "pending";
  socket.once("connect", () => {
    outcome = "connected";
    socket.destroy();
  });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    outcome = error.code ?? "unknown";
  });
  socket.setTimeout(2000, () => {
    outcome = "timeout";
    socket.destroy();
  });
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  expect(outcome).toBe("ECONNREFUSED");
}

describe.skipIf(databaseUrl === undefined)(
  "two actual ACP main processes",
  () => {
    it.each([
      { mode: "direct-owner", transport: "websocket", version: 1 },
      { mode: "single-entry", transport: "websocket", version: 1 },
      { mode: "direct-owner", transport: "websocket", version: 2 },
      { mode: "single-entry", transport: "websocket", version: 2 },
      { mode: "direct-owner", transport: "http", version: 1 },
      { mode: "single-entry", transport: "http", version: 1 },
      { mode: "single-entry", transport: "http-state-watch", version: 1 },
      { mode: "single-entry", transport: "http-settlement", version: 1 },
    ] as const)(
      "$mode / $transport / v$version",
      async ({ mode, transport, version }) => {
        const root = mkdtempSync(join(tmpdir(), "acp-dual-main-"));
        const id = randomUUID().replaceAll("-", "");
        const schema = "dual_main_" + id;
        const fixtureUrl = new URL(databaseUrl!);
        fixtureUrl.searchParams.set("options", "-c search_path=" + schema);
        const pool = new Pool({
          connectionString: fixtureUrl.toString(),
          max: 3,
          connectionTimeoutMillis: 5000,
          statement_timeout: 5000,
          query_timeout: 6000,
        });
        const peers: Awaited<ReturnType<typeof startPeer>>[] = [];
        const handlers: ReturnType<typeof createMcpHandler>[] = [];
        const children: ProductionAcpChild[] = [];
        const clients: FixtureClient[] = [];
        const originals: Promise<unknown>[] = [];
        const errors: unknown[] = [];
        const ports: number[] = [];
        const names = ["dual-main-a-" + id, "dual-main-b-" + id];
        const temporary: string[] = [];
        const registrations = new Map<string, OwnerRegistration>();
        const security = testSecurityEnvironment();
        const token = (service: string) =>
          "Bearer " +
          readFileSync(
            join(security.ANTNEST_SERVICE_AUTH_TOKEN_DIR, service),
            "utf8",
          ).trim();
        const tracked = <T>(promise: Promise<T>): Promise<T> => {
          originals.push(promise);
          void promise.catch(() => undefined);
          return promise;
        };
        let closing = false;
        let created = false;
        let businessPassed = false;
        const modelEntered = Promise.withResolvers<void>();
        const releaseModel = Promise.withResolvers<void>();
        const stateWatchAbort = new AbortController();
        let stateWatchResponse: Response | undefined;
        let stateWatchReader:
          ReadableStreamDefaultReader<Uint8Array> | undefined;
        let stateWatchReaderOwned = false;
        let stateWatchReading: Promise<void> | undefined;
        try {
          await pool.query(`CREATE SCHEMA ${schema}`);
          created = true;
          await migrate(pool);
          expect((await pool.query("SELECT * FROM agent_leases")).rows).toEqual(
            [],
          );
          while (ports.length < 8) {
            const port = await availablePort();
            if (!ports.includes(port)) ports.push(port);
          }
          const members = [0, 1].map((i) => ({
            member_id: i === 0 ? "acp-a" : "acp-b",
            origin: `http://127.0.0.1:${ports[i * 4 + 3]!}`,
          }));
          const identity = await startPeer(async (request, response) => {
            expect((await readBody(request)).byteLength).toBe(0);
            expect(request.method).toBe("GET");
            expect(request.url).toBe("/rpc/identity/jwks");
            expect(request.headers["antnest-service-authorization"]).toBe(
              token("identity-service"),
            );
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify(testJwks()));
          });
          peers.push(identity);
          const controller = await startPeer(async (request, response) => {
            expect(request.method).toBe("POST");
            expect(request.url).toBe("/internal/acp-incarnations/register");
            expect(request.headers["antnest-service-authorization"]).toBe(
              token("runtime-controller"),
            );
            const payload = JSON.parse(
              (await readBody(request)).toString("utf8"),
            ) as Record<string, unknown>;
            const challenge = parseOwnerProbeRequest({
              ...payload,
              challenge: randomBytes(32).toString("hex"),
            });
            const index = members.findIndex(
              (member) => member.member_id === challenge.member_id,
            );
            expect(index).toBeGreaterThanOrEqual(0);
            const probe = await fetch(
              `http://127.0.0.1:${ports[index * 4 + 2]!}/internal/acp-owner/incarnation/probe`,
              {
                method: "POST",
                headers: {
                  ...workloadHeaders("runtime-controller"),
                  "content-type": "application/json",
                },
                body: JSON.stringify(challenge),
                signal: AbortSignal.timeout(5000),
              },
            );
            const observed: unknown = await probe.json();
            expect(probe.status).toBe(200);
            expect(observed).toEqual(challenge);
            expect(registrations.has(challenge.member_id)).toBe(false);
            const registration = {
              registration_id: randomUUID(),
              member_id: challenge.member_id,
              incarnation_id: challenge.incarnation_id,
            };
            registrations.set(challenge.member_id, registration);
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify(registration));
          });
          peers.push(controller);
          const modelRequests: Array<{ model?: unknown; messages?: unknown }> =
            [];
          const providerSecret = randomBytes(32).toString("base64url");
          const model = await startPeer(async (request, response) => {
            expect(request.method).toBe("POST");
            expect(request.url).toBe("/v1/chat/completions");
            expect(request.headers.authorization).toBe(
              "Bearer " + providerSecret,
            );
            const payload = JSON.parse(
              (await readBody(request)).toString("utf8"),
            ) as { model?: unknown; messages?: unknown };
            modelRequests.push(payload);
            if (transport === "http-state-watch") {
              modelEntered.resolve();
              await releaseModel.promise;
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
          const configuration = executionConfiguration();
          configuration.providers[0]!.base_url = model.origin + "/v1";
          configuration.providers[0]!.credential.secret = providerSecret;
          configuration.agents.push({
            ...structuredClone(configuration.agents[0]!),
            agent_id: "agent-3",
            runtime: runtimeConfiguration(2),
          });
          const runtimeReads = [0, 0];
          for (const i of [0, 1]) {
            const agent = configuration.agents[i]!;
            const binding = runtimeConfiguration(i + 1);
            const handler = createMcpHandler(
              () => {
                const server = new McpServer({
                  name: "dual-process-runtime",
                  version: "1.0.0",
                });
                server.registerResource(
                  "runtime-info",
                  "antnest://runtime/info",
                  { mimeType: "application/json" },
                  (uri) => {
                    runtimeReads[i]!++;
                    const { executionId, ...information } =
                      runtimeInformation();
                    void executionId;
                    return {
                      contents: [
                        {
                          uri: uri.toString(),
                          mimeType: "application/json",
                          text: JSON.stringify({
                            ...information,
                            execution_id: binding.runtime_execution_id,
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
                    description: "Unused fixture tool",
                    inputSchema: z.object({ text: z.string() }),
                  },
                  () => {
                    throw new Error("Unexpected Runtime Tool dispatch");
                  },
                );
                return server;
              },
              { legacy: "reject" },
            );
            handlers.push(handler);
            const runtime = await startPeer(async (request, response) => {
              expect(request.headers["antnest-service-authorization"]).toBe(
                "Bearer " + binding.credential.token,
              );
              expect(request.headers["x-antnest-expected-execution-id"]).toBe(
                binding.runtime_execution_id,
              );
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
            agent.runtime = {
              ...binding,
              mcp_endpoint: runtime.origin + "/mcp",
            };
            // Independent reference to the contract vectors, without invoking the implementation.
            const hash = createHash("sha256")
              .update(
                JSON.stringify([configuration.organization_id, agent.agent_id]),
                "utf8",
              )
              .digest("hex");
            expect(Number(BigInt("0x" + hash) % 2n)).toBe(i);
          }
          const key = randomBytes(32).toString("base64"),
            cluster = randomUUID();
          const peerTokens = [
            randomBytes(32).toString("base64url"),
            randomBytes(32).toString("base64url"),
          ];
          for (const i of [0, 1]) {
            const directory = join(root, String(i));
            mkdirSync(directory);
            mkdirSync(join(directory, "tokens"));
            const temp = join(directory, "tmp");
            mkdirSync(temp);
            temporary.push(temp);
            writeFileSync(
              join(directory, "members.json"),
              JSON.stringify({ version: 1, cluster_id: cluster, members }),
            );
            writeFileSync(
              join(directory, "callers.json"),
              JSON.stringify({
                [members[1 - i]!.member_id]: [
                  "sha256:" +
                    createHash("sha256")
                      .update(peerTokens[1 - i]!)
                      .digest("hex"),
                ],
              }),
              { mode: 0o600 },
            );
            writeFileSync(
              join(directory, "tokens", members[1 - i]!.member_id),
              peerTokens[i]!,
              { mode: 0o600 },
            );
            const url = new URL(fixtureUrl);
            url.searchParams.set("application_name", names[i]!);
            const environment: NodeJS.ProcessEnv = { ...process.env };
            for (const name of Object.keys(environment))
              if (name.startsWith("ANTNEST_") || name === "NODE_OPTIONS")
                delete environment[name];
            Object.assign(environment, security, {
              ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
                process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS ?? "false",
              TMPDIR: temp,
              ANTNEST_ACP_DATABASE_URL: url.toString(),
              ANTNEST_ACP_CLIENT_MCP_KEY: key,
              ANTNEST_ACP_LISTEN: `127.0.0.1:${ports[i * 4]!}`,
              ANTNEST_ACP_CONTROL_LISTEN: `127.0.0.1:${ports[i * 4 + 1]!}`,
              ANTNEST_ACP_OWNER_MEMBER_ID: members[i]!.member_id,
              ANTNEST_ACP_OWNER_LISTEN: `127.0.0.1:${ports[i * 4 + 2]!}`,
              ANTNEST_ACP_RUNTIME_CONTROLLER_URL: controller.origin,
              ANTNEST_ACP_IDENTITY_URL: identity.origin,
              ANTNEST_ACP_PEER_LISTEN: `127.0.0.1:${ports[i * 4 + 3]!}`,
              ANTNEST_ACP_PEER_MEMBERSHIP_FILE: join(directory, "members.json"),
              ANTNEST_ACP_PEER_CALLERS_FILE: join(directory, "callers.json"),
              ANTNEST_ACP_PEER_TOKEN_DIRECTORY: join(directory, "tokens"),
              ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: "true",
              ANTNEST_ACP_SHUTDOWN_TIMEOUT: "8s",
              OTEL_SDK_DISABLED: "true",
              OTEL_TRACES_EXPORTER: "none",
              OTEL_METRICS_EXPORTER: "none",
            });
            children.push(
              new ProductionAcpChild(
                environment,
                `http://127.0.0.1:${ports[i * 4]!}`,
              ),
            );
          }
          await Promise.all(children.map((child) => tracked(child.ready())));
          expect(registrations.size).toBe(2);
          expect((await pool.query("SELECT * FROM agent_leases")).rows).toEqual(
            [],
          );
          const publication = await fetch(
            `http://127.0.0.1:${ports[1]!}/rpc/agent-acp/apply-execution-snapshot`,
            {
              method: "POST",
              headers: {
                ...workloadHeaders("agent-controller"),
                "content-type": "application/json",
              },
              body: JSON.stringify(configuration),
              signal: AbortSignal.timeout(15_000),
            },
          );
          const published: unknown = await publication.json();
          expect(publication.status).toBe(200);
          expect(published).toMatchObject({ applied_revision: 1 });
          if (transport === "http-state-watch") {
            const agentId = configuration.agents[1]!.agent_id;
            const identity = { ...executionIdentity(), agentId };
            const read = await within(
              tracked(
                fetch(
                  `http://127.0.0.1:${ports[0]!}/rpc/agent-acp/get-agent-execution-state`,
                  {
                    method: "POST",
                    headers: {
                      ...identityHeaders(identity),
                      "content-type": "application/json",
                      connection: "close",
                    },
                    body: "{}",
                    signal: AbortSignal.timeout(5000),
                  },
                ).then(async (response) => ({
                  status: response.status,
                  body: (await response.json()) as unknown,
                })),
              ),
              "non-owner public state read",
              5000,
            );
            expect(read.status).toBe(200);
            expect(read.body).toMatchObject({
              agent_id: agentId,
              access_allowed: true,
              availability: "ready",
              active_session_id: null,
              unavailable_reason: null,
            });
            const owner = registrations.get("acp-b");
            if (owner === undefined)
              throw new Error("Missing B owner registration");
            expect(
              (
                await pool.query(
                  "SELECT owner_instance_id FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                  [configuration.organization_id, agentId],
                )
              ).rows,
            ).toEqual([{ owner_instance_id: owner.incarnation_id }]);

            const openingWatch = tracked(
              fetch(
                `http://127.0.0.1:${ports[0]!}/rpc/agent-acp/watch-agent-execution-state`,
                {
                  method: "POST",
                  headers: {
                    ...identityHeaders(identity),
                    "content-type": "application/json",
                    accept: "text/event-stream",
                    connection: "close",
                  },
                  body: "{}",
                  signal: stateWatchAbort.signal,
                },
              ).then(async (response) => {
                stateWatchResponse = response;
                if (closing || stateWatchAbort.signal.aborted)
                  await response.body?.cancel();
                return response;
              }),
            );
            const watch = await within(
              openingWatch,
              "non-owner public state watch",
              5000,
            );
            expect(watch.status).toBe(200);
            expect(watch.headers.get("content-type")).toContain(
              "text/event-stream",
            );
            if (watch.body === null)
              throw new Error("Missing original state watch body");
            const reader = watch.body.getReader();
            stateWatchReader = reader;
            stateWatchReaderOwned = true;
            void tracked(reader.closed);
            const states: Record<string, unknown>[] = [];
            let normalEof = false;
            stateWatchReading = tracked(
              (async () => {
                const decoder = new TextDecoder("utf-8", { fatal: true });
                let buffer = "";
                try {
                  for (;;) {
                    const next = await reader.read();
                    if (next.done) {
                      stateWatchAbort.signal.throwIfAborted();
                      buffer += decoder.decode();
                      expect(buffer.trim()).toBe("");
                      normalEof = true;
                      return;
                    }
                    buffer += decoder.decode(next.value, { stream: true });
                    buffer = buffer.replaceAll("\r\n", "\n");
                    let boundary = buffer.indexOf("\n\n");
                    while (boundary !== -1) {
                      const frame = buffer.slice(0, boundary);
                      buffer = buffer.slice(boundary + 2);
                      const lines = frame.split("\n");
                      if (
                        !lines.every(
                          (line) => line === "" || line.startsWith(":"),
                        )
                      ) {
                        const events = lines.filter((line) =>
                          line.startsWith("event:"),
                        );
                        const data = lines.filter((line) =>
                          line.startsWith("data:"),
                        );
                        expect(events).toHaveLength(1);
                        expect(events[0]?.slice(6).trim()).toBe(
                          "workspace_state",
                        );
                        expect(data.length).toBeGreaterThan(0);
                        const state: unknown = JSON.parse(
                          data
                            .map((line) => line.slice(5).trimStart())
                            .join("\n"),
                        );
                        if (
                          state === null ||
                          typeof state !== "object" ||
                          Array.isArray(state)
                        )
                          throw new Error("Invalid state watch frame");
                        expect(state).toMatchObject({ agent_id: agentId });
                        states.push(state as Record<string, unknown>);
                      }
                      boundary = buffer.indexOf("\n\n");
                    }
                    if (Buffer.byteLength(buffer) > 65_536)
                      throw new Error(
                        "State watch frame exceeded its test limit",
                      );
                  }
                } finally {
                  reader.releaseLock();
                  stateWatchReaderOwned = false;
                }
              })(),
            );
            const readyState = {
              agent_id: agentId,
              access_allowed: true,
              availability: "ready",
              active_session_id: null,
              unavailable_reason: null,
            };
            await expect
              .poll(() => states.at(-1), { timeout: 5000 })
              .toMatchObject(readyState);

            const client = new AcpHttpClient(
              `http://127.0.0.1:${ports[0]!}/v1/acp`,
              identity,
            );
            clients.push(client);
            await tracked(client.initialize(1));
            const createdSession = await tracked(
              client.request("session/new", {
                cwd: "/workspace",
                mcpServers: [],
              }),
            );
            expect(createdSession.error).toBeUndefined();
            const sessionId = createdSession.result?.sessionId;
            if (typeof sessionId !== "string")
              throw new Error("Missing watched ACP session");
            const prompt = `Complete exactly once while state watch is busy for ${agentId}`;
            let promptSettled = false;
            const running = tracked(
              client.request("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: prompt }],
              }),
            );
            void running.then(
              () => {
                promptSettled = true;
              },
              () => {
                promptSettled = true;
              },
            );
            await within(
              modelEntered.promise,
              "original model request entered",
              5000,
            );
            expect(modelRequests).toHaveLength(1);
            await expect
              .poll(() => states.at(-1), { timeout: 5000 })
              .toMatchObject({
                agent_id: agentId,
                access_allowed: true,
                availability: "busy",
                active_session_id: sessionId,
              });
            expect(promptSettled).toBe(false);
            releaseModel.resolve();
            expect(
              (await within(running, "original watched Prompt", 15_000)).error,
            ).toBeUndefined();
            await expect
              .poll(() => states.at(-1), { timeout: 5000 })
              .toMatchObject(readyState);
            await expect
              .poll(
                () =>
                  client.updates
                    .map((update) =>
                      update.sessionUpdate === "agent_message_chunk" &&
                      update.content.type === "text"
                        ? update.content.text
                        : "",
                    )
                    .join(""),
                { timeout: 5000 },
              )
              .toBe(reply);

            const persisted = await pool.query<{ id: string }>(
              "SELECT id,state,terminal_class,executor_state,tool_effect_state,execution_owner_registration_id,execution_owner_member_id,execution_owner_incarnation_id,execution_owner_epoch::text FROM runs WHERE session_id=$1",
              [sessionId],
            );
            expect(persisted.rows).toHaveLength(1);
            expect(persisted.rows[0]).toMatchObject({
              state: "completed",
              terminal_class: "completed",
              executor_state: "quiescent",
              tool_effect_state: "none",
              execution_owner_registration_id: owner.registration_id,
              execution_owner_member_id: owner.member_id,
              execution_owner_incarnation_id: owner.incarnation_id,
              execution_owner_epoch: "1",
            });
            expect(
              (
                await pool.query(
                  "SELECT kind,payload->'content' AS content FROM session_messages WHERE session_id=$1 AND kind IN ('user_message','agent_message') ORDER BY sequence",
                  [sessionId],
                )
              ).rows,
            ).toEqual([
              {
                kind: "user_message",
                content: [{ type: "text", text: prompt }],
              },
              {
                kind: "agent_message",
                content: [{ type: "text", text: reply }],
              },
            ]);
            const revoked = structuredClone(configuration);
            revoked.revision = 2;
            revoked.agents[1]!.principal_ids = [];
            const revocation = tracked(
              fetch(
                `http://127.0.0.1:${ports[1]!}/rpc/agent-acp/apply-execution-snapshot`,
                {
                  method: "POST",
                  headers: {
                    ...workloadHeaders("agent-controller"),
                    "content-type": "application/json",
                    connection: "close",
                  },
                  body: JSON.stringify(revoked),
                  signal: AbortSignal.timeout(15_000),
                },
              ).then(async (response) => ({
                status: response.status,
                body: (await response.json()) as unknown,
              })),
            );
            const [ack] = await within(
              Promise.all([revocation, stateWatchReading]),
              "revocation ACK and original state watch EOF",
              15_000,
            );
            expect(ack.status).toBe(200);
            expect(ack.body).toMatchObject({ applied_revision: 2 });
            expect(normalEof).toBe(true);
            expect(stateWatchAbort.signal.aborted).toBe(false);
            expect(watch.body.locked).toBe(false);
            expect(states.at(-1)).toMatchObject({
              agent_id: agentId,
              access_allowed: false,
            });
            expect(
              states
                .filter((state) => state.availability === "busy")
                .every((state) => state.active_session_id === sessionId),
            ).toBe(true);
            expect(modelRequests).toHaveLength(1);
            expect(modelRequests[0]?.model).toBe("test-model");
            expect(runtimeReads[1]).toBeGreaterThan(0);
            expect(
              (
                await pool.query("SELECT id FROM runs WHERE agent_id=$1", [
                  agentId,
                ])
              ).rows,
            ).toEqual([{ id: persisted.rows[0]!.id }]);
            expect(
              (
                await pool.query(
                  "SELECT id,state,terminal_class,executor_state,tool_effect_state,execution_owner_registration_id,execution_owner_member_id,execution_owner_incarnation_id,execution_owner_epoch::text FROM runs WHERE session_id=$1",
                  [sessionId],
                )
              ).rows,
            ).toEqual(persisted.rows);
          }
          for (const i of transport === "http-state-watch"
            ? []
            : transport === "http-settlement"
              ? [1]
              : [0, 1]) {
            const agentId = configuration.agents[i]!.agent_id;
            const entryPort =
              ports[
                (transport === "http-settlement"
                  ? i
                  : mode === "single-entry"
                    ? 0
                    : i) * 4
              ]!;
            const identity = { ...executionIdentity(), agentId };
            const connect = async () => {
              const connected =
                transport === "http" || transport === "http-settlement"
                  ? new AcpHttpClient(
                      `http://127.0.0.1:${entryPort}/v1/acp`,
                      identity,
                    )
                  : await AcpWireClient.connect(
                      `ws://127.0.0.1:${entryPort}/v${version}/acp`,
                      identity,
                    );
              clients.push(connected);
              if (closing) await connected.close();
              return connected;
            };
            const client = await within(
              tracked(connect()),
              `real ACP ${transport}`,
              5000,
            );
            await tracked(client.initialize(version));
            const createdSession = await tracked(
              client.request("session/new", {
                cwd: "/workspace",
                mcpServers: [],
              }),
            );
            expect(createdSession.error).toBeUndefined();
            const sessionId = createdSession.result?.sessionId;
            if (typeof sessionId !== "string")
              throw new Error("Missing real ACP session");
            const prompt = `Complete exactly once for ${agentId}`;
            const response = await tracked(
              client.request("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: prompt }],
              }),
            );
            expect(response.error).toBeUndefined();
            if (client instanceof AcpHttpClient) {
              await expect
                .poll(
                  () =>
                    client.updates
                      .map((update) =>
                        update.sessionUpdate === "agent_message_chunk" &&
                        update.content.type === "text"
                          ? update.content.text
                          : "",
                      )
                      .join(""),
                  { timeout: 10_000 },
                )
                .toBe(reply);
            }
            await expect
              .poll(
                async () =>
                  (
                    await pool.query<{ state: string }>(
                      "SELECT state FROM runs WHERE session_id=$1",
                      [sessionId],
                    )
                  ).rows[0]?.state,
                { timeout: 10_000 },
              )
              .toBe("completed");
            const owner = registrations.get(members[i]!.member_id)!;
            const runs = await pool.query(
              "SELECT id,state,terminal_class,executor_state,tool_effect_state,execution_owner_registration_id,execution_owner_member_id,execution_owner_incarnation_id,execution_owner_epoch::text FROM runs WHERE session_id=$1",
              [sessionId],
            );
            expect(runs.rows).toHaveLength(1);
            expect(runs.rows[0]).toMatchObject({
              state: "completed",
              terminal_class: "completed",
              executor_state: "quiescent",
              tool_effect_state: "none",
              execution_owner_registration_id: owner.registration_id,
              execution_owner_member_id: owner.member_id,
              execution_owner_incarnation_id: owner.incarnation_id,
              execution_owner_epoch: "1",
            });
            const messages = (
              await pool.query(
                "SELECT kind,payload->'content' AS content FROM session_messages WHERE session_id=$1 AND kind IN ('user_message','agent_message') ORDER BY sequence",
                [sessionId],
              )
            ).rows;
            expect(messages).toHaveLength(2);
            expect(messages).toEqual(
              expect.arrayContaining([
                {
                  kind: "user_message",
                  content: [{ type: "text", text: prompt }],
                },
                {
                  kind: "agent_message",
                  content: [{ type: "text", text: reply }],
                },
              ]),
            );
            expect(
              (
                await pool.query(
                  "SELECT owner_instance_id,epoch::text,expires_at>clock_timestamp() AS live FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                  [configuration.organization_id, agentId],
                )
              ).rows,
            ).toEqual([
              {
                owner_instance_id: owner.incarnation_id,
                epoch: "1",
                live: true,
              },
            ]);
            await client.close();
          }
          if (transport === "http-settlement") {
            const agentId = configuration.agents[1]!.agent_id;
            const owner = registrations.get("acp-b");
            if (owner === undefined)
              throw new Error("Missing B settlement owner registration");
            const facts = async () => ({
              runs: (
                await pool.query(
                  "SELECT id,session_id,state,terminal_class,executor_state,tool_effect_state,execution_owner_registration_id,execution_owner_member_id,execution_owner_incarnation_id,execution_owner_epoch::text FROM runs ORDER BY id",
                )
              ).rows,
              messages: (
                await pool.query(
                  "SELECT session_id,sequence,kind,payload->'content' AS content FROM session_messages ORDER BY session_id,sequence",
                )
              ).rows,
              stopReceipts: (
                await pool.query(
                  "SELECT receipt_id,registration_id FROM owner_stop_receipts ORDER BY receipt_id",
                )
              ).rows,
              runRecoveries: (
                await pool.query(
                  "SELECT run_id,receipt_id FROM run_owner_recoveries ORDER BY run_id",
                )
              ).rows,
              learningRecoveries: (
                await pool.query(
                  "SELECT task_id,receipt_id FROM learning_owner_recoveries ORDER BY task_id",
                )
              ).rows,
            });
            const original = await facts();
            const originalModels = structuredClone(modelRequests);
            expect(original.runs).toHaveLength(1);
            expect(original.runs[0]).toMatchObject({
              state: "completed",
              executor_state: "quiescent",
              tool_effect_state: "none",
              execution_owner_member_id: "acp-b",
              execution_owner_epoch: "1",
            });
            expect(original.stopReceipts).toEqual([]);
            expect(original.runRecoveries).toEqual([]);
            expect(original.learningRecoveries).toEqual([]);
            expect(originalModels).toHaveLength(1);

            const closed = structuredClone(configuration);
            closed.revision = 2;
            closed.agents[1] = closedExecutionAgent(closed.agents[1]!);
            closed.agents[1].operation_id = randomUUID();
            const publication = await within(
              tracked(
                fetch(
                  `http://127.0.0.1:${ports[1]!}/rpc/agent-acp/apply-execution-snapshot`,
                  {
                    method: "POST",
                    headers: {
                      ...workloadHeaders("agent-controller"),
                      "content-type": "application/json",
                      connection: "close",
                    },
                    body: JSON.stringify(closed),
                    signal: AbortSignal.timeout(15_000),
                  },
                ).then(async (response) => ({
                  status: response.status,
                  body: (await response.json()) as unknown,
                })),
              ),
              "closed B Agent publication",
              15_000,
            );
            expect(publication).toEqual({
              status: 200,
              body: {
                organization_id: configuration.organization_id,
                applied_revision: closed.revision,
              },
            });

            // Expire the actual original lease without changing the original
            // Run, owner identity or durable stop evidence. The production
            // renewal/loss path must retire its original generation.
            expect(
              (
                await pool.query(
                  "UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND agent_id=$2 AND owner_instance_id=$3 AND epoch=1 RETURNING epoch::text",
                  [
                    configuration.organization_id,
                    agentId,
                    owner.incarnation_id,
                  ],
                )
              ).rows,
            ).toEqual([{ epoch: "1" }]);
            await expect
              .poll(
                async () => {
                  const observed = await tracked(
                    fetch(
                      `http://127.0.0.1:${ports[4]!}/rpc/agent-acp/get-agent-execution-state`,
                      {
                        method: "POST",
                        headers: {
                          ...identityHeaders({
                            ...executionIdentity(),
                            agentId,
                          }),
                          "content-type": "application/json",
                          connection: "close",
                        },
                        body: "{}",
                        signal: AbortSignal.timeout(2000),
                      },
                    ).then(async (response) => {
                      await response.arrayBuffer();
                      return response.status;
                    }),
                  );
                  return observed;
                },
                { timeout: 15_000, interval: 100 },
              )
              .toBe(503);
            expect(
              (
                await pool.query(
                  "SELECT owner_instance_id,epoch::text,expires_at>clock_timestamp() AS live FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                  [configuration.organization_id, agentId],
                )
              ).rows,
            ).toEqual([
              {
                owner_instance_id: owner.incarnation_id,
                epoch: "1",
                live: false,
              },
            ]);

            const settlement = await within(
              tracked(
                fetch(
                  `http://127.0.0.1:${ports[1]!}/rpc/agent-acp/settle-agent`,
                  {
                    method: "POST",
                    headers: {
                      ...workloadHeaders("agent-controller"),
                      "content-type": "application/json",
                      connection: "close",
                    },
                    body: JSON.stringify({
                      organization_id: configuration.organization_id,
                      agent_id: agentId,
                      minimum_revision: closed.revision,
                      operation_id: closed.agents[1].operation_id,
                      mode: "wait",
                      deadline_at: new Date(Date.now() + 8000).toISOString(),
                    }),
                    signal: AbortSignal.timeout(15_000),
                  },
                ).then(async (response) => ({
                  status: response.status,
                  body: (await response.json()) as unknown,
                })),
              ),
              "non-owner settlement after original execution lease expired",
              15_000,
            );
            expect(settlement).toEqual({
              status: 200,
              body: {
                applied_revision: closed.revision,
                outcome: "settled",
              },
            });
            // Exactly the assigned B member acquired and released the next
            // control fence. An ingress A acquisition would consume an epoch.
            expect(
              (
                await pool.query(
                  "SELECT owner_instance_id,epoch::text,expires_at>clock_timestamp() AS live FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                  [configuration.organization_id, agentId],
                )
              ).rows,
            ).toEqual([
              {
                owner_instance_id: owner.incarnation_id,
                epoch: "2",
                live: false,
              },
            ]);
            expect(await facts()).toEqual(original);
            expect(modelRequests).toEqual(originalModels);
            expect(runtimeReads[1]).toBeGreaterThan(0);
          }
          if (
            transport !== "http-state-watch" &&
            transport !== "http-settlement"
          ) {
            expect(modelRequests).toHaveLength(2);
            expect(
              modelRequests.every((request) => request.model === "test-model"),
            ).toBe(true);
            expect(runtimeReads.every((count) => count > 0)).toBe(true);
          }
          businessPassed = true;
        } catch (error) {
          errors.push(error);
        } finally {
          closing = true;
          releaseModel.resolve();
          const collect = async (operations: Promise<unknown>[]) => {
            for (const result of await Promise.allSettled(operations))
              if (result.status === "rejected")
                errors.push(result.reason as unknown);
          };
          const stateWatchCancellation =
            stateWatchReaderOwned && stateWatchReader !== undefined
              ? stateWatchReader.cancel()
              : stateWatchResponse?.body !== null &&
                  stateWatchResponse?.body !== undefined &&
                  !stateWatchResponse.body.locked
                ? stateWatchResponse.body.cancel()
                : undefined;
          stateWatchAbort.abort(new Error("State watch fixture is closing"));
          if (stateWatchCancellation !== undefined)
            await collect([tracked(stateWatchCancellation)]);
          if (stateWatchReading !== undefined)
            await collect([stateWatchReading]);
          await collect(clients.map((client) => client.close()));
          await collect(children.map((child) => child.stop()));
          // Timed-out observations never replace their original operation receipts.
          await Promise.allSettled(originals);
          await collect(clients.map((client) => client.close()));
          try {
            expect(
              (
                await pool.query(
                  "SELECT pid FROM pg_stat_activity WHERE application_name=ANY($1::text[])",
                  [names],
                )
              ).rows,
            ).toEqual([]);
            if (businessPassed)
              expect(
                (
                  await pool.query(
                    "SELECT count(*)::int AS count FROM agent_leases WHERE expires_at>clock_timestamp()",
                  )
                ).rows,
              ).toEqual([{ count: 0 }]);
            const exclusive = await PostgresWorkerLock.acquire(pool);
            await exclusive.release();
            for (const port of ports) await refused(port);
            for (const directory of temporary)
              expect(
                readdirSync(directory).filter((name) =>
                  name.startsWith("antnest-acp-runtime-"),
                ),
              ).toEqual([]);
          } catch (error) {
            errors.push(error);
          }
          await collect([
            ...handlers.map((handler) => handler.close()),
            ...peers.map((peer) => peer.close()),
          ]);
          if (created) {
            try {
              await pool.query(`DROP SCHEMA ${schema} CASCADE`);
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            await pool.end();
          } catch (error) {
            errors.push(error);
          }
          rmSync(root, { recursive: true, force: true });
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length)
          throw new AggregateError(
            errors,
            "Dual-process production acceptance failed",
          );
      },
      120_000,
    );
  },
);
