import { testAuthentication } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import {
  identityHeaders,
  snapshot,
  sessionConfigurationView,
} from "../../../../services/agent-acp-service/test/support/fixtures.js";
import {
  v1Configuration,
  v2Configuration,
} from "../../../../services/agent-acp-service/src/transport/acp/configuration.js";
import * as acpV1 from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";

import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import {
  withOutputHistory,
  type OutputApplication,
} from "../support/output-application.js";
import type {
  AcpApplicationPort,
  AcceptedAcpRun,
} from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import { DomainError } from "../../../../services/agent-acp-service/src/domain/errors.js";

describe("AgentAcpHttpServer", () => {
  let server: AgentAcpHttpServer | undefined;

  afterEach(async () => {
    await server?.close().catch((error: unknown) => {
      throw new Error("server teardown failed", { cause: error });
    });
  });

  it.each([1, 2] as const)(
    "refuses a new ACP v%s request after context expiry without requesting Run cancellation",
    async (version) => {
      const application = applicationPort();
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application,
        ready: () => Promise.resolve(true),
        maxWebSocketPayloadBytes: 65536,
      });
      await server.listen("127.0.0.1", 0);
      const socket = await openRawWebSocket(server, `/v${version}/acp`);
      try {
        await initializeRaw(socket, version);
        const closed = new Promise<{ code: number; reason: string }>(
          (resolve) =>
            socket.once("close", (code, reason) =>
              resolve({ code, reason: reason.toString() }),
            ),
        );
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120000);
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/list",
            params: {},
          }),
        );
        expect(await closed).toEqual({
          code: 1008,
          reason: "caller_context_expired",
        });
        expect(application.listSessions).not.toHaveBeenCalled();
        expect(application.cancelRun).not.toHaveBeenCalled();
      } finally {
        socket.terminate();
      }
    },
  );

  it.each([1, 2] as const)(
    "preserves opaque identity through ACP v%s WebSocket",
    async (version) => {
      const application = applicationPort();
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application,
        ready: () => Promise.resolve(true),
        maxWebSocketPayloadBytes: 64 * 1024,
      });
      await server.listen("127.0.0.1", 0);
      const identity = {
        organizationId: "org+division@example.org",
        principalId: "owner+team@example.org",
        agentId: "agent/department+1",
      };
      const socket = await openRawWebSocket(
        server,
        `/v${version}/acp`,
        identityHeaders(identity),
      );
      try {
        await initializeRaw(socket, version);
        const frames: Array<Record<string, unknown>> = [];
        socket.on("message", (data) =>
          frames.push(JSON.parse(rawDataText(data)) as Record<string, unknown>),
        );
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd: "/workspace", mcpServers: [] },
          }),
        );
        await vi.waitFor(() =>
          expect(frames.find((frame) => frame.id === 2)).toMatchObject({
            id: 2,
            result: { sessionId: "session-1" },
          }),
        );
        expect(application.createSession).toHaveBeenCalledOnce();
        expect(
          application.createSession.mock.calls[0]?.[0].binding,
        ).toMatchObject(identity);
      } finally {
        socket.close();
      }
    },
  );

  it("authenticates before upgrading and serves the official ACP v2 stream", async () => {
    const application = applicationPort();
    const errors: Array<{ error: unknown; operation: string }> = [];
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application,
      ready: vi.fn(() => Promise.resolve(true)),
      id: sequentialIds(),
      maxWebSocketPayloadBytes: 64 * 1024,
      reportError: (error, operation) => errors.push({ error, operation }),
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no TCP address");
    }
    const client = acpV2.client();
    const connection = client.connect(
      createWebSocketStream<acpV2.AnyWireMessage>(
        `ws://127.0.0.1:${address.port}/v2/acp`,
        {
          WebSocket,
          headers: identityHeaders(),
        },
      ),
    );

    const initialized = await connection.agent
      .request(acpV2.methods.agent.initialize, {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
        capabilities: {},
      })
      .catch(async (error: unknown) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const serverErrors = errors.map(
          ({ error: serverError, operation }) => ({
            operation,
            message:
              serverError instanceof Error
                ? serverError.message
                : String(serverError),
          }),
        );
        throw new Error(
          `initialize request failed; server errors=${JSON.stringify(serverErrors)}`,
          {
            cause: error,
          },
        );
      });
    await connection.initialized.catch((error: unknown) => {
      throw new Error("client initialization barrier failed", { cause: error });
    });
    const created = await connection.agent
      .request(acpV2.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      })
      .catch(async (error: unknown) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const serverErrors = errors.map(
          ({ error: serverError, operation }) => ({
            operation,
            message:
              serverError instanceof Error
                ? serverError.message
                : String(serverError),
          }),
        );
        throw new Error(
          `session request failed; server errors=${JSON.stringify(serverErrors)}`,
          {
            cause: error,
          },
        );
      });

    expect(initialized.protocolVersion).toBe(acpV2.PROTOCOL_VERSION);
    expect(created).toEqual({
      sessionId: "session-1",
      ...v2Configuration(sessionConfigurationView()),
    });
    expect(application.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: {
          connectionId: "id-1",
          organizationId: "organization-1",
          principalId: "principal-1",
          agentId: "agent-1",
        },
      }),
    );
    connection.close();
    await connection.closed.catch((error: unknown) => {
      throw new Error("client connection close failed", { cause: error });
    });
  });

  it("serves the official stable ACP v1 stream on its explicit endpoint", async () => {
    const application = applicationPort();
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application,
      ready: vi.fn(() => Promise.resolve(true)),
      id: sequentialIds(),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no TCP address");
    }
    const connection = acpV1.client().connect(
      createWebSocketStream<acpV1.AnyMessage>(
        `ws://127.0.0.1:${address.port}/v1/acp`,
        {
          WebSocket,
          headers: identityHeaders(),
        },
      ),
    );

    const initialized = await connection.agent.request(
      acpV1.methods.agent.initialize,
      {
        protocolVersion: acpV1.PROTOCOL_VERSION,
        clientCapabilities: {},
      },
    );
    const created = await connection.agent.request(
      acpV1.methods.agent.session.new,
      {
        cwd: "/workspace",
        mcpServers: [],
      },
    );

    expect(initialized.protocolVersion).toBe(acpV1.PROTOCOL_VERSION);
    expect(created).toEqual({
      sessionId: "session-1",
      ...v1Configuration(sessionConfigurationView()),
    });
    expect(application.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: {
          connectionId: "id-1",
          organizationId: "organization-1",
          principalId: "principal-1",
          agentId: "agent-1",
        },
      }),
    );
    connection.close();
    await connection.closed;
  });

  it("rejects new WebSocket connections while the service is not ready", async () => {
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application: applicationPort(),
      ready: vi.fn(() => Promise.resolve(false)),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no TCP address");
    }

    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v2/acp`, {
        headers: identityHeaders(),
      });
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      });
      socket.once("open", () =>
        reject(new Error("not-ready service accepted a WebSocket")),
      );
      socket.once("error", () => undefined);
    });

    expect(status).toBe(503);
  });

  it.each(["/acp", "/v1/acp/", "/v2/acp?debug=true"])(
    "does not expose an unspecified ACP route at %s",
    async (path) => {
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application: applicationPort(),
        ready: vi.fn(() => Promise.resolve(true)),
        maxWebSocketPayloadBytes: 64 * 1024,
      });
      await server.listen("127.0.0.1", 0);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("server has no TCP address");
      }

      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
          headers: identityHeaders(),
        });
        socket.once("unexpected-response", (_request, response) => {
          resolve(response.statusCode ?? 0);
          response.destroy();
        });
        socket.once("open", () =>
          reject(new Error(`${path} unexpectedly accepted a WebSocket`)),
        );
        socket.once("error", () => undefined);
      });

      expect(status).toBe(403);
      await server.close();
      server = undefined;
    },
  );

  it("terminates an open ACP connection during deterministic shutdown", async () => {
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application: applicationPort(),
      ready: vi.fn(() => Promise.resolve(true)),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no TCP address");
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v2/acp`, {
      headers: identityHeaders(),
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );

    await expect(server.close()).resolves.toBeUndefined();
    await closed;
    server = undefined;
  });

  it.each(["/v1/acp", "/v2/acp"])(
    "requires trusted identity before upgrading %s",
    async (path) => {
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application: applicationPort(),
        ready: vi.fn(() => Promise.resolve(true)),
        maxWebSocketPayloadBytes: 64 * 1024,
      });
      await server.listen("127.0.0.1", 0);

      await expect(upgradeStatus(server, path)).resolves.toBe(401);
    },
  );

  it.each([
    ["/v1/acp", 1, "access_denied"],
    ["/v2/acp", 2, "access_denied"],
    ["/v1/acp", 1, "configuration_not_ready"],
    ["/v2/acp", 2, "configuration_not_ready"],
    ["/v1/acp", 1, "agent_unavailable"],
    ["/v2/acp", 2, "agent_unavailable"],
  ] as const)(
    "returns local %s/%s %s through ACP rather than denying the handshake",
    async (path, version, code) => {
      const application = applicationPort();
      application.createSession = vi
        .fn<AcpApplicationPort["createSession"]>()
        .mockRejectedValue(new DomainError(code, "Cannot access Agent"));
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application,
        ready: () => Promise.resolve(true),
        maxWebSocketPayloadBytes: 64 * 1024,
      });
      await server.listen("127.0.0.1", 0);
      const socket = await openRawWebSocket(server, path);
      try {
        await initializeRaw(socket, version);
        await expect(
          sendJsonAndRead(socket, {
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd: "/workspace", mcpServers: [] },
          }),
        ).resolves.toMatchObject({
          id: 2,
          error: { code: -32020, data: { code } },
        });
        expect(socket.readyState).toBe(WebSocket.OPEN);
      } finally {
        socket.close();
      }
    },
  );

  it.each(["/v1/acp", "/v2/acp"])(
    "rejects malformed signed caller context on %s",
    async (path) => {
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application: applicationPort(),
        ready: () => Promise.resolve(true),
        maxWebSocketPayloadBytes: 64 * 1024,
      });
      await server.listen("127.0.0.1", 0);
      await expect(
        upgradeStatus(server, path, {
          ...identityHeaders(),
          "Antnest-Caller-Context": "invalid",
        }),
      ).resolves.toBe(401);
      await expect(
        upgradeStatus(server, path, {
          "x-antnest-agent-access-subject": "subject-1",
        }),
      ).resolves.toBe(401);
    },
  );

  it.each([
    ["/v1/acp", 1],
    ["/v2/acp", 2],
  ] as const)(
    "returns a parse error and keeps %s usable",
    async (path, version) => {
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application: applicationPort(),
        ready: vi.fn(() => Promise.resolve(true)),
        maxWebSocketPayloadBytes: 64 * 1024,
      });
      await server.listen("127.0.0.1", 0);
      const socket = await openRawWebSocket(server, path);

      const parseError = nextJsonFrame(socket);
      socket.send("{");
      await expect(parseError).resolves.toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      await initializeRaw(socket, version);
      socket.close();
    },
  );

  it.each(["/v1/acp", "/v2/acp"])(
    "closes %s when it sends a binary frame",
    async (path) => {
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application: applicationPort(),
        ready: vi.fn(() => Promise.resolve(true)),
        maxWebSocketPayloadBytes: 64 * 1024,
      });
      await server.listen("127.0.0.1", 0);
      const socket = await openRawWebSocket(server, path);
      const closed = new Promise<number>((resolve) => {
        socket.once("close", (code) => resolve(code));
      });

      socket.send(Buffer.from("binary"), { binary: true });

      await expect(closed).resolves.toBe(1003);
    },
  );

  it.each(["/v1/acp", "/v2/acp"])(
    "closes %s when its message exceeds the configured bound",
    async (path) => {
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application: applicationPort(),
        ready: vi.fn(() => Promise.resolve(true)),
        maxWebSocketPayloadBytes: 32,
      });
      await server.listen("127.0.0.1", 0);
      const socket = await openRawWebSocket(server, path);
      const closed = new Promise<number>((resolve) => {
        socket.once("close", (code) => resolve(code));
      });

      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "x".repeat(64) }));

      await expect(closed).resolves.toBe(1009);
    },
  );

  it("rejects every v2 Session request before initialize without entering application code", async () => {
    const application = applicationPort();
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application,
      ready: vi.fn(() => Promise.resolve(true)),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    const socket = await openRawWebSocket(server, "/v2/acp");
    const setup = { sessionId: "session-1", cwd: "/workspace", mcpServers: [] };
    const requests = [
      ["session/new", setup],
      ["session/list", {}],
      ["session/delete", { sessionId: "session-1" }],
      ["session/fork", setup],
      ["session/resume", setup],
      [
        "session/set_config_option",
        {
          sessionId: "session-1",
          configId: "model",
          type: "id",
          value: "primary",
        },
      ],
      ["session/close", { sessionId: "session-1" }],
      [
        "session/prompt",
        { sessionId: "session-1", prompt: [{ type: "text", text: "hi" }] },
      ],
    ] as const;
    try {
      for (const [index, [method, params]] of requests.entries()) {
        const id = index + 10;
        await expect(
          sendJsonAndRead(socket, { jsonrpc: "2.0", id, method, params }),
        ).resolves.toMatchObject({
          jsonrpc: "2.0",
          id,
          error: { code: -32600 },
        });
      }
      for (const method of Object.values(application))
        expect(method).not.toHaveBeenCalled();
      await initializeRaw(socket, 2);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
    }
  });

  it.each([
    ["/v1/acp", 1],
    ["/v2/acp", 2],
  ] as const)(
    "returns method-not-found on %s without closing the connection",
    async (path, version) => {
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application: applicationPort(),
        ready: vi.fn(() => Promise.resolve(true)),
        maxWebSocketPayloadBytes: 64 * 1024,
      });
      await server.listen("127.0.0.1", 0);
      const socket = await openRawWebSocket(server, path);
      await initializeRaw(socket, version);

      for (const [id, method] of [
        [9, "providers/list"],
        [10, "antnest/unsupported"],
      ] as const) {
        await expect(
          sendJsonAndRead(socket, {
            jsonrpc: "2.0",
            id,
            method,
            params: {},
          }),
        ).resolves.toMatchObject({
          jsonrpc: "2.0",
          id,
          error: { code: -32601 },
        });
      }
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    },
  );

  it("serves a mixed v2 request and notification batch", async () => {
    const application = applicationPort();
    application.listSessions = vi.fn<AcpApplicationPort["listSessions"]>(() =>
      Promise.resolve({
        sessions: [{ sessionId: "session-1", cwd: "/workspace" }],
      }),
    );
    const cancelRun = vi.fn<AcpApplicationPort["cancelRun"]>(() =>
      Promise.resolve(),
    );
    application.cancelRun = cancelRun;
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application,
      ready: vi.fn(() => Promise.resolve(true)),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    const socket = await openRawWebSocket(server, "/v2/acp");
    await initializeRaw(socket, 2);

    await expect(
      sendJsonAndRead(socket, [
        {
          jsonrpc: "2.0",
          id: 10,
          method: "session/list",
          params: {},
        },
        {
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: "session-1" },
        },
      ]),
    ).resolves.toEqual([
      {
        jsonrpc: "2.0",
        id: 10,
        result: {
          sessions: [{ sessionId: "session-1", cwd: "/workspace" }],
        },
      },
    ]);
    await vi.waitFor(() => expect(cancelRun).toHaveBeenCalledOnce());
    socket.close();
  });

  it("rejects v2 initialize when it is mixed into a batch", async () => {
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application: applicationPort(),
      ready: vi.fn(() => Promise.resolve(true)),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    const socket = await openRawWebSocket(server, "/v2/acp");

    const response = await sendJsonAndRead(socket, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: acpV2.PROTOCOL_VERSION,
          info: { name: "test-client", version: "1.0.0" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/list",
        params: {},
      },
    ]);

    expect(response).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32600,
          message: "Invalid request",
          data: "ACP v2 initialize must be the only entry in its batch",
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: -32600,
          message: "Invalid request",
          data: "ACP v2 connection must be initialized before 'session/list'",
        },
      },
    ]);
    socket.close();
  });

  it("sends the v2 Prompt acknowledgement before every Run update on the wire", async () => {
    const application: OutputApplication = {
      ...applicationPort(),
      acceptPrompt: vi.fn(() => Promise.resolve(acceptedRun())),
      execute: vi.fn<OutputApplication["execute"]>(async ({ publish }) => {
        await publish({
          kind: "agent_message",
          messageId: "assistant-1",
          content: [{ type: "text", text: "hello" }],
        });
        return {
          terminalClass: "completed",
          executorState: "quiescent",
          toolEffectState: "none",
          stopReason: "end_turn",
        };
      }),
    };
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application: withOutputHistory(application, {
        title: "hi",
        updatedAt: "2026-08-30T00:00:01.000Z",
      }),
      ready: vi.fn(() => Promise.resolve(true)),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    const socket = await openRawWebSocket(server, "/v2/acp");
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: acpV2.PROTOCOL_VERSION,
          info: { name: "test-client", version: "1.0.0" },
        },
      }),
    );
    await nextJsonFrame(socket);

    const frames: unknown[] = [];
    const idle = Promise.withResolvers<void>();
    socket.on("message", (data) => {
      const frame = JSON.parse(rawDataText(data)) as {
        method?: string;
        params?: { update?: { sessionUpdate?: string; state?: string } };
      };
      frames.push(frame);
      if (
        frame.method === "session/update" &&
        frame.params?.update?.sessionUpdate === "state_update" &&
        frame.params.update.state === "idle"
      ) {
        idle.resolve();
      }
    });
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "hi" }],
        },
      }),
    );
    await idle.promise;

    expect(frames[0]).toMatchObject({ jsonrpc: "2.0", id: 2, result: {} });
    expect(
      frames
        .slice(1)
        .map(
          (frame) =>
            (frame as { params: { update: { sessionUpdate: string } } }).params
              .update.sessionUpdate,
        ),
    ).toEqual([
      "user_message",
      "state_update",
      "session_info_update",
      "agent_message",
      "state_update",
    ]);
    socket.close();
  });
});

