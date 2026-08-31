import * as acpV1 from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";

import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import type { AcpApplicationPort, AcceptedAcpRun } from "../../src/ports/acp-application.js";
import type { AgentControllerPort } from "../../src/ports/agent-controller.js";

describe("AgentAcpHttpServer", () => {
  let server: AgentAcpHttpServer | undefined;

  afterEach(async () => {
    await server?.close().catch((error: unknown) => {
      throw new Error("server teardown failed", { cause: error });
    });
  });

  it("closes idempotently when startup never reached listen", async () => {
    server = new AgentAcpHttpServer({
      agentController: controllerPort().port,
      application: applicationPort(),
      ready: vi.fn(() => Promise.resolve(true)),
      maxWebSocketPayloadBytes: 64 * 1024,
    });

    await expect(server.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    server = undefined;
  });

  it("authenticates before upgrading and serves the official ACP v2 stream", async () => {
    const controller = controllerPort();
    const errors: Array<{ error: unknown; operation: string }> = [];
    server = new AgentAcpHttpServer({
      agentController: controller.port,
      application: applicationPort(),
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
      createWebSocketStream<acpV2.AnyWireMessage>(`ws://127.0.0.1:${address.port}/v2/acp`, {
        WebSocket,
        headers: { "x-antnest-agent-access-subject": "subject-1" },
      }),
    );

    const initialized = await connection.agent
      .request(acpV2.methods.agent.initialize, {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
        capabilities: {},
      })
      .catch(async (error: unknown) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const serverErrors = errors.map(({ error: serverError, operation }) => ({
          operation,
          message: serverError instanceof Error ? serverError.message : String(serverError),
        }));
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
        const serverErrors = errors.map(({ error: serverError, operation }) => ({
          operation,
          message: serverError instanceof Error ? serverError.message : String(serverError),
        }));
        throw new Error(`session request failed; server errors=${JSON.stringify(serverErrors)}`, {
          cause: error,
        });
      });

    expect(initialized.protocolVersion).toBe(acpV2.PROTOCOL_VERSION);
    expect(created).toEqual({ sessionId: "session-1" });
    expect(controller.resolveAgentAccess).toHaveBeenCalledWith({
      requestId: "id-1",
      agentAccessSubject: "subject-1",
    });
    connection.close();
    await connection.closed.catch((error: unknown) => {
      throw new Error("client connection close failed", { cause: error });
    });
  });

  it("serves the official stable ACP v1 stream on its explicit endpoint", async () => {
    const controller = controllerPort();
    server = new AgentAcpHttpServer({
      agentController: controller.port,
      application: applicationPort(),
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
      createWebSocketStream<acpV1.AnyMessage>(`ws://127.0.0.1:${address.port}/v1/acp`, {
        WebSocket,
        headers: { "x-antnest-agent-access-subject": "subject-1" },
      }),
    );

    const initialized = await connection.agent.request(acpV1.methods.agent.initialize, {
      protocolVersion: acpV1.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const created = await connection.agent.request(acpV1.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });

    expect(initialized.protocolVersion).toBe(acpV1.PROTOCOL_VERSION);
    expect(created).toEqual({ sessionId: "session-1" });
    expect(controller.resolveAgentAccess).toHaveBeenCalledWith({
      requestId: "id-1",
      agentAccessSubject: "subject-1",
    });
    connection.close();
    await connection.closed;
  });

  it("rejects new WebSocket connections while the service is not ready", async () => {
    const controller = controllerPort();
    server = new AgentAcpHttpServer({
      agentController: controller.port,
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
        headers: { "x-antnest-agent-access-subject": "subject-1" },
      });
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      });
      socket.once("open", () => reject(new Error("not-ready service accepted a WebSocket")));
      socket.once("error", () => undefined);
    });

    expect(status).toBe(503);
    expect(controller.resolveAgentAccess).not.toHaveBeenCalled();
  });

  it.each(["/acp", "/v1/acp/", "/v2/acp?debug=true"])(
    "does not expose an unspecified ACP route at %s",
    async (path) => {
      const controller = controllerPort();
      server = new AgentAcpHttpServer({
        agentController: controller.port,
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
          headers: { "x-antnest-agent-access-subject": "subject-1" },
        });
        socket.once("unexpected-response", (_request, response) => {
          resolve(response.statusCode ?? 0);
          response.destroy();
        });
        socket.once("open", () => reject(new Error(`${path} unexpectedly accepted a WebSocket`)));
        socket.once("error", () => undefined);
      });

      expect(status).toBe(404);
      expect(controller.resolveAgentAccess).not.toHaveBeenCalled();
      await server.close();
      server = undefined;
    },
  );

  it("terminates an open ACP connection during deterministic shutdown", async () => {
    server = new AgentAcpHttpServer({
      agentController: controllerPort().port,
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
      headers: { "x-antnest-agent-access-subject": "subject-1" },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    await expect(server.close()).resolves.toBeUndefined();
    await closed;
    server = undefined;
  });

  it.each(["/v1/acp", "/v2/acp"])(
    "requires an access subject before upgrading %s",
    async (path) => {
      const controller = controllerPort();
      server = new AgentAcpHttpServer({
        agentController: controller.port,
        application: applicationPort(),
        ready: vi.fn(() => Promise.resolve(true)),
        maxWebSocketPayloadBytes: 64 * 1024,
      });
      await server.listen("127.0.0.1", 0);

      await expect(upgradeStatus(server, path)).resolves.toBe(401);
      expect(controller.resolveAgentAccess).not.toHaveBeenCalled();
    },
  );

  it.each(["/v1/acp", "/v2/acp"])(
    "rejects an access subject denied by Agent Controller on %s",
    async (path) => {
      const controller = controllerPort();
      controller.resolveAgentAccess.mockRejectedValue(new Error("access denied"));
      server = new AgentAcpHttpServer({
        agentController: controller.port,
        application: applicationPort(),
        ready: vi.fn(() => Promise.resolve(true)),
        maxWebSocketPayloadBytes: 64 * 1024,
      });
      await server.listen("127.0.0.1", 0);

      await expect(
        upgradeStatus(server, path, { "x-antnest-agent-access-subject": "subject-1" }),
      ).resolves.toBe(403);
    },
  );

  it.each([
    ["/v1/acp", 1],
    ["/v2/acp", 2],
  ] as const)("returns a parse error and keeps %s usable", async (path, version) => {
    server = new AgentAcpHttpServer({
      agentController: controllerPort().port,
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
  });

  it("closes an ACP connection that sends a binary frame", async () => {
    server = new AgentAcpHttpServer({
      agentController: controllerPort().port,
      application: applicationPort(),
      ready: vi.fn(() => Promise.resolve(true)),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    const socket = await openRawWebSocket(server, "/v1/acp");
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });

    socket.send(Buffer.from("binary"), { binary: true });

    await expect(closed).resolves.toBe(1003);
  });

  it("closes an ACP connection whose message exceeds the configured bound", async () => {
    server = new AgentAcpHttpServer({
      agentController: controllerPort().port,
      application: applicationPort(),
      ready: vi.fn(() => Promise.resolve(true)),
      maxWebSocketPayloadBytes: 32,
    });
    await server.listen("127.0.0.1", 0);
    const socket = await openRawWebSocket(server, "/v2/acp");
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });

    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "x".repeat(64) }));

    await expect(closed).resolves.toBe(1009);
  });

  it.each([
    ["/v1/acp", 1],
    ["/v2/acp", 2],
  ] as const)(
    "returns method-not-found on %s without closing the connection",
    async (path, version) => {
      server = new AgentAcpHttpServer({
        agentController: controllerPort().port,
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
    const cancelRun = vi.fn<AcpApplicationPort["cancelRun"]>(() => Promise.resolve());
    application.cancelRun = cancelRun;
    server = new AgentAcpHttpServer({
      agentController: controllerPort().port,
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
      agentController: controllerPort().port,
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
    const application = applicationPort();
    application.acceptPrompt = vi.fn(() => Promise.resolve(acceptedRun()));
    application.executeRun = vi.fn<AcpApplicationPort["executeRun"]>(async ({ publish }) => {
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
    });
    server = new AgentAcpHttpServer({
      agentController: controllerPort().port,
      application,
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
            (frame as { params: { update: { sessionUpdate: string } } }).params.update
              .sessionUpdate,
        ),
    ).toEqual([
      "user_message",
      "session_info_update",
      "state_update",
      "agent_message",
      "state_update",
    ]);
    socket.close();
  });
});

function controllerPort() {
  const resolveAgentAccess = vi.fn<AgentControllerPort["resolveAgentAccess"]>(() =>
    Promise.resolve({
      principalId: "principal-1",
      agentId: "agent-1",
      accessRevision: "access-1",
      promptCapabilities: { image: true, embeddedContext: true },
    }),
  );
  const port: AgentControllerPort = {
    resolveAgentAccess,
    acquireRun: vi.fn(),
    resolveCredential: vi.fn(),
    finishRun: vi.fn(),
  };
  return { port, resolveAgentAccess };
}

function applicationPort(): AcpApplicationPort {
  return {
    assertAccess: vi.fn(() => Promise.resolve()),
    createSession: vi.fn(() => Promise.resolve({ sessionId: "session-1" })),
    listSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    resumeSession: vi.fn(() => Promise.resolve({ replay: [] })),
    closeSession: vi.fn(),
    cancelRun: vi.fn(),
    acceptPrompt: vi.fn(),
    executeRun: vi.fn(),
  };
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
    socket.once("open", () => reject(new Error(`${path} unexpectedly accepted a WebSocket`)));
    socket.once("error", () => undefined);
  });
}

