import { once } from "node:events";
import { request as httpRequest } from "node:http";
import * as acpV1 from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  AgentAcpHttpServer,
  type AgentAcpHttpServerOptions,
} from "../../../../services/agent-acp-service/src/transport/http-server.js";
import type {
  AcpApplicationPort,
  ExecuteRunResult,
} from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import {
  SessionOutputStreams,
  sessionOutputKey,
} from "../../../../services/agent-acp-service/src/transport/acp/session-output.js";
import type { ExecutionIdentity } from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { testAuthentication } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import {
  identityHeaders,
  sessionConfigurationView,
  snapshot,
} from "../../../../services/agent-acp-service/test/support/fixtures.js";

const owner = {
  organizationId: "org-1",
  principalId: "principal-1",
  agentId: "agent-1",
};
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
};
const rejection = {
  code: "connection_quota_exceeded",
  message: "Connection capacity is exhausted",
  retryable: true,
  retry_after_ms: 1000,
};

describe("shared authenticated ACP connection admission", () => {
  let server: AgentAcpHttpServer | undefined;
  let base: string;
  const peers = new Set<WebSocket>();
  const httpOwners = new Map<string, Record<string, string>>();
  const application = applicationPort();

  afterEach(async () => {
    const closePeers = [...peers].map(async (peer) => {
      if (peer.readyState === WebSocket.CLOSED) return;
      const closed = closedPeer(peer);
      peer.resume();
      peer.terminate();
      await closed;
    });
    await Promise.all(closePeers);
    peers.clear();
    for (const [id, headers] of httpOwners) {
      const response = await fetch(base + "/v1/acp", {
        method: "DELETE",
        headers: { ...headers, "Acp-Connection-Id": id },
      });
      await response.text();
    }
    httpOwners.clear();
    await server?.close();
  });

  async function start(
    limits = { global: 1, organization: 1, principal: 1 },
    overrides: Partial<AgentAcpHttpServerOptions> = {},
  ) {
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application,
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 65536,
      connectionLimits: limits,
      ...overrides,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected TCP listener");
    base = `http://127.0.0.1:${address.port}`;
  }

  async function initialHttp(
    identity: ExecutionIdentity = owner,
    overrides: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    const headers = {
      ...identityHeaders(identity),
      ...overrides,
      "Content-Type": "application/json",
    };
    const response = await fetch(base + "/v1/acp", {
      method: "POST",
      headers,
      body: JSON.stringify(initialize),
      ...(signal === undefined ? {} : { signal }),
    });
    const id = response.headers.get("acp-connection-id");
    if (id !== null && response.status === 200) httpOwners.set(id, headers);
    return response;
  }

  function openWebSocket(version: 1 | 2, identity: ExecutionIdentity = owner) {
    const peer = new WebSocket(
      base.replace("http:", "ws:") + `/v${version}/acp`,
      { headers: identityHeaders(identity) },
    );
    peers.add(peer);
    peer.on("error", () => undefined);
    return peer;
  }

  async function admittedWebSocket(
    version: 1 | 2,
    identity: ExecutionIdentity = owner,
  ) {
    const peer = openWebSocket(version, identity);
    await once(peer, "open");
    return peer;
  }

  async function rejectedWebSocket(
    version: 1 | 2,
    identity: ExecutionIdentity = owner,
  ) {
    const peer = openWebSocket(version, identity);
    const result = await new Promise<{
      status: number;
      headers: Headers;
      body: unknown;
    }>((resolve, reject) => {
      peer.once("open", () =>
        reject(new Error("Quota unexpectedly allowed upgrade")),
      );
      peer.once("unexpected-response", (_request, response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          try {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers))
              if (value !== undefined)
                headers.set(
                  name,
                  Array.isArray(value) ? value.join(", ") : value,
                );
            resolve({
              status: response.statusCode!,
              headers,
              body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      peer.once("error", reject);
    });
    const closed =
      peer.readyState === WebSocket.CLOSED
        ? Promise.resolve()
        : closedPeer(peer);
    peer.terminate();
    await closed;
    expect(result.status).toBe(429);
    quotaHeaders(result.headers);
    expect(result.body).toStrictEqual(rejection);
  }

  async function quotaHttp(response: Response) {
    expect(response.status).toBe(429);
    quotaHeaders(response.headers);
    expect(await response.json()).toStrictEqual(rejection);
  }

  it.each(["http", "v1", "v2"] as const)(
    "one %s owner fills the shared HTTP/v1/v2 process quota",
    async (first) => {
      await start();
      if (first === "http") {
        const response = await initialHttp();
        expect(response.status).toBe(200);
        await response.text();
      } else await admittedWebSocket(first === "v1" ? 1 : 2);
      await quotaHttp(
        await initialHttp({
          organizationId: "other-org",
          principalId: "other-principal",
          agentId: "other-agent",
        }),
      );
      await rejectedWebSocket(1, { ...owner, principalId: "other-principal" });
      await rejectedWebSocket(2, { ...owner, agentId: "other-agent" });
      expect(application.createSession).not.toHaveBeenCalled();
      expect(application.acceptPrompt).not.toHaveBeenCalled();
    },
  );

  it("shares a principal across Agents, isolates organizations, and enforces all three layers", async () => {
    await start({ global: 4, organization: 2, principal: 1 });
    const first = await initialHttp();
    expect(first.status).toBe(200);
    await first.text();
    await rejectedWebSocket(1, { ...owner, agentId: "agent-2" });
    await admittedWebSocket(2, { ...owner, principalId: "principal-2" });
    await quotaHttp(
      await initialHttp({ ...owner, principalId: "principal-3" }),
    );
    await admittedWebSocket(1, { ...owner, organizationId: "org-2" });
    await admittedWebSocket(2, {
      ...owner,
      organizationId: "org-2",
      principalId: "principal-2",
    });
    await quotaHttp(await initialHttp({ ...owner, organizationId: "org-3" }));
  });

  it("uses the signed identity instead of raw quota bucket hints", async () => {
    await start({ global: 4, organization: 2, principal: 1 });
    const first = await initialHttp();
    expect(first.status).toBe(200);
    await first.text();
    await quotaHttp(
      await initialHttp(owner, {
        "X-Antnest-Organization-Id": "spoofed-org",
        "X-Antnest-Principal-Id": "spoofed-principal",
      }),
    );
    const other = await initialHttp({ ...owner, principalId: "principal-2" });
    expect(other.status).toBe(200);
    await other.text();
  });

  it("keeps authenticated HTTP GET/POST/DELETE usable at full quota without recharging", async () => {
    await start();
    const first = await initialHttp();
    expect(first.status).toBe(200);
    await first.text();
    const id = first.headers.get("acp-connection-id")!;
    const headers = { ...identityHeaders(owner), "Acp-Connection-Id": id };
    const stream = await fetch(base + "/v1/acp", {
      headers: { ...headers, Accept: "text/event-stream" },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const body = rpcResponse(reader, 2);
    void body.catch(() => undefined);
    try {
      const listed = await fetch(base + "/v1/acp", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/list",
          params: {},
        }),
      });
      expect(listed.status).toBe(202);
      expect(await listed.text()).toBe("");
      expect(await body).toMatchObject({ id: 2, result: { sessions: [] } });
      const foreign = await fetch(base + "/v1/acp", {
        method: "DELETE",
        headers: {
          ...identityHeaders({ ...owner, principalId: "foreign" }),
          "Acp-Connection-Id": id,
        },
      });
      expect(foreign.status).toBe(403);
      await foreign.text();
      await quotaHttp(await initialHttp());
      const deleted = await fetch(base + "/v1/acp", {
        method: "DELETE",
        headers,
      });
      expect(deleted.status).toBe(202);
      await deleted.text();
      await reader.cancel().catch(() => undefined);
      await Promise.allSettled([body]);
      const next = await initialHttp();
      expect(next.status).toBe(200);
      await next.text();
    } finally {
      const deleted = await fetch(base + "/v1/acp", {
        method: "DELETE",
        headers,
      });
      await deleted.text();
      await Promise.allSettled([body]);
    }
  });

  it.each([1, 2] as const)(
    "retains the v%s reservation until the real close handshake finishes",
    async (version) => {
      const upgrade = Object.getOwnPropertyDescriptor(
        WebSocketServer.prototype,
        "handleUpgrade",
      )!.value as WebSocketServer["handleUpgrade"];
      let serverPeer: WebSocket | undefined;
      vi.spyOn(WebSocketServer.prototype, "handleUpgrade").mockImplementation(
        function (this: WebSocketServer, request, socket, head, callback) {
          upgrade.call(
            this,
            request,
            socket,
            head,
            (opened: WebSocket, request) => {
              serverPeer = opened;
              callback(opened, request);
            },
          );
        },
      );
      await start();
      const peer = await admittedWebSocket(version);
      expect(serverPeer).toBeDefined();
      peer.pause();
      const serverClosed = once(serverPeer!, "close");
      serverPeer!.close(1001, "quota close test");
      try {
        await quotaHttp(await initialHttp());
      } finally {
        peer.resume();
        await serverClosed;
      }
      const next = await initialHttp();
      expect(next.status).toBe(200);
      await next.text();
    },
  );

  it.each([1, 2] as const)(
    "retains v%s quota after socket close until a detached raw output read settles",
    async (version) => {
      const outputs = new SessionOutputStreams();
      const disconnected = Promise.withResolvers<void>();
      const disconnect = outputs.disconnect.bind(outputs);
      vi.spyOn(outputs, "disconnect").mockImplementation((id) => {
        disconnect(id);
        disconnected.resolve();
      });
      await start(undefined, { outputs });
      const peer = await admittedWebSocket(version);
      const initialized = await websocketRpc(peer, 1, "initialize", {
        protocolVersion:
          version === 1 ? acpV1.PROTOCOL_VERSION : acpV2.PROTOCOL_VERSION,
        ...(version === 1
          ? { clientCapabilities: {} }
          : { info: { name: "capacity-owner-test", version: "1.0.0" } }),
      });
      expect(initialized.error).toBeUndefined();
      const created = await websocketRpc(peer, 2, "session/new", {
        cwd: "/workspace",
        mcpServers: [],
      });
      expect(created.error).toBeUndefined();
      expect(created.result).toMatchObject({ sessionId: "session-1" });
      const entered = Promise.withResolvers<void>();
      const held =
        Promise.withResolvers<
          Awaited<ReturnType<AcpApplicationPort["readSessionOutput"]>>
        >();
      application.readSessionOutput.mockImplementationOnce(() => {
        entered.resolve();
        return held.promise;
      });
      outputs.invalidate(
        sessionOutputKey(
          { ...owner, connectionId: "key-ignores-connection" },
          "session-1",
        ),
      );
      try {
        await entered.promise;
        const closed = closedPeer(peer);
        peer.close();
        await Promise.all([closed, disconnected.promise]);
        await quotaHttp(await initialHttp());
      } finally {
        held.resolve({
          sequence: 0,
          events: [],
          state: { kind: "state", state: "idle" },
        });
      }
      await vi.waitFor(async () => {
        const next = await initialHttp();
        await next.text();
        expect(next.status).toBe(200);
      });
    },
  );

  it("retains HTTP quota after retirement until a detached raw output read settles", async () => {
    const outputs = new SessionOutputStreams();
    const disconnected = Promise.withResolvers<void>();
    const disconnect = outputs.disconnect.bind(outputs);
    vi.spyOn(outputs, "disconnect").mockImplementation((id) => {
      disconnect(id);
      disconnected.resolve();
    });
    await start(undefined, { outputs });
    const first = await initialHttp();
    expect(first.status).toBe(200);
    await first.text();
    const headers = {
      ...identityHeaders(owner),
      "Acp-Connection-Id": first.headers.get("acp-connection-id")!,
    };
    const stream = await fetch(base + "/v1/acp", {
      headers: { ...headers, Accept: "text/event-stream" },
    });
    const reader = stream.body!.getReader();
    const created = rpcResponse(reader, 2);
    void created.catch(() => undefined);
    const entered = Promise.withResolvers<void>();
    const held =
      Promise.withResolvers<
        Awaited<ReturnType<AcpApplicationPort["readSessionOutput"]>>
      >();
    let deletion: Promise<Response> | undefined;
    try {
      const accepted = await fetch(base + "/v1/acp", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: "/workspace", mcpServers: [] },
        }),
      });
      expect(accepted.status).toBe(202);
      await accepted.text();
      expect(await created).toMatchObject({
        result: { sessionId: "session-1" },
      });
      application.readSessionOutput.mockImplementationOnce(() => {
        entered.resolve();
        return held.promise;
      });
      outputs.invalidate(
        sessionOutputKey(
          { ...owner, connectionId: "key-ignores-connection" },
          "session-1",
        ),
      );
      await entered.promise;
      deletion = fetch(base + "/v1/acp", { method: "DELETE", headers });
      void deletion.catch(() => undefined);
      await disconnected.promise;
      await reader.cancel().catch(() => undefined);
      await quotaHttp(await initialHttp());
    } finally {
      held.resolve({
        sequence: 0,
        events: [],
        state: { kind: "state", state: "idle" },
      });
      await reader.cancel().catch(() => undefined);
      await Promise.allSettled([created]);
      if (deletion !== undefined) {
        const deleted = await deletion;
        expect(deleted.status).toBe(202);
        await deleted.text();
      }
    }
    await vi.waitFor(async () => {
      const next = await initialHttp();
      await next.text();
      expect(next.status).toBe(200);
    });
  });

  it.each(["http", "v1", "v2"] as const)(
    "releases %s quota while an accepted Supervisor Run is still pending",
    async (transport) => {
      const completion = Promise.withResolvers<ExecuteRunResult>();
      let completionSettled = false;
      const completionObserved = completion.promise.then(() => {
        completionSettled = true;
      });
      const network = new AbortController();
      const operations: Promise<unknown>[] = [];
      const track = <T>(operation: Promise<T>): Promise<T> => {
        operations.push(operation);
        void operation.catch(() => undefined);
        return operation;
      };
      const bounded = async <T>(operation: Promise<T>): Promise<T> => {
        void track(operation);
        let settled = false;
        void operation.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await vi.waitFor(() => expect(settled).toBe(true));
        return operation;
      };
      let peer: WebSocket | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      application.acceptPrompt.mockResolvedValueOnce({
        outputSequence: 0,
        runId: "run-1",
        requestId: "request-1",
        sessionId: "session-1",
        userMessageId: "message-1",
        snapshot: snapshot(),
        completion: completion.promise,
      });
      try {
        await bounded(start());
        if (transport === "http") {
          const first = await bounded(initialHttp(owner, {}, network.signal));
          expect(first.status).toBe(200);
          await bounded(first.text());
          const id = first.headers.get("acp-connection-id")!;
          const headers = {
            ...identityHeaders(owner),
            "Acp-Connection-Id": id,
          };
          const stream = await bounded(
            fetch(base + "/v1/acp", {
              headers: { ...headers, Accept: "text/event-stream" },
              signal: network.signal,
            }),
          );
          expect(stream.status).toBe(200);
          reader = stream.body!.getReader();
          const post = async (id: number, method: string, params: unknown) => {
            const response = await bounded(
              fetch(base + "/v1/acp", {
                method: "POST",
                headers: {
                  ...headers,
                  "Content-Type": "application/json",
                  ...(method === "session/prompt"
                    ? { "Acp-Session-Id": "session-1" }
                    : {}),
                },
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
                signal: network.signal,
              }),
            );
            const responseBody = await bounded(response.text());
            expect(response.status, responseBody).toBe(202);
          };
          const created = track(rpcResponse(reader, 2));
          await post(2, "session/new", { cwd: "/workspace", mcpServers: [] });
          expect(await bounded(created)).toMatchObject({
            result: { sessionId: "session-1" },
          });
          const prompted = track(rpcResponse(reader, 3));
          await post(3, "session/prompt", {
            sessionId: "session-1",
            prompt: [{ type: "text", text: "one accepted Run" }],
          });
          await vi.waitFor(() =>
            expect(application.acceptPrompt).toHaveBeenCalledOnce(),
          );
          const deletion = track(
            fetch(base + "/v1/acp", {
              method: "DELETE",
              headers,
              signal: network.signal,
            }),
          );
          const deleted = await bounded(deletion);
          expect(deleted.status).toBe(202);
          await bounded(deleted.text());
          httpOwners.delete(id);
          await bounded(reader.cancel().catch(() => undefined));
          await bounded(Promise.allSettled([prompted]));
        } else {
          const version = transport === "v1" ? 1 : 2;
          peer = openWebSocket(version);
          await bounded(once(peer, "open"));
          const initialized = await bounded(
            websocketRpc(peer, 1, "initialize", {
              protocolVersion:
                version === 1 ? acpV1.PROTOCOL_VERSION : acpV2.PROTOCOL_VERSION,
              ...(version === 1
                ? { clientCapabilities: {} }
                : { info: { name: "capacity-run-test", version: "1.0.0" } }),
            }),
          );
          expect(initialized.error).toBeUndefined();
          const created = await bounded(
            websocketRpc(peer, 2, "session/new", {
              cwd: "/workspace",
              mcpServers: [],
            }),
          );
          expect(created.error).toBeUndefined();
          expect(created.result).toMatchObject({ sessionId: "session-1" });
          const prompted = track(
            websocketRpc(peer, 3, "session/prompt", {
              sessionId: "session-1",
              prompt: [{ type: "text", text: "one accepted Run" }],
            }),
          );
          await vi.waitFor(() =>
            expect(application.acceptPrompt).toHaveBeenCalledOnce(),
          );
          if (version === 2)
            expect(await bounded(prompted)).toMatchObject({
              result: { messageId: "message-1" },
            });
          const closed = track(closedPeer(peer));
          peer.close();
          await bounded(closed);
          await bounded(Promise.allSettled([prompted]));
        }
        expect(completionSettled).toBe(false);
        const next = await bounded(initialHttp(owner, {}, network.signal));
        await bounded(next.text());
        expect(next.status).toBe(200);
        expect(completionSettled).toBe(false);
        expect(application.acceptPrompt).toHaveBeenCalledOnce();
        expect(application.cancelRun).not.toHaveBeenCalled();
      } finally {
        completion.resolve({
          terminalClass: "completed",
          executorState: "quiescent",
          toolEffectState: "none",
          stopReason: "end_turn",
        });
        network.abort();
        if (reader !== undefined) void track(reader.cancel());
        if (peer !== undefined && peer.readyState !== WebSocket.CLOSED) {
          void track(closedPeer(peer));
          peer.resume();
          peer.terminate();
        }
        await bounded(
          Promise.allSettled([
            ...operations,
            completion.promise,
            completionObserved,
          ]),
        );
      }
    },
  );

  it("releases a reservation after the real WebSocket handshake rejects invalid framing headers", async () => {
    await start();
    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          base + "/v1/acp",
          {
            headers: {
              ...identityHeaders(owner),
              Connection: "Upgrade",
              Upgrade: "websocket",
              "Sec-WebSocket-Version": "13",
              "Sec-WebSocket-Key": "not-a-valid-key",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("error", reject);
            response.once("end", () =>
              resolve({
                status: response.statusCode!,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        request.once("error", reject);
        request.end();
      },
    );
    expect(response.status).toBe(400);
    const next = await initialHttp();
    expect(next.status).toBe(200);
    await next.text();
  });

  it("does not leak a reservation after synchronous connection setup failure", async () => {
    let calls = 0;
    await start(undefined, {
      id: () => {
        if (++calls === 1) throw new Error("private-setup-failure");
        return `connection-${calls}`;
      },
    });
    const peer = openWebSocket(1);
    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        peer.once("unexpected-response", (_request, response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode!,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        });
        peer.once("error", reject);
      },
    );
    expect(response.status).toBe(503);
    expect(response.body).not.toContain("private-setup-failure");
    const closed = closedPeer(peer);
    peer.terminate();
    await closed;
    const next = await initialHttp();
    expect(next.status).toBe(200);
    await next.text();
  });

  it("does not consume quota when the authenticated peer closes while readiness is pending", async () => {
    const authentication = testAuthentication();
    const admitted = authentication.admit.bind(authentication);
    const rawClosed = Promise.withResolvers<void>();
    vi.spyOn(authentication, "admit").mockImplementation(
      async (request, upgrade) => {
        if (upgrade) request.socket.once("close", () => rawClosed.resolve());
        return admitted(request, upgrade);
      },
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pending = true;
    await start(undefined, {
      authentication,
      ready: async () => {
        if (pending) {
          pending = false;
          entered.resolve();
          await release.promise;
        }
        return true;
      },
    });
    const peer = openWebSocket(2);
    const closed = closedPeer(peer);
    try {
      await entered.promise;
      peer.terminate();
      await closed;
    } finally {
      release.resolve();
    }
    await rawClosed.promise;
    const next = await initialHttp();
    expect(next.status).toBe(200);
    await next.text();
  });
});

