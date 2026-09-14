import { createServer } from "node:http";
import { binding, identityHeaders, sessionConfigurationView } from "../support/fixtures.js";
import { v1Configuration } from "../../src/transport/acp/configuration.js";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import { AcpHttpTransport } from "../../src/transport/acp/http-transport.js";
import { SessionOutputStreams } from "../../src/transport/acp/session-output.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";
import { DomainError } from "../../src/domain/errors.js";

function headers(principalId = "owner") {
  return identityHeaders({ ...binding(), principalId });
}
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
  } satisfies AcpApplicationPort;
  beforeEach(() => {
    vi.clearAllMocks();
    application.createSession.mockReset().mockResolvedValue({ sessionId: "session-1" });
  });

  afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close();
    await server?.close();
    const cleanup = closeTransport;
    closeTransport = () => Promise.resolve();
    await cleanup();
  });

  async function start(ready = true, limit = 4096) {
    server = new AgentAcpHttpServer({
      application,
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
    await connection.agent.request(acp.methods.agent.initialize, initialize.params);
    await connection.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(application.createSession).toHaveBeenCalledOnce();
    expect(application.createSession.mock.calls[0]?.[0].binding).toMatchObject(identity);
  });

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
      headers: { ...headers(), "Acp-Connection-Id": id, Accept: "text/event-stream" },
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

  it("keeps an existing connection usable after a rejected oversized DELETE", async () => {
    await start();
    const id = await open();
    const rejected = await request("DELETE", "owner", id, { data: "x".repeat(8192) });
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
    const connection = acp.client().connect(createHttpStream(url, { headers: headers() }));
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
    expect(application.createSession).toHaveBeenCalledOnce();
  });

  it.each(
    ["POST", "GET", "DELETE"].flatMap((method) =>
      ["organizationId", "principalId", "agentId"].map((field) => ({ method, field })),
    ),
  )("rejects a foreign $field connection ID for $method", async ({ method, field }) => {
    await start();
    const id = await open();
    const response = await fetch(url, {
      method,
      headers: {
        ...identityHeaders({ ...binding(), principalId: "owner", [field]: "intruder" }),
        "Content-Type": "application/json",
        "Acp-Connection-Id": id,
      },
      ...(method === "POST"
        ? { body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/list", params: {} }) }
        : {}),
    });
    expect(response.status).toBe(403);
    await response.text();
    expect((await request("DELETE", "owner", id)).status).toBe(202);
  });

  it("returns revoked resource access as an ACP error on an existing connection", async () => {
    await start();
    const connection = acp.client().connect(createHttpStream(url, { headers: headers() }));
    connections.push(connection);
    await connection.agent.request(acp.methods.agent.initialize, initialize.params);
    application.createSession.mockRejectedValueOnce(
      new DomainError("access_denied", "Access revoked"),
    );
    await expect(
      connection.agent.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      code: -32020,
      data: { code: "access_denied" },
    });
    expect(await connection.agent.request(acp.methods.agent.session.list, {})).toEqual({
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
    expect((await request("POST", "owner", undefined, initialize)).status).toBe(503);
    expect(application.createSession).not.toHaveBeenCalled();
    await server?.close();
    await start();
    expect((await request("POST", "", undefined, initialize)).status).toBe(401);
    const legacy = await fetch(url, {
      method: "POST",
      headers: { "x-antnest-agent-access-subject": "owner", "Content-Type": "application/json" },
      body: JSON.stringify(initialize),
    });
    expect(legacy.status).toBe(401);
  });

  it("bounds request bodies and delegates malformed messages to the SDK", async () => {
    await start(true, 256);
    expect(
      (await request("POST", "owner", undefined, { ...initialize, padding: "x".repeat(300) }))
        .status,
    ).toBe(413);
    const malformed = await fetch(url, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    await malformed.text();
    expect((await request("GET")).status).toBe(400);
    expect((await request("PUT")).status).toBe(405);
    await open();
  });
});