function openRawWebSocket(server: AgentAcpHttpServer, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(serverUrl(server, path), {
      headers: { "x-antnest-agent-access-subject": "subject-1" },
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
        reject(error instanceof Error ? error : new Error("invalid JSON frame", { cause: error }));
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
    runId: "run-1",
    requestId: "request-1",
    sessionId: "session-1",
    userMessageId: "user-message-1",
    sessionInfoUpdate: {
      title: "hi",
      updatedAt: "2026-08-30T00:00:01.000Z",
    },
    snapshot: {
      admissionId: "admission-1",
      admissionDeadline: new Date("2026-08-30T00:10:00Z"),
      agentConfigRevision: "config-1",
      executionRevision: "execution-1",
      runtimeMcpSourceDigest: "a".repeat(64),
      agentExecutionSpecDigest: "b".repeat(64),
      credentialVersion: "credential-version-1",
      runtime: {
        generation: 1,
        instanceId: "runtime-1",
        executionId: "runtime-execution-1",
        mcpEndpoint: "http://runtime-1:8080/mcp",
      },
      executionSpec: {
        systemPrompt: "system",
        skillInstructions: [],
        model: {
          baseUrl: "https://api.example.test/v1",
          model: "model",
          contextWindow: 32_000,
          maxOutputTokens: 2_048,
          supportsImages: false,
        },
        maxModelRequests: 8,
        credentialRef: "credential-1",
      },
      clientMcpRevisionId: "mcp-1",
    },
  };
}
