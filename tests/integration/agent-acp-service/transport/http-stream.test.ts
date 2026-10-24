import {
  testAuthentication,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import {
  binding,
  identityHeaders,
  sessionConfigurationView,
} from "../../../../services/agent-acp-service/test/support/fixtures.js";
import { v1Configuration } from "../../../../services/agent-acp-service/src/transport/acp/configuration.js";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  context,
  propagation,
  trace,
  SpanStatusCode,
} from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import { configureBoundaries } from "../../../../services/agent-acp-service/src/telemetry/diagnostics.js";

import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import { AcpHttpTransport } from "../../../../services/agent-acp-service/src/transport/acp/http-transport.js";
import { ConnectionCapacity } from "../../../../services/agent-acp-service/src/application/connection-capacity.js";
import { SessionOutputStreams } from "../../../../services/agent-acp-service/src/transport/acp/session-output.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import { DomainError } from "../../../../services/agent-acp-service/src/domain/errors.js";
import type { AgentAcpHttpServerOptions } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import type { LearningChangeItem } from "../../../../services/agent-acp-service/src/adapters/postgres/learning-change-read.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import { CALLER_CONTEXT_HEADER } from "../../../../services/agent-acp-service/src/adapters/caller-context.js";

function headers(principalId = "owner") {
  return identityHeaders({ ...binding(), principalId });
}
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
};
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
beforeAll(() => {
  provider.register({ propagator: new core.W3CTraceContextPropagator() });
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("ACP v1 Streamable HTTP", () => {
  let server: AgentAcpHttpServer | undefined;
  let url: string;
  const connections: acp.ClientConnection[] = [];
  let closeTransport = () => Promise.resolve();
  const application = {
    assertAccess: vi.fn(() => Promise.resolve()),
    getSessionConfiguration: vi.fn(() =>
      Promise.resolve(sessionConfigurationView()),
    ),
    setSessionConfiguration: vi.fn(() =>
      Promise.resolve(sessionConfigurationView()),
    ),
    createSession: vi.fn<AcpApplicationPort["createSession"]>(() =>
      Promise.resolve({ sessionId: "session-1" }),
    ),
    listSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    closeSession: vi.fn(),
    cancelRun: vi.fn(),
    resumeSession: vi.fn<AcpApplicationPort["resumeSession"]>(() =>
      Promise.resolve({ replay: [], sequence: 0 }),
    ),
    readSessionOutput: vi.fn(() =>
      Promise.resolve({
        sequence: 0,
        events: [],
        state: { kind: "state" as const, state: "idle" as const },
      }),
    ),
    acceptPrompt: vi.fn(),
  } satisfies AcpApplicationPort;
  beforeEach(() => {
    exporter.reset();
    vi.clearAllMocks();
    application.createSession
      .mockReset()
      .mockResolvedValue({ sessionId: "session-1" });
  });

  afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close();
    await server?.close();
    const cleanup = closeTransport;
    closeTransport = () => Promise.resolve();
    await cleanup();
  });

  async function start(
    ready: boolean | (() => Promise<boolean>) = true,
    limit = 4096,
    notices?: AgentAcpHttpServerOptions["notices"],
    skillCommands?: AgentAcpHttpServerOptions["skillCommands"],
    outputs?: SessionOutputStreams,
    telemetry?: AgentAcpHttpServerOptions["telemetry"],
  ) {
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application,
      ready: typeof ready === "function" ? ready : () => Promise.resolve(ready),
      maxWebSocketPayloadBytes: limit,
      ...(notices === undefined ? {} : { notices }),
      ...(skillCommands === undefined ? {} : { skillCommands }),
      ...(outputs === undefined ? {} : { outputs }),
      ...(telemetry === undefined ? {} : { telemetry }),
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing address");
    url = `http://127.0.0.1:${address.port}/v1/acp`;
  }

  it("shutdown joins an original control publication without a user identity", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application,
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 4096,
      executionConfiguration: {
        apply: async () => {
          entered.resolve();
          await release.promise;
          return { organization_id: "organization-1", applied_revision: 1 };
        },
      },
    });
    await server.listenControl("127.0.0.1", 0);
    const address = server.controlAddress();
    if (!address || typeof address === "string")
      throw new Error("Missing control address");
    const pending = fetch(
      `http://127.0.0.1:${address.port}/rpc/agent-acp/apply-execution-snapshot`,
      {
        method: "POST",
        headers: {
          ...workloadHeaders("agent-controller"),
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    )
      .then((response) => response.text())
      .catch((error: unknown) => error);
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      await entered.promise;
      closing = server.close().then(() => {
        closed = true;
      });
      await pending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([pending, closing]);
    }
  });

  it("acknowledges the official client's delayed DELETE after server-initiated closure", async () => {
    const ready = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    const deleting = Promise.withResolvers<void>();
    const releaseDelete = Promise.withResolvers<void>();
    const deleted = Promise.withResolvers<{ status: number; body: string }>();
    void deleted.promise.catch(() => undefined);
    let closeRemote: (error: unknown) => void = () => {
      throw new Error("Missing notice subscription");
    };
    await start(
      true,
      4096,
      {
        subscribe: (_binding, _send, close) => {
          closeRemote = close;
          return {
            attach: () => Promise.resolve(),
            detach: () => undefined,
            disconnect: () => undefined,
          };
        },
      },
      undefined,
      undefined,
      {
        ...NOOP_TELEMETRY,
        count: (name, attributes) => {
          if (
            name === "antnest.acp.connections" &&
            attributes.result === "closed"
          )
            retired.resolve();
        },
      },
    );
    let deleteRequest: Promise<Response> | undefined;
    const connection = acp.client().connect(
      createHttpStream(url, {
        headers: headers(),
        fetch: (input, init) => {
          const method =
            init?.method ?? (input instanceof Request ? input.method : "GET");
          const send = async () => {
            if (method === "DELETE") {
              deleting.resolve();
              await releaseDelete.promise;
            }
            const response = await fetch(input, init);
            if (method === "GET" && response.status === 200) ready.resolve();
            if (method === "DELETE")
              deleted.resolve({
                status: response.status,
                body: await response.clone().text(),
              });
            return response;
          };
          const sent = send();
          if (method === "DELETE") {
            deleteRequest = sent;
            void sent.catch(deleted.reject);
          }
          return sent;
        },
      }),
    );
    connections.push(connection);
    try {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { session: { notices: {} } },
      });
      await ready.promise;
      closeRemote(new DomainError("access_denied", "Access revoked"));
      await Promise.all([retired.promise, deleting.promise]);
      releaseDelete.resolve();
      expect(await deleted.promise).toEqual({ status: 202, body: "" });
      expect(application.deleteSession).not.toHaveBeenCalled();
      expect(application.cancelRun).not.toHaveBeenCalled();
    } finally {
      releaseDelete.resolve();
      connection.close();
      await connection.closed;
      if (deleteRequest !== undefined)
        await Promise.allSettled([deleteRequest]);
    }
  });

  it.each([
    [
      "learning-notice",
      () => new DomainError("access_denied", "private-canary"),
      true,
    ],
    [
      "session-output",
      () => new DomainError("access_denied", "private-canary"),
      true,
    ],
    ["learning-notice", () => new Error("private-canary"), false],
    [
      "learning-notice",
      () =>
        new Error("private-canary", {
          cause: new DomainError("access_denied", "private-canary"),
        }),
      false,
    ],
    [
      "learning-notice",
      () =>
        Object.assign(new Error("private-canary"), {
          name: "DomainError",
          code: "access_denied",
        }),
      false,
    ],
    [
      "learning-notice",
      () => new DomainError("session_not_found", "private-canary"),
      false,
    ],
  ] as const)(
    "binds only an original %s access-denial closure to its own live GET (%#)",
    async (source, failure, marked) => {
      const outputs = new SessionOutputStreams();
      const traceIDs = new Set<string>();
      const agentTraceIDs = new Map<string, string>();
      const closeFailures: Array<(error: unknown) => void> = [];
      await start(
        true,
        4096,
        {
          subscribe: (_binding, _send, close) => {
            closeFailures.push(close);
            return {
              attach: () => Promise.resolve(),
              detach: () => undefined,
              disconnect: () => undefined,
            };
          },
        },
        undefined,
        outputs,
      );
      async function connect(agentId: string) {
        const ready = Promise.withResolvers<void>();
        const traceID = randomBytes(16).toString("hex");
        traceIDs.add(traceID);
        agentTraceIDs.set(agentId, traceID);
        const connection = acp.client().connect(
          createHttpStream(url, {
            headers: {
              ...identityHeaders({
                ...binding(),
                principalId: "owner",
                agentId,
              }),
              traceparent: `00-${traceID}-1234567890abcdef-01`,
            },
            fetch: async (input, init) => {
              const response = await fetch(input, init);
              if (
                (init?.method ??
                  (input instanceof Request ? input.method : "GET")) === "GET"
              ) {
                expect(response.status).toBe(200);
                ready.resolve();
              }
              return response;
            },
          }),
        );
        connections.push(connection);
        await connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: { session: { notices: {} } },
        });
        await ready.promise;
        return connection;
      }
      const first = await connect(binding().agentId);
      const other = await connect("other-agent");
      if (source === "session-output") {
        await first.agent.request(acp.methods.agent.session.load, {
          sessionId: "session-1",
          cwd: "/workspace",
          mcpServers: [],
        });
      }
      const gets = () =>
        exporter
          .getFinishedSpans()
          .filter(
            (s) =>
              s.name === "HTTP GET /v1/acp" &&
              traceIDs.has(s.spanContext().traceId),
          );
      const previouslyFinished = new Set(
        gets().map((s) => s.spanContext().spanId),
      );
      if (source === "session-output") {
        application.readSessionOutput.mockRejectedValueOnce(failure());
        outputs.invalidateOrganization(binding().organizationId);
      } else {
        closeFailures[0]!(failure());
        // A second callback must not relabel the first failure, even before the
        // SDK has finalized its underlying HTTP response.
        closeFailures[0]!(
          new DomainError("access_denied", "second-private-canary"),
        );
      }
      const terminated = () =>
        gets().filter(
          (s) =>
            !previouslyFinished.has(s.spanContext().spanId) &&
            s.spanContext().traceId === agentTraceIDs.get(binding().agentId) &&
            s.attributes["http.response.status_code"] === 200,
        );
      await expect.poll(() => terminated().length).toBeGreaterThan(0);
      expect(other.signal.aborted).toBe(false);
      other.close();
      await other.closed;
      await expect
        .poll(() =>
          gets().some(
            (s) => s.spanContext().traceId === agentTraceIDs.get("other-agent"),
          ),
        )
        .toBe(true);
      closeFailures[1]!(
        new DomainError("access_denied", "late-private-canary"),
      );
      await server!.close();
      await expect
        .poll(() =>
          gets().some(
            (s) => s.spanContext().traceId === agentTraceIDs.get("other-agent"),
          ),
        )
        .toBe(true);
      for (const closed of terminated()) {
        expect(closed.status.code).toBe(SpanStatusCode.ERROR);
        expect(closed.attributes).toMatchObject({
          "http.response.status_code": 200,
          "error.type": "stream_interrupted",
          "antnest.outcome": "disconnected",
        });
        expect(
          closed.events.map((e) => ({
            name: e.name,
            attributes: e.attributes,
          })),
        ).toEqual(
          marked
            ? [
                {
                  name: "antnest.stream.termination",
                  attributes: {
                    reason: "access_denied",
                    "error.type": "DomainError",
                    source,
                    "antnest.agent.id": binding().agentId,
                    "antnest.organization.id": binding().organizationId,
                  },
                },
              ]
            : [],
        );
      }
      for (const closed of gets().filter(
        (s) => s.spanContext().traceId === agentTraceIDs.get("other-agent"),
      ))
        expect(closed.events).toEqual([]);
      const spans = exporter
        .getFinishedSpans()
        .filter((s) => traceIDs.has(s.spanContext().traceId));
      expect(
        spans
          .filter((s) => s.name !== "HTTP GET /v1/acp")
          .flatMap((s) => s.events)
          .some((e) => e.name === "antnest.stream.termination"),
      ).toBe(false);
      expect(
        JSON.stringify(
          spans.map((s) => ({ tags: s.attributes, events: s.events })),
        ),
      ).not.toContain("private-canary");
    },
  );

  it("passes Runtime Skill discovery into the real HTTP connection before Session creation", async () => {
    const commands = [
      {
        name: "skill:system:review",
        description: "Review",
        input: { hint: "Task" },
      },
    ];
    const read = vi.fn(() =>
      Promise.resolve({ executionId: "execution-1", commands }),
    );
    await start(true, 4096, undefined, { read });
    const updates: acp.SessionUpdate[] = [];
    const connection = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .connect(createHttpStream(url, { headers: headers() }));
    connections.push(connection);
    const result = await connection.agent.request(
      acp.methods.agent.initialize,
      initialize.params,
    );
    expect(result).toMatchObject({
      _meta: { "antnest.dev/skill-commands": { version: 1, commands } },
    });
    expect(application.createSession).not.toHaveBeenCalled();
    await connection.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    await vi.waitFor(() =>
      expect(updates).toContainEqual({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "help", description: "Show available commands (also /帮助)" },
          ...commands,
        ],
      }),
    );
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: "owner", agentId: "agent-1" }),
      expect.any(AbortSignal),
    );
  });

  it("delivers a committed Skill learning notice through official HTTP SDK notifications", async () => {
    let send:
      | ((sessionId: string, item: LearningChangeItem) => Promise<void>)
      | undefined;
    const attach = vi.fn(() => Promise.resolve());
    await start(true, 4096, {
      subscribe: (_binding, sender) => {
        send = sender;
        return { attach, detach: () => undefined, disconnect: () => undefined };
      },
    });
    const delivered: acp.SessionNotification[] = [];
    const connection = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        delivered.push(params);
      })
      .connect(createHttpStream(url, { headers: headers() }));
    connections.push(connection);
    const initialized = await connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { session: { notices: {} } },
        _meta: {
          "antnest.dev/bridge": {
            intentReceipt: 1,
            targetCancel: 1,
            deliveryMark: 1,
            learningNotices: 1,
          },
        },
      },
    );
    expect(initialized._meta?.["antnest.dev/bridge"]).toMatchObject({
      learningNotices: 1,
    });
    application.resumeSession.mockResolvedValueOnce({
      replay: [],
      sequence: 0,
      appendVersion: 0,
    });
    await connection.agent.request(acp.methods.agent.session.load, {
      sessionId: "session-1",
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(attach).toHaveBeenCalledWith("session-1");
    await send?.("session-1", {
      changeId: "change-1",
      sequence: "1",
      agentId: "agent-1",
      kind: "skill_created",
      occurredAt: "2026-09-29T00:00:00.000Z",
      skillName: "inspect-first",
      changeSummary: "已新增 Skill「inspect-first」",
    });
    await vi.waitFor(() => {
      expect(
        delivered.some(
          (notice) =>
            notice.update.sessionUpdate === "notice" &&
            notice.update.title === "已新增 Skill「inspect-first」",
        ),
      ).toBe(true);
    });
  });

  async function request(
    method: string,
    subject = "owner",
    connectionId?: string,
    body?: unknown,
  ) {
    return fetch(url, {
      method,
      headers: {
        ...headers(subject),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(connectionId ? { "Acp-Connection-Id": connectionId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function open() {
    const response = await request("POST", "owner", undefined, initialize);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { protocolVersion: 1 },
    });
    const id = response.headers.get("Acp-Connection-Id");
    if (!id) throw new Error("Missing connection ID");
    return id;
  }

  async function quotaRejected(response: Response): Promise<void> {
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("1");
    const body: unknown = await response.json();
    expect(body).toStrictEqual({
      code: "connection_quota_exceeded",
      message: "Connection capacity is exhausted",
      retryable: true,
      retry_after_ms: 1000,
    });
  }

  async function startBounded(
    idleTimeoutMs = 300_000,
    overrides: Partial<ConstructorParameters<typeof AcpHttpTransport>[0]> = {},
    admitted?: (request: IncomingMessage) => void,
  ) {
    await start();
    await server?.close();
    const transport = new AcpHttpTransport({
      application,
      outputs: new SessionOutputStreams(),
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 4096,
      capacity: new ConnectionCapacity({
        global: 1,
        organization: 1,
        principal: 1,
      }),
      idleTimeoutMs,
      ...overrides,
    });
    const authentication = testAuthentication();
    const listener = createServer((request, response) => {
      void authentication.admit(request).then((admission) => {
        if ("status" in admission) {
          response.writeHead(admission.status);
          response.end();
          return;
        }
        admitted?.(request);
        return transport.handle(request, response);
      });
    });
    closeTransport = async () => {
      await transport.close();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
        listener.closeAllConnections();
      });
    };
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("Missing address");
    url = `http://127.0.0.1:${address.port}/v1/acp`;
    return transport;
  }

  async function retiringConnection(
    overrides: Partial<ConstructorParameters<typeof AcpHttpTransport>[0]> = {},
    admitted?: (request: IncomingMessage) => void,
  ) {
    const retired = Promise.withResolvers<void>();
    let closeRemote: (error: unknown) => void = () => {
      throw new Error("Missing notice subscription");
    };
    const transport = await startBounded(
      300_000,
      {
        ...overrides,
        notices: {
          subscribe: (_binding, _send, close) => {
            closeRemote = close;
            return {
              attach: () => Promise.resolve(),
              detach: () => undefined,
              disconnect: () => retired.resolve(),
            };
          },
        },
        telemetry: {
          ...NOOP_TELEMETRY,
          count: (name, attributes) => {
            if (
              name === "antnest.acp.connections" &&
              attributes.result === "closed"
            )
              retired.resolve();
          },
        },
      },
      admitted,
    );
    const response = await request("POST", "owner", undefined, {
      ...initialize,
      params: {
        protocolVersion: 1,
        clientCapabilities: { session: { notices: {} } },
      },
    });
    expect(response.status).toBe(200);
    await response.text();
    const id = response.headers.get("acp-connection-id");
    if (!id) throw new Error("Missing connection ID");
    return {
      id,
      transport,
      retire: async () => {
        closeRemote(new DomainError("access_denied", "Access revoked"));
        await retired.promise;
      },
    };
  }

  function holdSdkCleanup(failure = false) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // The spy calls this saved method with its actual receiver via .call(this).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = AcpServer.prototype.close;
    const close = vi
      .spyOn(AcpServer.prototype, "close")
      .mockImplementation(async function (this: AcpServer) {
        // Start the actual SDK cleanup immediately, retaining its original result.
        // Hold its completion at the public API boundary, not the HTTP response.
        const cleanup = original.call(this);
        void cleanup.catch(() => undefined);
        entered.resolve();
        await release.promise;
        await cleanup;
        if (failure) throw new Error("cleanup-private-canary");
      });
    return { entered: entered.promise, release: release.resolve, close };
  }

  function heldDelete(id: string) {
    const completed = Promise.withResolvers<{ status: number; body: string }>();
    void completed.promise.catch(() => undefined);
    const sent = httpRequest(
      url,
      {
        method: "DELETE",
        headers: {
          ...headers(),
          "Acp-Connection-Id": id,
          "Transfer-Encoding": "chunked",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          completed.resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        response.once("error", completed.reject);
      },
    );
    sent.once("error", completed.reject);
    sent.flushHeaders();
    return { sent, completed: completed.promise };
  }

  it("publication revocation joins original HTTP cleanup and retains its DELETE receipt", async () => {
    const transport = await startBounded();
    const id = await open();
    const cleanup = holdSdkCleanup();
    let revocation: Promise<void> | undefined;
    let deletion: Promise<Response> | undefined;
    let joined = false;
    try {
      revocation = transport
        .revokeAccess({ organization_id: binding().organizationId, agents: [] })
        .then(() => {
          joined = true;
        });
      await cleanup.entered;
      deletion = request("DELETE", "owner", id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(joined).toBe(false);
      cleanup.release();
      await revocation;
      const response = await deletion;
      expect(response.status).toBe(202);
      await response.text();
      expect(cleanup.close).toHaveBeenCalledOnce();
    } finally {
      cleanup.release();
      await Promise.allSettled([revocation, deletion]);
      await transport.close();
      cleanup.close.mockRestore();
    }
  });

  it("publication revocation joins the original HTTP handler after its socket closes", async () => {
    const transport = await startBounded();
    const id = await open();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = AcpServer.prototype.handleRequest;
    const handler = vi
      .spyOn(AcpServer.prototype, "handleRequest")
      .mockImplementation(async function (this: AcpServer, incoming: Request) {
        const response = await original.call(this, incoming);
        if (incoming.method === "POST") {
          entered.resolve();
          await release.promise;
        }
        return response;
      });
    const pending = request("POST", "owner", id, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/list",
      params: {},
    })
      .then((response) => response.text())
      .catch((error: unknown) => error);
    let revocation: Promise<void> | undefined;
    let joined = false;
    try {
      await entered.promise;
      revocation = transport
        .revokeAccess({ organization_id: binding().organizationId, agents: [] })
        .then(() => {
          joined = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(joined).toBe(false);
      release.resolve();
      await Promise.all([revocation, pending]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending, revocation]);
      await transport.close();
      handler.mockRestore();
    }
  });

  it("publication revocation joins the original authorized state watch after client disconnect", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const caller = new AbortController();
    let watching: AbortSignal | undefined;
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application,
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 4096,
      executionState: {
        read: vi.fn(),
        watch: async (_identity, _send, signal) => {
          watching = signal;
          entered.resolve();
          await release.promise;
          signal.throwIfAborted();
        },
      },
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing address");
    const pending = fetch(
      `http://127.0.0.1:${address.port}/rpc/agent-acp/watch-agent-execution-state`,
      {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: "{}",
        signal: caller.signal,
      },
    )
      .then((response) => response.text())
      .catch((error: unknown) => error);
    let revocation: Promise<void> | undefined;
    let joined = false;
    try {
      await entered.promise;
      caller.abort();
      await vi.waitFor(() => expect(watching?.aborted).toBe(true));
      revocation = server
        .revokeAccess({ organization_id: binding().organizationId, agents: [] })
        .then(() => {
          joined = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(joined).toBe(false);
      release.resolve();
      await Promise.all([revocation, pending]);
    } finally {
      caller.abort();
      release.resolve();
      await Promise.allSettled([pending, revocation]);
    }
  });

  it("acknowledges the official client's original DELETE during normal shutdown after readiness stops", async () => {
    let serving = true;
    await start(() => Promise.resolve(serving));
    const receiving = Promise.withResolvers<void>();
    const deleting = Promise.withResolvers<void>();
    const deleted = Promise.withResolvers<{ status: number; body: string }>();
    void deleted.promise.catch(() => undefined);
    let attempts = 0;
    let deleteRequest: Promise<Response> | undefined;
    const connection = acp.client().connect(
      createHttpStream(url, {
        headers: headers(),
        fetch: (input, init) => {
          const method =
            init?.method ?? (input instanceof Request ? input.method : "GET");
          const sent = fetch(input, init).then(async (response) => {
            if (method === "GET" && response.status === 200)
              receiving.resolve();
            if (method === "DELETE")
              deleted.resolve({
                status: response.status,
                body: await response.clone().text(),
              });
            return response;
          });
          if (method === "DELETE") {
            attempts++;
            deleteRequest = sent;
            void sent.catch(deleted.reject);
            deleting.resolve();
          }
          return sent;
        },
      }),
    );
    connections.push(connection);
    let stopping: Promise<void> | undefined;
    let cleanup: ReturnType<typeof holdSdkCleanup> | undefined;
    try {
      await connection.agent.request(
        acp.methods.agent.initialize,
        initialize.params,
      );
      await receiving.promise;
      cleanup = holdSdkCleanup();
      serving = false;
      stopping = server!.close();
      expect(server!.close()).toBe(stopping);
      await Promise.all([cleanup.entered, deleting.promise]);
      const rejected = await request("POST", "owner", undefined, initialize);
      expect(rejected.status).toBe(503);
      await rejected.text();
      cleanup.release();
      expect(await deleted.promise).toEqual({ status: 202, body: "" });
      await stopping;
      expect(attempts).toBe(1);
      expect(application.cancelRun).not.toHaveBeenCalled();
      expect(application.deleteSession).not.toHaveBeenCalled();
    } finally {
      cleanup?.release();
      connection.close();
      await connection.closed;
      await Promise.allSettled([deleteRequest, stopping]);
    }
  });

  it.each([false, true])(
    "drain waits for original cleanup before a DELETE response (failure=%s)",
    async (failure) => {
      let serving = true;
      const admitted = Promise.withResolvers<void>();
      const transport = await startBounded(
        300_000,
        { ready: () => Promise.resolve(serving) },
        (incoming) => {
          if (incoming.method === "DELETE") admitted.resolve();
        },
      );
      const id = await open();
      const cleanup = holdSdkCleanup(failure);
      let stopping: Promise<void> | undefined;
      let pending: Promise<{ status: number; body: string }> | undefined;
      let received = false;
      try {
        serving = false;
        stopping = transport.drain(1000);
        expect(transport.drain(1)).toBe(stopping);
        await cleanup.entered;
        pending = request("DELETE", "owner", id).then(async (response) => {
          received = true;
          return { status: response.status, body: await response.text() };
        });
        void pending.catch(() => undefined);
        await admitted.promise;
        const rejected = await request("GET", "owner", id);
        expect(rejected.status).toBe(503);
        await rejected.text();
        expect(received).toBe(false);
        cleanup.release();
        const result = await pending;
        expect(result.status).toBe(failure ? 503 : 202);
        expect(result.body).not.toContain("cleanup-private-canary");
        if (failure) {
          const again = await request("DELETE", "owner", id);
          expect(again.status).toBe(503);
          await again.text();
          await transport.close();
        }
        await stopping;
        expect(cleanup.close).toHaveBeenCalledOnce();
      } finally {
        cleanup.release();
        await transport.close();
        await Promise.allSettled([pending, stopping]);
      }
    },
  );

  it.each(["organizationId", "principalId", "agentId"])(
    "drain preserves workload/CCT admission, %s binding and one original acknowledgement",
    async (field) => {
      let serving = true;
      const transport = await startBounded(300_000, {
        capacity: new ConnectionCapacity({
          global: 2,
          organization: 2,
          principal: 2,
        }),
        ready: () => Promise.resolve(serving),
      });
      const id = await open();
      const other = await open();
      let stopping: Promise<void> | undefined;
      try {
        serving = false;
        stopping = transport.drain(1000);
        const unauthenticated = await fetch(url, {
          method: "DELETE",
          headers: { "Acp-Connection-Id": id },
        });
        expect(unauthenticated.status).toBe(401);
        await unauthenticated.text();
        const noContext = headers();
        delete noContext[CALLER_CONTEXT_HEADER];
        const contextless = await fetch(url, {
          method: "DELETE",
          headers: { ...noContext, "Acp-Connection-Id": id },
        });
        expect(contextless.status).toBe(401);
        await contextless.text();
        const foreign = await fetch(url, {
          method: "DELETE",
          headers: {
            ...identityHeaders({
              ...binding(),
              principalId: "owner",
              [field]: "intruder",
            }),
            "Acp-Connection-Id": id,
          },
        });
        expect(foreign.status).toBe(403);
        await foreign.text();
        for (const [method, connectionId, expected, body] of [
          ["GET", id, 503, undefined],
          ["POST", id, 503, initialize],
          ["POST", undefined, 503, initialize],
          ["DELETE", "unknown-id", 404, undefined],
          ["DELETE", id, 400, { invalid: true }],
          ["DELETE", id, 413, { data: "x".repeat(8192) }],
          ["DELETE", id, 202, undefined],
          ["DELETE", id, 404, undefined],
          ["DELETE", other, 202, undefined],
        ] as const) {
          const response = await request(method, "owner", connectionId, body);
          expect(response.status).toBe(expected);
          await response.text();
        }
        await stopping;
      } finally {
        await transport.close();
        await Promise.allSettled([stopping]);
      }
    },
  );

  it("ordinary not-ready operation cannot acknowledge an old connection", async () => {
    let serving = true;
    await startBounded(300_000, { ready: () => Promise.resolve(serving) });
    const id = await open();
    serving = false;
    const rejected = await request("DELETE", "owner", id);
    expect(rejected.status).toBe(503);
    await rejected.text();
    serving = true;
    const accepted = await request("DELETE", "owner", id);
    expect(accepted.status).toBe(202);
    await accepted.text();
  });

  it.each([
    ["POST", "ready"],
    ["DELETE", "not_ready"],
    ["DELETE", "failure"],
  ] as const)(
    "drain rechecks a %s already waiting for readiness (%s)",
    async (method, readiness) => {
      const ready = Promise.withResolvers<boolean>();
      const entered = Promise.withResolvers<void>();
      let hold = false;
      const transport = await startBounded(300_000, {
        capacity: new ConnectionCapacity({
          global: 2,
          organization: 2,
          principal: 2,
        }),
        ready: () => {
          if (!hold) return Promise.resolve(true);
          entered.resolve();
          return ready.promise;
        },
      });
      const id = await open();
      hold = true;
      const pending = request(
        method,
        "owner",
        method === "DELETE" ? id : undefined,
        method === "POST" ? initialize : undefined,
      );
      void pending.catch(() => undefined);
      let stopping: Promise<void> | undefined;
      try {
        await entered.promise;
        stopping = transport.drain(1000);
        if (readiness === "failure")
          ready.reject(new Error("Readiness read failed"));
        else ready.resolve(readiness === "ready");
        const response = await pending;
        expect(response.status).toBe(method === "POST" ? 503 : 202);
        await response.text();
        if (method === "POST") {
          const acknowledged = await request("DELETE", "owner", id);
          expect(acknowledged.status).toBe(202);
          await acknowledged.text();
        }
        await stopping;
      } finally {
        ready.resolve(false);
        await transport.close();
        await Promise.allSettled([pending, stopping]);
      }
    },
  );

  it("drain deadline aborts a held DELETE body and still joins pending cleanup", async () => {
    const admitted = Promise.withResolvers<void>();
    const transport = await startBounded(300_000, {}, (incoming) => {
      if (incoming.method === "DELETE") admitted.resolve();
    });
    const id = await open();
    const pending = heldDelete(id);
    const cleanup = holdSdkCleanup();
    let stopping: Promise<void> | undefined;
    let stopped = false;
    try {
      await admitted.promise;
      stopping = transport.drain(100).then(() => {
        stopped = true;
      });
      await cleanup.entered;
      await expect(pending.completed).rejects.toThrow();
      expect(stopped).toBe(false);
      cleanup.release();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      cleanup.release();
      pending.sent.destroy();
      await transport.close();
      await Promise.allSettled([pending.completed, stopping]);
    }
  });

  it("drain retains a second admitted body after an ACK until its fixed deadline", async () => {
    const admitted = Promise.withResolvers<void>();
    const transport = await startBounded(300_000, {}, (incoming) => {
      if (incoming.method === "DELETE") admitted.resolve();
    });
    const id = await open();
    const pending = heldDelete(id);
    let stopping: Promise<void> | undefined;
    try {
      await admitted.promise;
      stopping = transport.drain(200);
      const accepted = await request("DELETE", "owner", id);
      expect(accepted.status).toBe(202);
      await accepted.text();
      await expect(pending.completed).rejects.toThrow();
      await stopping;
    } finally {
      pending.sent.destroy();
      await transport.close();
      await Promise.allSettled([pending.completed, stopping]);
    }
  });

  it("drain does not extend an existing retirement deadline", async () => {
    const admitted = Promise.withResolvers<void>();
    const { id, transport, retire } = await retiringConnection(
      { closeReceiptTimeoutMs: 100 },
      (incoming) => {
        if (incoming.method === "DELETE") admitted.resolve();
      },
    );
    const pending = heldDelete(id);
    let stopping: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await admitted.promise;
      await retire();
      stopping = transport.drain(1000);
      const result = await Promise.race([
        pending.completed.then(
          () => "acknowledged",
          () => "aborted",
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("original deadline missed"), 500);
        }),
      ]);
      expect(result).toBe("aborted");
      await stopping;
    } finally {
      clearTimeout(timer);
      pending.sent.destroy();
      await transport.close();
      await Promise.allSettled([pending.completed, stopping]);
    }
  });

  it.each(["organizationId", "principalId", "agentId"])(
    "retains remote cleanup only for its original %s binding",
    async (field) => {
      const { id, retire } = await retiringConnection();
      await retire();
      const foreign = await fetch(url, {
        method: "DELETE",
        headers: {
          ...identityHeaders({
            ...binding(),
            principalId: "owner",
            [field]: "intruder",
          }),
          "Acp-Connection-Id": id,
        },
      });
      expect(foreign.status).toBe(403);
      await foreign.text();
      expect((await request("GET", "owner", id)).status).toBe(404);
      expect((await request("POST", "owner", id, initialize)).status).toBe(404);
      expect((await request("DELETE", "owner", "unknown-id")).status).toBe(404);
      const accepted = await request("DELETE", "owner", id);
      expect(accepted.status).toBe(202);
      expect(await accepted.text()).toBe("");
      expect((await request("DELETE", "owner", id)).status).toBe(404);
      expect(application.deleteSession).not.toHaveBeenCalled();
      expect(application.cancelRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["nonempty", { data: "x" }, 400],
    ["oversized", { data: "x".repeat(8192) }, 413],
  ])(
    "validates a %s DELETE without consuming remote cleanup",
    async (_name, body, status) => {
      const { id, retire } = await retiringConnection();
      await retire();
      const rejected = await request("DELETE", "owner", id, body);
      expect(rejected.status).toBe(status);
      await rejected.text();
      await quotaRejected(
        await request("POST", "owner", undefined, initialize),
      );
      const accepted = await request("DELETE", "owner", id);
      expect(accepted.status).toBe(202);
      await accepted.text();
      await open();
    },
  );

  it("shares cleanup across concurrent DELETE bodies admitted before remote closure", async () => {
    const admitted = Promise.withResolvers<void>();
    let deletes = 0;
    const { id, retire } = await retiringConnection({}, (incoming) => {
      if (incoming.method === "DELETE" && ++deletes === 2) admitted.resolve();
    });
    const first = heldDelete(id);
    const second = heldDelete(id);
    try {
      await admitted.promise;
      await retire();
      first.sent.end();
      second.sent.end();
      expect(await Promise.all([first.completed, second.completed])).toEqual([
        { status: 202, body: "" },
        { status: 202, body: "" },
      ]);
      await open();
    } finally {
      first.sent.destroy();
      second.sent.destroy();
      await Promise.allSettled([first.completed, second.completed]);
    }
  });

  it.each([
    ["nonempty", "x", 400],
    ["oversized", "x".repeat(8192), 413],
  ])(
    "rejects a held %s DELETE when the SDK closes during body validation",
    async (_name, body, status) => {
      const admitted = Promise.withResolvers<void>();
      const { id, retire } = await retiringConnection({}, (incoming) => {
        if (incoming.method === "DELETE") admitted.resolve();
      });
      const pending = heldDelete(id);
      try {
        await admitted.promise;
        await retire();
        pending.sent.end(body);
        expect((await pending.completed).status).toBe(status);
        const accepted = await request("DELETE", "owner", id);
        expect(accepted.status).toBe(202);
        await accepted.text();
      } finally {
        pending.sent.destroy();
        await Promise.allSettled([pending.completed]);
      }
    },
  );

  it.each([false, true])(
    "waits for actual SDK cleanup before DELETE (failure=%s)",
    async (failure) => {
      await startBounded();
      const id = await open();
      const cleanup = holdSdkCleanup(failure);
      let settled = false;
      const pending = request("DELETE", "owner", id).then(async (response) => {
        settled = true;
        return { status: response.status, body: await response.text() };
      });
      try {
        await cleanup.entered;
        expect((await request("GET", "owner", id)).status).toBe(404);
        expect(settled).toBe(false);
        await quotaRejected(
          await request("POST", "owner", undefined, initialize),
        );
        cleanup.release();
        const result = await pending;
        expect(result.status).toBe(failure ? 503 : 202);
        expect(result.body).not.toContain("cleanup-private-canary");
        expect(cleanup.close).toHaveBeenCalledOnce();
        if (failure) {
          expect((await request("DELETE", "owner", id)).status).toBe(503);
          await quotaRejected(
            await request("POST", "owner", undefined, initialize),
          );
        } else await open();
      } finally {
        cleanup.release();
        await Promise.allSettled([pending]);
      }
    },
  );

  it("expires remote cleanup without extending its deadline on rejected DELETE", async () => {
    const { id, retire } = await retiringConnection({
      closeReceiptTimeoutMs: 100,
    });
    await retire();
    await quotaRejected(await request("POST", "owner", undefined, initialize));
    const invalid = async () => {
      const response = await request("DELETE", "owner", id, { invalid: true });
      await response.text();
      return response.status;
    };
    expect(await invalid()).toBe(400);
    await expect.poll(invalid, { interval: 20, timeout: 2000 }).toBe(404);
    await open();
    expect((await request("DELETE", "owner", id)).status).toBe(404);
  });

  it("keeps expired pending cleanup in the capacity limit until it settles", async () => {
    const { id, retire } = await retiringConnection({
      closeReceiptTimeoutMs: 100,
    });
    const cleanup = holdSdkCleanup();
    try {
      await retire();
      await cleanup.entered;
      await expect
        .poll(
          async () => {
            const response = await request("DELETE", "owner", id, {
              invalid: true,
            });
            await response.text();
            return response.status;
          },
          { interval: 20, timeout: 2000 },
        )
        .toBe(404);
      await quotaRejected(
        await request("POST", "owner", undefined, initialize),
      );
      cleanup.release();
      await open();
    } finally {
      cleanup.release();
    }
  });

  it("joins cleanup and aborts an outstanding acknowledgement during shutdown", async () => {
    const { id, retire, transport } = await retiringConnection();
    const cleanup = holdSdkCleanup();
    let pending: Promise<unknown> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      await retire();
      await cleanup.entered;
      pending = request("DELETE", "owner", id).then(async (response) => ({
        status: response.status,
        body: await response.text(),
      }));
      void pending.catch(() => undefined);
      expect((await request("GET", "owner", id)).status).toBe(404);
      let stopped = false;
      stopping = transport.close().then(() => {
        stopped = true;
      });
      expect(
        (await request("POST", "owner", undefined, initialize)).status,
      ).toBe(503);
      expect(stopped).toBe(false);
      cleanup.release();
      await stopping;
      const [result] = await Promise.allSettled([pending]);
      expect(result).not.toEqual({
        status: "fulfilled",
        value: { status: 202, body: "" },
      });
      expect(cleanup.close).toHaveBeenCalledOnce();
    } finally {
      cleanup.release();
      await Promise.allSettled([pending, stopping]);
    }
  });

  it("still owns an admitted DELETE body after a peer acknowledgement when shutdown starts", async () => {
    const admitted = Promise.withResolvers<void>();
    const { id, transport } = await retiringConnection({}, (incoming) => {
      if (incoming.method === "DELETE") admitted.resolve();
    });
    const pending = heldDelete(id);
    try {
      await admitted.promise;
      const accepted = await request("DELETE", "owner", id);
      expect(accepted.status).toBe(202);
      await accepted.text();
      await transport.close();
      pending.sent.end();
      const [result] = await Promise.allSettled([pending.completed]);
      expect(result.status).toBe("rejected");
    } finally {
      pending.sent.destroy();
      await Promise.allSettled([pending.completed]);
    }
  });

  it("keeps an acknowledged peer body bounded until its original retirement deadline", async () => {
    const admitted = Promise.withResolvers<void>();
    const { id } = await retiringConnection(
      { closeReceiptTimeoutMs: 100 },
      (incoming) => {
        if (incoming.method === "DELETE") admitted.resolve();
      },
    );
    const pending = heldDelete(id);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await admitted.promise;
      const accepted = await request("DELETE", "owner", id);
      expect(accepted.status).toBe(202);
      await accepted.text();
      await quotaRejected(
        await request("POST", "owner", undefined, initialize),
      );
      const outcome = pending.completed.then(
        () => "acknowledged",
        () => "aborted",
      );
      expect(
        await Promise.race([
          outcome,
          new Promise<string>((resolve) => {
            timeout = setTimeout(() => resolve("deadline missed"), 2000);
          }),
        ]),
      ).toBe("aborted");
      await open();
    } finally {
      clearTimeout(timeout);
      pending.sent.destroy();
      await Promise.allSettled([pending.completed]);
    }
  });

  it("preserves opaque identity through the official HTTP client", async () => {
    await start();
    const identity = {
      organizationId: "org+division@example.org",
      principalId: "owner+team@example.org",
      agentId: "agent/department+1",
    };
    const connection = acp
      .client()
      .connect(createHttpStream(url, { headers: identityHeaders(identity) }));
    connections.push(connection);
    await connection.agent.request(
      acp.methods.agent.initialize,
      initialize.params,
    );
    await connection.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(application.createSession).toHaveBeenCalledOnce();
    expect(application.createSession.mock.calls[0]?.[0].binding).toMatchObject(
      identity,
    );
  });

  it("bounds retained connections and releases capacity after bad initialization or DELETE", async () => {
    await startBounded();
    const invalid = await request("POST", "owner", undefined, {});
    expect(invalid.status).toBe(400);
    await invalid.text();
    const id = await open();
    await quotaRejected(await request("POST", "owner", undefined, initialize));
    expect((await request("DELETE", "owner", id)).status).toBe(202);
    await open();
  });

  it("keeps active SSE alive but expires abandoned transport state", async () => {
    await startBounded(100);
    const id = await open();
    const abort = new AbortController();
    const stream = await fetch(url, {
      headers: {
        ...headers(),
        "Acp-Connection-Id": id,
        Accept: "text/event-stream",
      },
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await request("GET", "owner", id)).status).toBe(409);
    abort.abort();
    await expect(stream.body?.cancel()).rejects.toMatchObject({
      name: "AbortError",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await request("GET", "owner", id)).status).toBe(404);
    await open();
  });

  it("keeps an existing connection usable after a rejected oversized DELETE", async () => {
    await start();
    const id = await open();
    const rejected = await request("DELETE", "owner", id, {
      data: "x".repeat(8192),
    });
    expect(rejected.status).toBe(413);
    await rejected.text();
    const next = await request("POST", "owner", id, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/list",
      params: {},
    });
    expect(next.status).toBe(202);
    await next.text();
    expect((await request("DELETE", "owner", id)).status).toBe(202);
  });

  it("serves initialize/new/list/load through the official HTTP client", async () => {
    await start();
    const connection = acp
      .client()
      .connect(createHttpStream(url, { headers: headers() }));
    connections.push(connection);
    expect(
      await connection.agent.request(
        acp.methods.agent.initialize,
        initialize.params,
      ),
    ).toMatchObject({ protocolVersion: 1 });
    expect(
      await connection.agent.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      }),
    ).toEqual({
      sessionId: "session-1",
      ...v1Configuration(sessionConfigurationView()),
    });
    expect(
      await connection.agent.request(acp.methods.agent.session.list, {}),
    ).toEqual({
      sessions: [],
    });
    expect(
      await connection.agent.request(acp.methods.agent.session.load, {
        sessionId: "session-1",
        cwd: "/workspace",
        mcpServers: [],
      }),
    ).toEqual(v1Configuration(sessionConfigurationView()));
    expect(application.createSession.mock.calls[0]?.[0].binding).toMatchObject({
      principalId: "owner",
      agentId: "agent-1",
    });
    expect(application.createSession).toHaveBeenCalledOnce();
  });

  it("preserves negotiated Bridge delivery metadata over official HTTP POST and SSE", async () => {
    await start();
    application.resumeSession.mockResolvedValueOnce({
      replay: [
        {
          kind: "agent_message",
          messageId: "answer-1",
          content: [{ type: "text", text: "hello" }],
          delivery: { sequence: 1, runId: "run-1", messageId: "event-1" },
        },
      ],
      sequence: 1,
      appendVersion: 1,
    });
    const marks: unknown[] = [];
    const connection = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const mark = params._meta?.["antnest.dev/delivery"];
        if (mark !== undefined) marks.push(mark);
      })
      .connect(createHttpStream(url, { headers: headers() }));
    connections.push(connection);
    const initialized = await connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        _meta: {
          "antnest.dev/bridge": {
            intentReceipt: 1,
            targetCancel: 1,
            deliveryMark: 1,
          },
        },
      },
    );
    expect(initialized._meta?.["antnest.dev/bridge"]).toEqual({
      intentReceipt: 1,
      targetCancel: 1,
      deliveryMark: 1,
      configurationCas: 1,
    });
    const loaded = await connection.agent.request(
      acp.methods.agent.session.load,
      {
        sessionId: "session-1",
        cwd: "/workspace",
        mcpServers: [],
      },
    );
    expect(loaded._meta?.["antnest.dev/delivery"]).toEqual({
      sealedWatermark: 1,
      appendVersion: 1,
    });
    expect(marks).toContainEqual({
      kind: "part",
      sequence: 1,
      partIndex: 0,
      partCount: 1,
      runId: "run-1",
      messageId: "event-1",
    });
    expect(marks).toContainEqual({ kind: "checkpoint", sequence: 1 });
  });

  it("delivers large text as complete bounded parts through official HTTP SSE", async () => {
    await start();
    const text = "answer-".repeat(20_000);
    application.resumeSession.mockResolvedValueOnce({
      replay: [
        {
          kind: "agent_message",
          messageId: "answer-large",
          content: [{ type: "text", text }],
          delivery: { sequence: 1, runId: "run-1", messageId: "event-large" },
        },
      ],
      sequence: 1,
      appendVersion: 1,
    });
    const notifications: acp.SessionNotification[] = [];
    const connection = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === "agent_message_chunk")
          notifications.push(params);
      })
      .connect(createHttpStream(url, { headers: headers() }));
    connections.push(connection);
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      _meta: {
        "antnest.dev/bridge": {
          intentReceipt: 1,
          targetCancel: 1,
          deliveryMark: 1,
        },
      },
    });
    const loaded = await connection.agent.request(
      acp.methods.agent.session.load,
      {
        sessionId: "session-1",
        cwd: "/workspace",
        mcpServers: [],
      },
    );
    expect(loaded._meta?.["antnest.dev/delivery"]).toMatchObject({
      sealedWatermark: 1,
    });
    await expect.poll(() => notifications.length).toBeGreaterThan(1);
    expect(
      notifications
        .map(({ update }) =>
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text"
            ? update.content.text
            : "",
        )
        .join(""),
    ).toBe(text);
    for (const [partIndex, params] of notifications.entries()) {
      expect(params._meta?.["antnest.dev/delivery"]).toMatchObject({
        kind: "part",
        sequence: 1,
        partIndex,
        partCount: notifications.length,
        runId: "run-1",
        messageId: "event-large",
      });
      expect(Buffer.byteLength(JSON.stringify(params))).toBeLessThan(
        400 * 1024,
      );
    }
  });

  it.each(
    ["POST", "GET", "DELETE"].flatMap((method) =>
      ["organizationId", "principalId", "agentId"].map((field) => ({
        method,
        field,
      })),
    ),
  )(
    "rejects a foreign $field connection ID for $method",
    async ({ method, field }) => {
      await start();
      const id = await open();
      const response = await fetch(url, {
        method,
        headers: {
          ...identityHeaders({
            ...binding(),
            principalId: "owner",
            [field]: "intruder",
          }),
          "Content-Type": "application/json",
          "Acp-Connection-Id": id,
        },
        ...(method === "POST"
          ? {
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "session/list",
                params: {},
              }),
            }
          : {}),
      });
      expect(response.status).toBe(403);
      await response.text();
      expect((await request("DELETE", "owner", id)).status).toBe(202);
    },
  );

  it("returns revoked resource access as an ACP error on an existing connection", async () => {
    await start();
    const connection = acp
      .client()
      .connect(createHttpStream(url, { headers: headers() }));
    connections.push(connection);
    await connection.agent.request(
      acp.methods.agent.initialize,
      initialize.params,
    );
    application.createSession.mockRejectedValueOnce(
      new DomainError("access_denied", "Access revoked"),
    );
    await expect(
      connection.agent.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      code: -32010,
      message: "Agent access is not allowed",
      data: { code: "access_denied", retryable: false },
    });
    expect(
      await connection.agent.request(acp.methods.agent.session.list, {}),
    ).toEqual({
      sessions: [],
    });
  });

  it("DELETE closes only the transport, not persisted sessions or runs", async () => {
    await start();
    const id = await open();
    expect((await request("DELETE", "owner", id)).status).toBe(202);
    expect((await request("GET", "owner", id)).status).toBe(404);
    expect(application.deleteSession).not.toHaveBeenCalled();
    expect(application.cancelRun).not.toHaveBeenCalled();
    await open();
  });

  it("checks process readiness and trusted identity before accepting HTTP", async () => {
    await start(false);
    expect((await request("POST", "owner", undefined, initialize)).status).toBe(
      503,
    );
    expect(application.createSession).not.toHaveBeenCalled();
    await server?.close();
    await start();
    expect((await request("POST", "", undefined, initialize)).status).toBe(401);
    const legacy = await fetch(url, {
      method: "POST",
      headers: {
        "x-antnest-agent-access-subject": "owner",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initialize),
    });
    expect(legacy.status).toBe(401);
  });

  it("bounds request bodies and delegates malformed messages to the SDK", async () => {
    await start(true, 256);
    expect(
      (
        await request("POST", "owner", undefined, {
          ...initialize,
          padding: "x".repeat(300),
        })
      ).status,
    ).toBe(413);
    const malformed = await fetch(url, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    await malformed.text();
    expect((await request("GET")).status).toBe(400);
    expect((await request("PUT")).status).toBe(403);
    await open();
  });
});