function applicationPort() {
  return {
    assertAccess: vi.fn<AcpApplicationPort["assertAccess"]>(() =>
      Promise.resolve(),
    ),
    getSessionConfiguration: vi.fn<
      AcpApplicationPort["getSessionConfiguration"]
    >(() => Promise.resolve(sessionConfigurationView())),
    setSessionConfiguration: vi.fn<
      AcpApplicationPort["setSessionConfiguration"]
    >(() => Promise.resolve(sessionConfigurationView())),
    createSession: vi.fn<AcpApplicationPort["createSession"]>(() =>
      Promise.resolve({ sessionId: "session-1" }),
    ),
    listSessions: vi.fn<AcpApplicationPort["listSessions"]>(() =>
      Promise.resolve({ sessions: [] }),
    ),
    deleteSession: vi.fn<AcpApplicationPort["deleteSession"]>(),
    forkSession: vi.fn<AcpApplicationPort["forkSession"]>(),
    resumeSession: vi.fn<AcpApplicationPort["resumeSession"]>(() =>
      Promise.resolve({ replay: [], sequence: 0 }),
    ),
    readSessionOutput: vi.fn<AcpApplicationPort["readSessionOutput"]>(() =>
      Promise.resolve({
        sequence: 0,
        events: [],
        state: { kind: "state", state: "idle" },
      }),
    ),
    closeSession: vi.fn<AcpApplicationPort["closeSession"]>(),
    cancelRun: vi.fn<AcpApplicationPort["cancelRun"]>(),
    acceptPrompt: vi.fn<AcpApplicationPort["acceptPrompt"]>(),
  } satisfies AcpApplicationPort;
}

function sequentialIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}

function serverUrl(server: AgentAcpHttpServer, path: string): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no TCP address");
  }
  return `ws://127.0.0.1:${address.port}${path}`;
}

function upgradeStatus(
  server: AgentAcpHttpServer,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(serverUrl(server, path), { headers });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      response.destroy();
    });
    socket.once("open", () =>
      reject(new Error(`${path} unexpectedly accepted a WebSocket`)),
    );
    socket.once("error", () => undefined);
  });
}

function openRawWebSocket(
  server: AgentAcpHttpServer,
  path: string,
  headers: Record<string, string> = identityHeaders(),
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(serverUrl(server, path), {
      headers,
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextJsonFrame(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData) => {
      socket.off("error", onError);
      try {
        resolve(JSON.parse(rawDataText(data)) as unknown);
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error("invalid JSON frame", { cause: error }),
        );
      }
    };
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

function rawDataText(data: RawData): string {
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  throw new TypeError("unsupported WebSocket text frame");
}

function sendJsonAndRead(socket: WebSocket, frame: unknown): Promise<unknown> {
  const response = nextJsonFrame(socket);
  socket.send(JSON.stringify(frame));
  return response;
}

async function initializeRaw(socket: WebSocket, version: 1 | 2): Promise<void> {
  const params =
    version === 1
      ? { protocolVersion: acpV1.PROTOCOL_VERSION, clientCapabilities: {} }
      : {
          protocolVersion: acpV2.PROTOCOL_VERSION,
          info: { name: "test-client", version: "1.0.0" },
        };
  await sendJsonAndRead(socket, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params,
  });
}

function acceptedRun(): AcceptedAcpRun {
  return {
    outputSequence: 0,
    runId: "run-1",
    requestId: "request-1",
    sessionId: "session-1",
    userMessageId: "user-message-1",
    snapshot: snapshot(),
  };
}