function closedPeer(peer: WebSocket): Promise<void> {
  if (peer.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => peer.once("close", () => resolve()));
}

function websocketRpc(
  peer: WebSocket,
  id: number,
  method: string,
  params: unknown,
): Promise<{ id?: number; result?: unknown; error?: unknown }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      peer.off("message", receive);
      peer.off("close", closed);
      peer.off("error", failed);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () =>
      failed(new Error("WebSocket closed before RPC response"));
    const receive = (data: RawData) => {
      try {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        const frame = JSON.parse(bytes.toString("utf8")) as {
          id?: number;
          result?: unknown;
          error?: unknown;
        };
        if (frame.id !== id) return;
        cleanup();
        resolve(frame);
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)));
      }
    };
    peer.on("message", receive);
    peer.once("close", closed);
    peer.once("error", failed);
    peer.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function rpcResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  id: number,
): Promise<unknown> {
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const next = await reader.read();
    if (next.done)
      throw new Error("SSE closed before the admitted RPC response");
    pending += decoder.decode(next.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const frame = JSON.parse(line.slice(5)) as { id?: number };
      if (frame.id === id) return frame;
    }
  }
}

function quotaHeaders(headers: Headers) {
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.get("cache-control")).toBe("no-store");
  expect(headers.get("retry-after")).toBe("1");
}

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
