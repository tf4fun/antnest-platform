import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";
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
    const client = acp.client();
    const connection = client.connect(
      createWebSocketStream<acp.AnyWireMessage>(`ws://127.0.0.1:${address.port}/v2/acp`, {
        WebSocket,
        headers: { "x-antnest-agent-access-subject": "subject-1" },
      }),
    );

    const initialized = await connection.agent
      .request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
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
      .request(acp.methods.agent.session.new, {
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

    expect(initialized.protocolVersion).toBe(acp.PROTOCOL_VERSION);
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

  it.each(["/acp", "/v1/acp"])(
    "does not expose an unversioned or fake ACP compatibility route at %s",
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
