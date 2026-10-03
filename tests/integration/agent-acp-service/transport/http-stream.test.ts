import { testAuthentication } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { createServer } from "node:http";
import {
  binding,
  identityHeaders,
  sessionConfigurationView,
} from "../../../../services/agent-acp-service/test/support/fixtures.js";
import { v1Configuration } from "../../../../services/agent-acp-service/src/transport/acp/configuration.js";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import { AcpHttpTransport } from "../../../../services/agent-acp-service/src/transport/acp/http-transport.js";
import { SessionOutputStreams } from "../../../../services/agent-acp-service/src/transport/acp/session-output.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import { DomainError } from "../../../../services/agent-acp-service/src/domain/errors.js";
import type { AgentAcpHttpServerOptions } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import type { LearningChangeItem } from "../../../../services/agent-acp-service/src/adapters/postgres/learning-change-read.js";

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
    ready = true,
    limit = 4096,
    notices?: AgentAcpHttpServerOptions["notices"],
    skillCommands?: AgentAcpHttpServerOptions["skillCommands"],
  ) {
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application,
      ready: () => Promise.resolve(ready),
      maxWebSocketPayloadBytes: limit,
      ...(notices === undefined ? {} : { notices }),
      ...(skillCommands === undefined ? {} : { skillCommands }),
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing address");
    url = `http://127.0.0.1:${address.port}/v1/acp`;
  }

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
    const authentication = testAuthentication();
    const listener = createServer((request, response) => {
      void authentication.admit(request).then((admission) => {
        if ("status" in admission) {
          response.writeHead(admission.status);
          response.end();
          return;
        }
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
    expect((await request("POST", "owner", undefined, initialize)).status).toBe(
      503,
    );
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
      code: -32020,
      data: { code: "access_denied" },
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
