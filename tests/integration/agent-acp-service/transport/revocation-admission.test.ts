import * as acpV1 from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";
import {
  AgentAcpHttpServer,
  type AgentAcpHttpServerOptions,
} from "../../../../services/agent-acp-service/src/transport/http-server.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import {
  NOOP_TELEMETRY,
  type TelemetryPort,
} from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import { DomainError } from "../../../../services/agent-acp-service/src/domain/errors.js";
import type {
  ExecutionAccessSnapshot,
  ExecutionIdentity,
} from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { testAuthentication } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import {
  binding,
  identityHeaders,
  sessionConfigurationView,
} from "../../../../services/agent-acp-service/test/support/fixtures.js";

const owner = binding();
const foreign = { ...owner, principalId: "another-principal" };
const publication: ExecutionAccessSnapshot = {
  organization_id: owner.organizationId,
  agents: [{ agent_id: owner.agentId, principal_ids: [owner.principalId] }],
};
const revoked: ExecutionAccessSnapshot = {
  organization_id: owner.organizationId,
  agents: [],
};
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
};

describe("publication revocation preserves authenticated ACP admission", () => {
  let server: AgentAcpHttpServer | undefined;
  let origin: string;
  const peers = new Set<WebSocket>();
  const httpOwners = new Map<string, Record<string, string>>();

  afterEach(async () => {
    await Promise.all(
      [...peers].map(async (peer) => {
        if (peer.readyState === WebSocket.CLOSED) return;
        const closed = new Promise<void>((resolve) =>
          peer.once("close", () => resolve()),
        );
        peer.terminate();
        await closed;
      }),
    );
    peers.clear();
    try {
      for (const [id, headers] of httpOwners) {
        const response = await fetch(origin + "/v1/acp", {
          method: "DELETE",
          headers: { ...headers, "Acp-Connection-Id": id },
        });
        await response.text();
        expect(response.status).toBe(202);
      }
    } finally {
      httpOwners.clear();
      await server?.close();
      server = undefined;
    }
  });

  async function start(overrides: Partial<AgentAcpHttpServerOptions> = {}) {
    const application = applicationPort();
    const count = vi.fn<TelemetryPort["count"]>();
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application,
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 65536,
      connectionLimits: { global: 1, organization: 1, principal: 1 },
      telemetry: { ...NOOP_TELEMETRY, count },
      ...overrides,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected TCP listener");
    origin = `http://127.0.0.1:${address.port}`;
    return { application, count };
  }

  async function initialHttp(identity: ExecutionIdentity = owner) {
    const headers = {
      ...identityHeaders(identity),
      "Content-Type": "application/json",
    };
    const response = await fetch(origin + "/v1/acp", {
      method: "POST",
      headers,
      body: JSON.stringify(initialize),
    });
    const id = response.headers.get("Acp-Connection-Id");
    if (response.status === 200 && id !== null) httpOwners.set(id, headers);
    const body = await response.text();
    return { status: response.status, id, body };
  }

  function openWebSocket(version: 1 | 2, identity: ExecutionIdentity) {
    const peer = new WebSocket(
      origin.replace("http:", "ws:") + `/v${version}/acp`,
      { headers: identityHeaders(identity) },
    );
    peers.add(peer);
    peer.on("error", () => undefined);
    const admission = new Promise<number>((resolve) => {
      peer.once("open", () => resolve(101));
      peer.once("error", () => resolve(0));
      peer.once("unexpected-response", (_request, response) => {
        response.resume();
        response.once("end", () => peer.terminate());
        resolve(response.statusCode!);
      });
    });
    return { peer, admission };
  }

  it.each([
    [1, foreign],
    [2, foreign],
    [1, { ...owner, agentId: "unknown-agent" }],
    [2, { ...owner, agentId: "unknown-agent" }],
  ] as const)(
    "initializes authenticated v%s after publication and rejects unauthorized business scope %j",
    async (version, identity) => {
      const { application } = await start();
      await server!.revokeAccess(publication);
      const { peer, admission } = openWebSocket(version, identity);
      expect(await admission).toBe(101);
      expect(
        await websocketRpc(peer, 1, "initialize", initializeParams(version)),
      ).toMatchObject({ id: 1, result: { protocolVersion: version } });
      expect(
        await websocketRpc(peer, 2, "session/new", {
          cwd: "/workspace",
          mcpServers: [],
        }),
      ).toMatchObject({
        id: 2,
        error: { data: { code: "access_denied", retryable: false } },
      });
      expect(application.createSession).toHaveBeenCalledOnce();
      expect(application.acceptPrompt).not.toHaveBeenCalled();
    },
  );

  it("initializes a fresh authenticated HTTP connection after a denying publication", async () => {
    const { application } = await start();
    await server!.revokeAccess(publication);
    const response = await initialHttp(foreign);
    expect(response.status).toBe(200);
    expect(response.id).toEqual(expect.any(String));
    expect(JSON.parse(response.body) as unknown).toMatchObject({
      id: 1,
      result: { protocolVersion: 1 },
    });
    expect(application.createSession).not.toHaveBeenCalled();
    expect(application.acceptPrompt).not.toHaveBeenCalled();
  });

  it("keeps retired HTTP traffic at 404 and the original DELETE receipt at 202", async () => {
    const { application } = await start();
    const opened = await initialHttp();
    expect(opened.status).toBe(200);
    expect(opened.id).not.toBeNull();
    const id = opened.id!;
    await server!.revokeAccess(revoked);
    for (const method of ["GET", "POST"] as const) {
      const response = await fetch(origin + "/v1/acp", {
        method,
        headers: {
          ...identityHeaders(owner),
          "Acp-Connection-Id": id,
          "Content-Type": "application/json",
        },
        ...(method === "POST"
          ? {
              body: JSON.stringify({
                ...initialize,
                id: 2,
                method: "session/list",
                params: {},
              }),
            }
          : {}),
      });
      await response.text();
      expect(response.status).toBe(404);
    }
    const foreignDelete = await fetch(origin + "/v1/acp", {
      method: "DELETE",
      headers: { ...identityHeaders(foreign), "Acp-Connection-Id": id },
    });
    await foreignDelete.text();
    expect(foreignDelete.status).toBe(403);
    const deleted = await fetch(origin + "/v1/acp", {
      method: "DELETE",
      headers: { ...identityHeaders(owner), "Acp-Connection-Id": id },
    });
    expect(await deleted.text()).toBe("");
    expect(deleted.status).toBe(202);
    httpOwners.delete(id);
    expect(application.listSessions).not.toHaveBeenCalled();
    expect(application.deleteSession).not.toHaveBeenCalled();
    expect(application.cancelRun).not.toHaveBeenCalled();
  });

  it("joins an adopted state watch after its final denied frame and original cleanup", async () => {
    const entered = Promise.withResolvers<void>();
    const releaseDenied = Promise.withResolvers<void>();
    const deniedSent = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const caller = new AbortController();
    let watching: AbortSignal | undefined;
    let cleaned = false;
    await start({
      executionState: {
        read: vi.fn(),
        watch: async (_identity, send, signal) => {
          watching = signal;
          await send(
            {
              agent_id: owner.agentId,
              access_allowed: true,
              configuration_revision: "a".repeat(64),
              availability: "ready",
              active_session_id: null,
              unavailable_reason: null,
            },
            signal,
          );
          entered.resolve();
          await releaseDenied.promise;
          signal.throwIfAborted();
          await send(
            {
              agent_id: owner.agentId,
              access_allowed: false,
              configuration_revision: null,
              availability: "offline",
              active_session_id: null,
              unavailable_reason: "access_denied",
            },
            signal,
          );
          deniedSent.resolve();
          await releaseCleanup.promise;
          signal.throwIfAborted();
          cleaned = true;
        },
      },
    });
    let body: Promise<string> | undefined;
    let revocation: Promise<void> | undefined;
    let bodyFinished = false;
    let acknowledged = false;
    try {
      const response = await fetch(
        origin + "/rpc/agent-acp/watch-agent-execution-state",
        {
          method: "POST",
          headers: {
            ...identityHeaders(owner),
            "Content-Type": "application/json",
          },
          body: "{}",
          signal: caller.signal,
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      body = response.text();
      void body.then(
        () => {
          bodyFinished = true;
        },
        () => {
          bodyFinished = true;
        },
      );
      await entered.promise;
      revocation = server!.revokeAccess(revoked).then(() => {
        acknowledged = true;
      });
      void revocation.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(watching?.aborted).toBe(false);
      expect(bodyFinished).toBe(false);
      expect(acknowledged).toBe(false);
      releaseDenied.resolve();
      await Promise.race([deniedSent.promise, body]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cleaned).toBe(false);
      expect(bodyFinished).toBe(false);
      expect(acknowledged).toBe(false);
      releaseCleanup.resolve();
      const [raw] = await Promise.all([body, revocation]);
      const frames = [...raw.matchAll(/^data: (.+)$/gm)].map(
        (match) => JSON.parse(match[1]!) as unknown,
      );
      expect(frames).toEqual([
        {
          agent_id: owner.agentId,
          access_allowed: true,
          configuration_revision: "a".repeat(64),
          availability: "ready",
          active_session_id: null,
          unavailable_reason: null,
        },
        {
          agent_id: owner.agentId,
          access_allowed: false,
          configuration_revision: null,
          availability: "offline",
          active_session_id: null,
          unavailable_reason: "access_denied",
        },
      ]);
      expect(raw).not.toContain("workspace_error");
      expect(cleaned).toBe(true);
      expect(bodyFinished).toBe(true);
      expect(acknowledged).toBe(true);
    } finally {
      releaseDenied.resolve();
      releaseCleanup.resolve();
      caller.abort();
      await Promise.allSettled([body, revocation]);
    }
  });

  it.each([
    ["authentication", "http"],
    ["authentication", "v1"],
    ["authentication", "v2"],
    ["readiness", "http"],
    ["readiness", "v1"],
    ["readiness", "v2"],
  ] as const)(
    "does not adopt %s-held %s admission after a later same-scope revocation",
    async (boundary, transport) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const authentication = testAuthentication();
      const ready = vi.fn(() => Promise.resolve(true));
      if (boundary === "authentication") {
        const admit = authentication.admit.bind(authentication);
        vi.spyOn(authentication, "admit").mockImplementationOnce(
          async (...input) => {
            const result = await admit(...input);
            entered.resolve();
            await release.promise;
            return result;
          },
        );
      } else {
        ready.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return true;
        });
      }
      const { application, count } = await start({ authentication, ready });
      const pending =
        transport === "http"
          ? initialHttp().then(
              (result) => result.status,
              () => 0,
            )
          : openWebSocket(transport === "v1" ? 1 : 2, owner).admission;
      let revocation: Promise<void> | undefined;
      try {
        await entered.promise;
        revocation = server!.revokeAccess(revoked);
        release.resolve();
        const [status] = await Promise.all([pending, revocation]);
        expect(status).not.toBe(transport === "http" ? 200 : 101);
        expect(httpOwners.size).toBe(0);
        expect(
          count.mock.calls.filter(
            ([name, attributes]) =>
              name === "antnest.acp.connections" &&
              attributes.result === "accepted",
          ),
        ).toHaveLength(0);
        expect(application.createSession).not.toHaveBeenCalled();
        expect(application.acceptPrompt).not.toHaveBeenCalled();
        // A later request starts after revocation and still has its own capacity.
        const fresh = await initialHttp();
        expect(fresh.status).toBe(200);
      } finally {
        release.resolve();
        await Promise.allSettled([pending, revocation]);
      }
    },
  );
});

function initializeParams(version: 1 | 2) {
  return version === 1
    ? { protocolVersion: acpV1.PROTOCOL_VERSION, clientCapabilities: {} }
    : {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "revocation-admission", version: "1.0.0" },
      };
}

function websocketRpc(
  peer: WebSocket,
  id: number,
  method: string,
  params: unknown,
) {
  return new Promise<{ id?: number; result?: unknown; error?: unknown }>(
    (resolve, reject) => {
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
    },
  );
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
    createSession: vi.fn<AcpApplicationPort["createSession"]>(
      ({ binding: identity }) => {
        if (
          identity.organizationId !== owner.organizationId ||
          identity.principalId !== owner.principalId ||
          identity.agentId !== owner.agentId
        )
          return Promise.reject(
            new DomainError("access_denied", "Agent access denied"),
          );
        return Promise.resolve({ sessionId: "session-1" });
      },
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
