import { createServer } from "node:http";
import { sessionConfigurationView } from "../support/fixtures.js";
import { v1Configuration } from "../../src/transport/acp/configuration.js";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import { AcpHttpTransport } from "../../src/transport/acp/http-transport.js";
import { SessionOutputStreams } from "../../src/transport/acp/session-output.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";
import {
  AgentControllerError,
  type AgentControllerPort,
} from "../../src/ports/agent-controller.js";

const subjectHeader = "x-antnest-agent-access-subject";
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
};

describe("ACP v1 Streamable HTTP", () => {
  let server: AgentAcpHttpServer | undefined;
  let url: string;
  const connections: acp.ClientConnection[] = [];
  let closeTransport = () => Promise.resolve();
  const application = {
    assertAccess: vi.fn(() => Promise.resolve()),
    getSessionConfiguration: vi.fn(() => Promise.resolve(sessionConfigurationView())),
    setSessionConfiguration: vi.fn(() => Promise.resolve(sessionConfigurationView())),
    createSession: vi.fn<AcpApplicationPort["createSession"]>(() =>
      Promise.resolve({ sessionId: "session-1" }),
    ),
    listSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    closeSession: vi.fn(),
    cancelRun: vi.fn(),
    resumeSession: vi.fn(() => Promise.resolve({ replay: [], sequence: 0 })),
    readSessionOutput: vi.fn(() =>
      Promise.resolve({
        sequence: 0,
        events: [],
        state: { kind: "state" as const, state: "idle" as const },
      }),
    ),
    acceptPrompt: vi.fn(),
    executeRun: vi.fn(),
  } satisfies AcpApplicationPort;
  const resolve = vi.fn<AgentControllerPort["resolveAgentAccess"]>();

  afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close();
    await server?.close();
    const cleanup = closeTransport;
    closeTransport = () => Promise.resolve();
    await cleanup();
  });

  async function start(ready = true, limit = 4096) {
    resolve.mockImplementation(({ agentAccessSubject }) =>
      Promise.resolve({
        principalId: agentAccessSubject,
        agentId: "agent-1",
        accessRevision: "revision-1",
        promptCapabilities: { image: true, embeddedContext: true },
      }),
    );
    server = new AgentAcpHttpServer({
      application,
      agentController: {
        resolveAgentAccess: resolve,
        getSessionConfiguration: vi.fn(),
        acquireRun: vi.fn(),
        finishRun: vi.fn(),
        resolveCredential: vi.fn(),
      },
      ready: () => Promise.resolve(ready),
      maxWebSocketPayloadBytes: limit,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    url = `http://127.0.0.1:${address.port}/v1/acp`;
  }

  async function request(method: string, subject = "owner", connectionId?: string, body?: unknown) {
    return fetch(url, {
      method,
      headers: {
        [subjectHeader]: subject,
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
    expect(await response.json()).toMatchObject({ result: { protocolVersion: 1 } });
    const id = response.headers.get("Acp-Connection-Id");
    if (!id) throw new Error("Missing connection ID");
    return id;
  }

  async function startBounded(idleTimeoutMs = 300_000) {
    await start();
    await server?.close();
    const transport = new AcpHttpTransport({
      application,
      outputs: new SessionOutputStreams(),
      agentController: {
        resolveAgentAccess: resolve,
        getSessionConfiguration: vi.fn(),
        acquireRun: vi.fn(),
        finishRun: vi.fn(),
        resolveCredential: vi.fn(),
      },
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 4096,
      maxConnections: 1,
      idleTimeoutMs,
    });
    const listener = createServer((request, response) => {
      void transport.handle(request, response);
    });
    closeTransport = async () => {
      await transport.close();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
        listener.closeAllConnections();
      });
    };
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    url = `http://127.0.0.1:${address.port}/v1/acp`;
  }

  it("bounds retained connections and releases capacity after bad initialization or DELETE", async () => {
    await startBounded();
    const invalid = await request("POST", "owner", undefined, {});
    expect(invalid.status).toBe(400);
    await invalid.text();
    const id = await open();
    expect((await request("POST", "owner", undefined, initialize)).status).toBe(503);
    expect((await request("DELETE", "owner", id)).status).toBe(202);
    await open();
  });

  it("keeps active SSE alive but expires abandoned transport state", async () => {
    await startBounded(100);
    const id = await open();
    const abort = new AbortController();
    const stream = await fetch(url, {
      headers: { [subjectHeader]: "owner", "Acp-Connection-Id": id, Accept: "text/event-stream" },
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await request("GET", "owner", id)).status).toBe(409);
    abort.abort();
    await expect(stream.body?.cancel()).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await request("GET", "owner", id)).status).toBe(404);
    await open();
  });

  it("serves initialize/new/list/load through the official HTTP client", async () => {
    await start();
    const connection = acp
      .client()
      .connect(createHttpStream(url, { headers: { [subjectHeader]: "owner" } }));
    connections.push(connection);
    expect(
      await connection.agent.request(acp.methods.agent.initialize, initialize.params),
    ).toMatchObject({ protocolVersion: 1 });
    expect(
      await connection.agent.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      }),
    ).toEqual({ sessionId: "session-1", ...v1Configuration(sessionConfigurationView()) });
    expect(await connection.agent.request(acp.methods.agent.session.list, {})).toEqual({
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
    expect(resolve.mock.calls.length).toBeGreaterThan(3);
  });

  it.each(["POST", "GET", "DELETE"])("rejects a foreign connection ID for %s", async (method) => {
    await start();
    const id = await open();
    const response = await request(
      method,
      "intruder",
      id,
      method === "POST" ? { jsonrpc: "2.0", id: 2, method: "session/list", params: {} } : undefined,
    );
    expect(response.status).toBe(403);
    await response.text();
    expect((await request("DELETE", "owner", id)).status).toBe(202);
  });

  it("rejects changed access revision and closes its stale connection", async () => {
    await start();
    const id = await open();
    resolve.mockResolvedValue({
      principalId: "owner",
      agentId: "agent-1",
      accessRevision: "revision-2",
      promptCapabilities: { image: true, embeddedContext: true },
    });
    expect((await request("GET", "owner", id)).status).toBe(403);
    expect((await request("GET", "owner", id)).status).toBe(404);
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

  it("checks readiness and subject before accepting HTTP", async () => {
    await start(false);
    expect((await request("POST", "owner", undefined, initialize)).status).toBe(503);
    expect(resolve).not.toHaveBeenCalled();
    await server?.close();
    await start();
    expect((await request("POST", "", undefined, initialize)).status).toBe(401);
    resolve.mockRejectedValue(new AgentControllerError("access_denied", "denied", false));
    expect((await request("POST", "owner", undefined, initialize)).status).toBe(403);
  });

  it("bounds request bodies and delegates malformed messages to the SDK", async () => {
    await start(true, 256);
    expect(
      (await request("POST", "owner", undefined, { ...initialize, padding: "x".repeat(300) }))
        .status,
    ).toBe(413);
    const malformed = await fetch(url, {
      method: "POST",
      headers: { [subjectHeader]: "owner", "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    await malformed.text();
    expect((await request("GET")).status).toBe(400);
    expect((await request("PUT")).status).toBe(405);
    await open();
  });
});
