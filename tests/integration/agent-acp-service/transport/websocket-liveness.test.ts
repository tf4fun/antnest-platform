import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as acpV1 from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";

import { testAuthentication } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import {
  binding,
  identityHeaders,
  sessionConfigurationView,
} from "../../../../services/agent-acp-service/test/support/fixtures.js";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import { PermissionConnections } from "../../../../services/agent-acp-service/src/application/permission-connections.js";
import { permissionResolution } from "../../../../services/agent-acp-service/src/transport/acp/permission-request.js";
import type {
  PermissionOwner,
  PermissionRequest,
} from "../../../../services/agent-acp-service/src/ports/tool-permissions.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";

const setup = { cwd: "/workspace", mcpServers: [] };
const request: PermissionRequest = {
  runId: "run-1",
  sessionId: "session-1",
  call: { id: "call-1", name: "write", arguments: { path: "/tmp/x" } },
  tool: {
    source: "runtime",
    sourceId: "runtime",
    name: "write",
    modelName: "write",
    description: "write",
  },
};
const owner: PermissionOwner = { ...binding(), accessRevision: "access-1" };
const correlation = {
  "antnest.dev/permission-request": {
    version: 1,
    runId: "run-1",
    toolCallId: "call-1",
  },
};

describe("ACP WebSocket liveness over real sockets", () => {
  let server: AgentAcpHttpServer | undefined;

  afterEach(async () => {
    await server?.close().catch((error: unknown) => {
      throw new Error("server teardown failed", { cause: error });
    });
  });

  it("validates the permission resolution helper against the contract schema", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../../../../contracts/agent-acp/permission-resolution.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const validate = new Ajv2020({ strict: false }).compile(schema);
    for (const reason of [
      "permission_resolved",
      "permission_timeout",
    ] as const) {
      const notice = permissionResolution(request, reason);
      const payload = notice.update._meta["antnest.dev/permission-resolution"];
      expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it.each([1, 2] as const)(
    "v%s: the heartbeat drops a silent socket and a healthy attachment receives the same approval",
    async (version) => {
      const application = applicationPort();
      const permissions = new PermissionConnections();
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application,
        permissions,
        ready: () => Promise.resolve(true),
        maxWebSocketPayloadBytes: 64 * 1024,
        wsPingIntervalMs: 500,
        connectionLimits: { global: 1, organization: 1, principal: 1 },
      });
      await server.listen("127.0.0.1", 0);
      const caller = new AbortController();
      const sockets: WebSocket[] = [];
      let waiting: Promise<unknown> | undefined;
      try {
        const silent = await openRawWebSocket(server, `/v${version}/acp`, {
          autoPong: false,
        });
        sockets.push(silent);
        const silentFrames: Array<Record<string, unknown>> = [];
        silent.on("message", (data) =>
          silentFrames.push(
            JSON.parse(rawDataText(data)) as Record<string, unknown>,
          ),
        );
        let silentPings = 0;
        silent.on("ping", () => {
          silentPings += 1;
        });
        await initializeRaw(silent, version);
        silent.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: setup,
          }),
        );
        await vi.waitFor(() =>
          expect(silentFrames.find((frame) => frame.id === 2)).toBeDefined(),
        );
        waiting = permissions.request(request, owner, caller.signal, () =>
          Promise.resolve(),
        );
        void waiting.catch(() => undefined);
        await vi.waitFor(() =>
          expect(
            silentFrames.find(
              (frame) => frame.method === "session/request_permission",
            ),
          ).toBeDefined(),
        );
        const wireRequest = silentFrames.find(
          (frame) => frame.method === "session/request_permission",
        )!;
        expect(wireRequest.params).toMatchObject({ _meta: correlation });
        await vi.waitFor(
          () => expect(silent.readyState).toBe(WebSocket.CLOSED),
          { timeout: 2_000 },
        );
        expect(silentPings).toBeGreaterThan(0);
        expect(application.cancelRun).not.toHaveBeenCalled();
        const second = await openRawWebSocket(server, `/v${version}/acp`);
        sockets.push(second);
        const healthyFrames: Array<Record<string, unknown>> = [];
        second.on("message", (data) =>
          healthyFrames.push(
            JSON.parse(rawDataText(data)) as Record<string, unknown>,
          ),
        );
        let healthyPings = 0;
        second.on("ping", () => {
          healthyPings += 1;
        });
        await initializeRaw(second, version);
        second.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: version === 1 ? "session/load" : "session/resume",
            params: { ...setup, sessionId: "session-1" },
          }),
        );
        await vi.waitFor(() =>
          expect(
            healthyFrames.find(
              (frame) => frame.method === "session/request_permission",
            ),
          ).toBeDefined(),
        );
        const reissued = healthyFrames.find(
          (frame) => frame.method === "session/request_permission",
        )!;
        expect(reissued.params).toMatchObject({ _meta: correlation });
        second.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reissued.id,
            result: {
              outcome: { outcome: "selected", optionId: "allow_once" },
            },
          }),
        );
        await expect(waiting).resolves.toEqual({
          outcome: { outcome: "selected", optionId: "allow_once" },
        });
        await new Promise((resolve) => setTimeout(resolve, 1_600));
        expect(second.readyState).toBe(WebSocket.OPEN);
        expect(healthyPings).toBeGreaterThan(0);
        const closing = new Promise<number>((resolve) =>
          second.once("close", (code) => resolve(code)),
        );
        second.close(1000);
        const code = await Promise.race([
          closing,
          new Promise<number>((resolve) =>
            setTimeout(() => resolve(-1), 2_000),
          ),
        ]);
        expect(code).toBe(1000);
      } finally {
        caller.abort();
        if (waiting !== undefined) await Promise.allSettled([waiting]);
        for (const socket of sockets) {
          if (socket.readyState === WebSocket.CLOSED) continue;
          const closed = new Promise<void>((resolve) =>
            socket.once("close", () => resolve()),
          );
          socket.terminate();
          await closed;
        }
      }
    },
  );
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

function serverUrl(server: AgentAcpHttpServer, path: string): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no TCP address");
  }
  return `ws://127.0.0.1:${address.port}${path}`;
}

function openRawWebSocket(
  server: AgentAcpHttpServer,
  path: string,
  options: { autoPong?: boolean } = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(serverUrl(server, path), {
      headers: identityHeaders(),
      ...(options.autoPong === undefined ? {} : { autoPong: options.autoPong }),
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.destroy();
      reject(new Error(`WebSocket upgrade rejected: ${response.statusCode}`));
    });
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
