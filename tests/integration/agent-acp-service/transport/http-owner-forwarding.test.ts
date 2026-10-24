import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { afterEach, expect, it, vi } from "vitest";
import { testAuthentication } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import {
  binding,
  identityHeaders,
  sessionConfigurationView,
  snapshot,
} from "../../../../services/agent-acp-service/test/support/fixtures.js";
import {
  CALLER_CONTEXT_HEADER,
  CallerContextError,
  CallerContextVerifier,
} from "../../../../services/agent-acp-service/src/adapters/caller-context.js";
import { SecretBox } from "../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { HttpOwnerHandles } from "../../../../services/agent-acp-service/src/application/http-owner-handle.js";
import { PermissionConnections } from "../../../../services/agent-acp-service/src/application/permission-connections.js";
import type { OwnerRegistration } from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import {
  encodeOwnerForward,
  OWNER_FORWARD_HEADER,
  type OwnerForwardRequest,
} from "../../../../services/agent-acp-service/src/application/owner-forwarding.js";
import type { AgentOwnershipFence } from "../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import type { ExecutionIdentity } from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import type {
  AcpApplicationPort,
  ExecuteRunResult,
} from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import type {
  PermissionConnection,
  PermissionConnectionsPort,
} from "../../../../services/agent-acp-service/src/ports/tool-permissions.js";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import { HttpRelayBodyCleanupError } from "../../../../services/agent-acp-service/src/transport/owned-relay-response.js";
import {
  OWNER_HTTP_PATH,
  type HttpOwnerForwardingOptions,
} from "../../../../services/agent-acp-service/src/transport/owner-http.js";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
};
const newSession = {
  jsonrpc: "2.0",
  id: 2,
  method: "session/new",
  params: { cwd: "/workspace", mcpServers: [] },
};
type Notice = { sessionId: string; update: acp.SessionUpdate };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  vi.restoreAllMocks();
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      "HTTP forwarding fixture cleanup failed",
    );
});

function application() {
  return {
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
    cancelRun: vi.fn<AcpApplicationPort["cancelRun"]>(),
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
    acceptPrompt: vi.fn<AcpApplicationPort["acceptPrompt"]>(),
  } satisfies AcpApplicationPort;
}

async function start(
  oneIngressSlot = false,
  permissions?: PermissionConnectionsPort,
  peerFetch: typeof fetch = fetch,
) {
  const base = binding();
  const identity: ExecutionIdentity = {
    organizationId: base.organizationId,
    principalId: base.principalId,
    agentId: base.agentId,
  };
  const registration = (member_id: string): OwnerRegistration => ({
    registration_id: randomUUID(),
    member_id,
    incarnation_id: randomUUID(),
  });
  const a = registration("acp-a"),
    b = registration("acp-b");
  const fence: AgentOwnershipFence = {
    organizationId: identity.organizationId,
    agentId: identity.agentId,
    ownerInstanceId: b.incarnation_id,
    epoch: "7",
  };
  const sha = "a".repeat(64),
    key = randomBytes(32);
  const handles = () =>
    new HttpOwnerHandles({
      secretBox: new SecretBox(Buffer.from(key)),
      membershipSha256: sha,
    });
  const codec = handles();
  const lifetime = new AbortController();
  const appA = application(),
    appB = application();
  const pending = new Set<Promise<unknown>>();
  const responses = new Set<Response>();
  const privateHandlers = new Set<Promise<void>>();
  const privateGets = new Map<Promise<void>, string | null>();
  const errors: unknown[] = [];
  const expectedCleanupFailures = new Set<unknown>();
  const clients: acp.ClientConnection[] = [];
  const release: Array<() => void> = [];
  // Assign after cleanup registration so partial startup is owned as well.
  // eslint-disable-next-line prefer-const
  let ingress: AgentAcpHttpServer | undefined;
  // eslint-disable-next-line prefer-const
  let owner: AgentAcpHttpServer | undefined;
  const retain = <T>(original: Promise<T>): Promise<T> => {
    pending.add(original);
    void original.then(
      () => pending.delete(original),
      () => pending.delete(original),
    );
    return original;
  };
  const network: typeof fetch = (input, init) =>
    retain(
      fetch(input, init).then((response) => {
        responses.add(response);
        return response;
      }),
    );

  // This real private HTTP listener starts at the already-authenticated member
  // boundary. Directional credential admission remains covered by peer-server
  // and dual-main tests; this fixture does not manufacture public delegation.
  const peer = createServer((request, response) => {
    response.shouldKeepAlive = false;
    response.setHeader("Connection", "close");
    const cancellation = new AbortController();
    const cancel = () => {
      if (!response.writableFinished) cancellation.abort();
    };
    request.once("aborted", cancel);
    response.once("close", cancel);
    const original = (async () => {
      try {
        if (owner === undefined) throw new Error("Owner fixture is not ready");
        await owner.handlePeerHttp(
          request,
          response,
          "acp-a",
          cancellation.signal,
          () => undefined,
        );
      } finally {
        request.off("aborted", cancel);
        response.off("close", cancel);
      }
    })();
    privateHandlers.add(original);
    if (request.method === "GET") {
      const session = request.headers["acp-session-id"];
      privateGets.set(original, typeof session === "string" ? session : null);
    }
    const forget = () => {
      privateHandlers.delete(original);
      privateGets.delete(original);
    };
    void original.then(forget, (error: unknown) => {
      errors.push(error);
      response.destroy();
      forget();
    });
  });
  let peerClosing: Promise<void> | undefined;
  const closePeer = () => {
    peerClosing ??= new Promise<void>((resolve, reject) => {
      peer.close((error) => {
        if (
          error &&
          !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
        )
          reject(error);
        else resolve();
      });
      peer.closeAllConnections();
    });
    return peerClosing;
  };
  cleanups.push(async () => {
    for (const unblock of release) unblock();
    for (const client of clients) client.close();
    const results = await Promise.allSettled(
      clients.map((client) => client.closed),
    );
    for (const response of responses)
      if (response.body !== null && !response.bodyUsed && !response.body.locked)
        results.push(...(await Promise.allSettled([response.body.cancel()])));
    while (privateHandlers.size)
      results.push(...(await Promise.allSettled([...privateHandlers])));
    while (pending.size) await Promise.allSettled([...pending]);
    results.push(
      ...(await Promise.allSettled([ingress?.close(), owner?.close()])),
    );
    results.push(...(await Promise.allSettled([closePeer()])));
    while (privateHandlers.size)
      results.push(...(await Promise.allSettled([...privateHandlers])));
    while (pending.size) await Promise.allSettled([...pending]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" &&
      !expectedCleanupFailures.has(result.reason)
        ? [result.reason as unknown]
        : [],
    );
    if (errors.length || failures.length)
      throw new AggregateError(
        [...errors, ...failures],
        "HTTP forwarding cleanup failed",
      );
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const address = peer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing private HTTP listener");
  const privateOrigin = `http://127.0.0.1:${address.port}`;
  const peers: HttpOwnerForwardingOptions["peers"] = {
    membership: {
      clusterId: randomUUID(),
      sha256: sha,
      members: [
        { member_id: a.member_id, origin: "http://acp-a.invalid" },
        { member_id: b.member_id, origin: privateOrigin },
      ],
    },
    fetchFor: (member) => {
      if (member !== b.member_id)
        throw new Error("Unexpected peer destination");
      return (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.origin !== privateOrigin)
          throw new Error("Untrusted peer origin");
        // The production relay owns this response body and joins its reader.
        return retain(peerFetch(input, init));
      };
    },
  };
  const target = (source = a, selected = identity): OwnerForwardRequest => ({
    request_id: randomUUID(),
    deadline_at: new Date(Date.now() + 10000).toISOString(),
    membership_sha256: sha,
    source,
    target: b,
    publication: {
      organization_id: selected.organizationId,
      revision: 1,
      authority_sha256: "b".repeat(64),
    },
    identity: { ...selected },
    epoch: fence.epoch,
    protocol: "v1",
    caller: "agent-ui",
    hop: 1,
  });
  const admit = vi.fn<HttpOwnerForwardingOptions["admit"]>(
    (request, signal) => {
      signal.throwIfAborted();
      expect(request.target).toEqual(b);
      return Promise.resolve({
        fence,
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      });
    },
  );
  owner = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application: appB,
    ...(permissions === undefined ? {} : { permissions }),
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 4096,
    httpForwarding: {
      registration: b,
      handles: handles(),
      peers,
      admit,
      resolver: { resolve: (selected) => Promise.resolve(target(b, selected)) },
    },
  });
  ingress = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application: appA,
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 4096,
    ...(oneIngressSlot
      ? { connectionLimits: { global: 1, organization: 1, principal: 1 } }
      : {}),
    httpForwarding: {
      registration: a,
      handles: handles(),
      peers,
      admit,
      resolver: { resolve: (selected) => Promise.resolve(target(a, selected)) },
    },
  });
  await owner.listen("127.0.0.1", 0);
  await ingress.listen("127.0.0.1", 0);
  const origin = (server: AgentAcpHttpServer) => {
    const found = server.address();
    if (!found || typeof found === "string")
      throw new Error("Missing ACP listener");
    return `http://127.0.0.1:${found.port}`;
  };
  const origins = { a: origin(ingress), b: origin(owner) };
  const send = (
    member: "a" | "b",
    method: string,
    id?: string,
    body?: unknown,
    selected = identity,
  ) =>
    network(`${origins[member]}/v1/acp`, {
      method,
      headers: {
        ...identityHeaders(selected),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(id ? { "Acp-Connection-Id": id } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const open = async () => {
    const response = await send("a", "POST", undefined, initialize);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { protocolVersion: 1 },
    });
    const id = response.headers.get("Acp-Connection-Id");
    if (!id) throw new Error("Missing owner handle");
    return id;
  };
  return {
    ingress,
    owner,
    identity,
    fence,
    b,
    codec,
    appA,
    appB,
    admit,
    network,
    origins,
    send,
    open,
    closePeer,
    expectedCleanupFailures,
    target,
    release,
    activeSessionGets: () => [...privateGets.values()],
    privateInitialize: (token?: string) =>
      network(`${privateOrigin}${OWNER_HTTP_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          [OWNER_FORWARD_HEADER]: encodeOwnerForward(target()),
          ...(token === undefined ? {} : { [CALLER_CONTEXT_HEADER]: token }),
        },
        body: JSON.stringify(initialize),
      }),
    connect: (
      fetcher: typeof fetch = network,
      notified: (params: Notice) => void = () => undefined,
      permission?: (
        params: acp.RequestPermissionRequest,
      ) => Promise<acp.RequestPermissionResponse>,
    ) => {
      const app = acp
        .client()
        .onNotification(acp.methods.client.session.update, ({ params }) =>
          notified(params),
        );
      const configured =
        permission === undefined
          ? app
          : app.onRequest(
              acp.methods.client.session.requestPermission,
              ({ params }) => permission(params),
            );
      const client = configured.connect(
        createHttpStream(`${origins.a}/v1/acp`, {
          headers: identityHeaders(identity),
          fetch: (input, init) =>
            retain(
              fetcher(input, init).then((response) => {
                // The official client owns this body through client.closed. A second
                // fixture cancellation after that close only rethrows its abort.
                responses.delete(response);
                return response;
              }),
            ),
        }),
      );
      clients.push(client);
      return client;
    },
  };
}

function holdSdkCleanup() {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = AcpServer.prototype.close;
  const close = vi
    .spyOn(AcpServer.prototype, "close")
    .mockImplementation(async function (this: AcpServer) {
      const cleanup = original.call(this);
      void cleanup.catch(() => undefined);
      entered.resolve();
      await release.promise;
      await cleanup;
    });
  return { entered: entered.promise, release: release.resolve, close };
}

it("keeps one opaque connection across both public ingresses while connection and session SSE GETs coexist", async () => {
  const f = await start();
  const gets: Array<{
    session: string | null;
    status: number;
    response: Response;
  }> = [];
  const notifications: Notice[] = [];
  const deletions: number[] = [];
  let handle: string | null = null;
  const client = f.connect(
    async (input, init) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : {}),
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      const session = headers.get("Acp-Session-Id");
      // Initial POST reaches A, connection GET and session/new reach B, and the
      // session GET crosses A's relay with Acp-Session-Id intact.
      const member =
        method === "GET"
          ? session === null
            ? "b"
            : "a"
          : method === "POST" && headers.has("Acp-Connection-Id")
            ? "b"
            : "a";
      const url = new URL(input instanceof Request ? input.url : String(input));
      const routed = new URL(url.pathname + url.search, f.origins[member]);
      const response = await f.network(
        input instanceof Request ? new Request(routed, input) : routed,
        init,
      );
      if (method === "POST" && handle === null)
        handle = response.headers.get("Acp-Connection-Id");
      if (method === "GET")
        gets.push({ session, status: response.status, response });
      if (method === "DELETE") deletions.push(response.status);
      return response;
    },
    (params) => notifications.push(params),
  );
  await client.agent.request(acp.methods.agent.initialize, initialize.params);
  expect(handle).toMatch(/^acph1\./u);
  await expect(
    client.agent.request(acp.methods.agent.session.new, newSession.params),
  ).resolves.toMatchObject({ sessionId: "session-1" });
  await vi.waitFor(() => {
    expect(gets.some((get) => get.session === null && get.status === 200)).toBe(
      true,
    );
    expect(
      gets.some((get) => get.session === "session-1" && get.status === 200),
    ).toBe(true);
    expect(
      notifications.some((notice) => notice.sessionId === "session-1"),
    ).toBe(true);
  });
  expect(
    gets
      .filter((get) => get.status === 200)
      .every((get) => get.response.body?.locked),
  ).toBe(true);
  expect(client.signal.aborted).toBe(false);
  expect(f.appA.createSession).not.toHaveBeenCalled();
  expect(f.appB.createSession).toHaveBeenCalledOnce();
  expect(f.appB.createSession.mock.calls[0]?.[0].binding).toMatchObject({
    ...f.identity,
    ownerFence: f.fence,
  });
  client.close();
  await client.closed;
  await vi.waitFor(() => expect(deletions).toContain(202));
}, 15000);

it("rejects tampered handles, foreign CCT identity and a different original registration without business dispatch", async () => {
  const f = await start();
  const id = await f.open();
  const altered =
    id.slice(0, -4) + (id.at(-4) === "A" ? "B" : "A") + id.slice(-3);
  const bound = f.codec.open(id);
  const foreign = f.codec.seal({
    owner: { ...bound.owner, registration_id: randomUUID() },
    epoch: bound.epoch,
    connectionId: bound.connectionId,
    identity: bound.identity,
  });
  for (const [member, handle, selected, status] of [
    ["a", altered, f.identity, 400],
    ["b", id, { ...f.identity, principalId: "foreign-principal" }, 403],
    ["b", foreign, f.identity, 503],
  ] as const) {
    const response = await f.send(member, "POST", handle, newSession, selected);
    expect(response.status).toBe(status);
    await response.text();
  }
  expect(f.appA.createSession).not.toHaveBeenCalled();
  expect(f.appB.createSession).not.toHaveBeenCalled();
  const response = await f.send("a", "DELETE", id);
  expect(response.status).toBe(202);
  await response.text();
});

it("preserves retired HTTP handle 404 and original DELETE 202 across both revoked members", async () => {
  const f = await start();
  const id = await f.open();
  const snapshot = { organization_id: f.identity.organizationId, agents: [] };
  await Promise.all([
    f.ingress.revokeAccess(snapshot),
    f.owner.revokeAccess(snapshot),
  ]);
  for (const member of ["a", "b"] as const) {
    for (const method of ["GET", "POST"] as const) {
      const response = await f.send(
        member,
        method,
        id,
        method === "POST" ? newSession : undefined,
      );
      await response.text();
      expect(response.status).toBe(404);
    }
  }
  const deleted = await f.send("a", "DELETE", id);
  expect(deleted.status).toBe(202);
  await deleted.text();
  expect(f.appA.createSession).not.toHaveBeenCalled();
  expect(f.appB.createSession).not.toHaveBeenCalled();
});

it("returns a typed reconnectable 503 for an original-handle DELETE after the real private peer listener closes", async () => {
  const f = await start();
  const id = await f.open();
  await f.closePeer();

  const response = await f.send("a", "DELETE", id);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    code: "acp_http_peer_disconnected",
    message: "Original ACP HTTP peer disconnected",
    retryable: true,
  });
  expect(f.appA.createSession).not.toHaveBeenCalled();
  expect(f.appB.createSession).not.toHaveBeenCalled();
});

it.each([503, 404] as const)(
  "preserves an actual upstream HTTP %s without reconnect qualification",
  async (status) => {
    const upstreamStatuses: number[] = [];
    const f = await start(false, undefined, async (input, init) => {
      if (init?.method !== "DELETE") return fetch(input, init);
      const headers = new Headers(init.headers);
      headers.set("Acp-Connection-Id", upstreamHandle);
      const response = await fetch(input, { ...init, headers });
      upstreamStatuses.push(response.status);
      return response;
    });
    const id = await f.open();
    const original = f.codec.open(id);
    const upstreamHandle = f.codec.seal({
      owner:
        status === 503
          ? { ...original.owner, registration_id: randomUUID() }
          : original.owner,
      epoch: original.epoch,
      connectionId: status === 404 ? randomUUID() : original.connectionId,
      identity: original.identity,
    });
    const response = await f.send("a", "DELETE", id);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("acp_http_peer_disconnected");
    expect(upstreamStatuses).toEqual([status]);
    expect(f.appA.createSession).not.toHaveBeenCalled();
    expect(f.appB.createSession).not.toHaveBeenCalled();
  },
);

function disconnectedPeer(): TypeError {
  return new TypeError("peer-fetch-private-canary", {
    cause: Object.assign(new Error("peer-network-private-canary"), {
      code: "ECONNREFUSED",
    }),
  });
}

async function drainOriginalUpload(init?: RequestInit): Promise<number> {
  if (init?.body === undefined || init.body === null) return 0;
  return (await new Response(init.body).arrayBuffer()).byteLength;
}

function cleanupLeaves(error: unknown): unknown[] {
  if (error instanceof AggregateError)
    return error.errors.flatMap((item: unknown) => cleanupLeaves(item));
  if (error instanceof Error && Object.hasOwn(error, "cause"))
    return cleanupLeaves(error.cause);
  return [error];
}

function originalCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  if (!(error instanceof Error)) return false;
  // The fixture deliberately destroys the original downstream response after
  // aborting its relay; Node may report that exact cancellation as premature close.
  if ("code" in error && error.code === "ERR_STREAM_PREMATURE_CLOSE")
    return !Object.hasOwn(error, "cause");
  return (
    error.name === "AbortError" &&
    (!Object.hasOwn(error, "cause") || error.cause === signal.reason)
  );
}

it.each([
  ["TLS", "DELETE", "tls", false],
  ["timeout", "DELETE", "timeout", false],
  ["mixed causes", "DELETE", "mixed", false],
  ["GET", "GET", "disconnected", false],
  ["POST", "POST", "disconnected", false],
  ["nonempty DELETE", "DELETE", "disconnected", true],
] as const)(
  "does not qualify %s as an original empty DELETE network loss",
  async (_name, method, kind, nonempty) => {
    const disconnected = disconnectedPeer();
    const failure =
      kind === "tls"
        ? Object.assign(new Error("peer-tls-private-canary"), {
            code: "CERT_HAS_EXPIRED",
          })
        : kind === "timeout"
          ? Object.assign(new Error("peer-timeout-private-canary"), {
              code: "ETIMEDOUT",
            })
          : kind === "mixed"
            ? new TypeError("peer-mixed-private-canary", {
                cause: Object.assign(
                  new AggregateError([
                    disconnected,
                    new Error("independent-peer-private-canary"),
                  ]),
                  { code: "ECONNREFUSED" },
                ),
              })
            : disconnected;
    let failing = false;
    const f = await start(false, undefined, async (input, init) => {
      if (!failing) return fetch(input, init);
      if (method !== "GET") {
        const bytes = await drainOriginalUpload(init);
        if (nonempty) expect(bytes).toBeGreaterThan(0);
      }
      throw failure;
    });
    const id = await f.open();
    failing = true;
    const response = await f.send(
      "a",
      method,
      id,
      method === "POST"
        ? newSession
        : nonempty
          ? { unexpected: true }
          : undefined,
    );
    if (nonempty) expect(response.status).toBeGreaterThanOrEqual(400);
    else expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("acp_http_peer_disconnected");
    expect(body).not.toContain("private-canary");
    expect(f.appA.createSession).not.toHaveBeenCalled();
    expect(f.appB.createSession).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "joins the same handle's original GET cleanup before qualifying DELETE and preserves independent failure (%s)",
  async (brokenCleanup) => {
    const entered = Promise.withResolvers<void>();
    const releaseCancel = Promise.withResolvers<void>();
    const sentinel = new Error("peer-reader-cleanup-private-canary");
    const disconnected = disconnectedPeer();
    const sourceFailures: unknown[] = [];
    const signals = new Map<string, AbortSignal>();
    let heldHandle: string | undefined;
    let originalBody: ReadableStream<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    let cleanupJoined = false;
    let failDelete = false;
    const f = await start(false, undefined, async (input, init) => {
      const method = init?.method ?? "GET";
      const handle = new Headers(init?.headers).get("Acp-Connection-Id");
      if (failDelete && method === "DELETE" && handle === heldHandle) {
        await drainOriginalUpload(init);
        throw disconnected;
      }
      const response = await fetch(input, init);
      if (method !== "GET" || handle === null) return response;
      const signal = init?.signal;
      if (!signal || response.body === null)
        throw new Error("Missing original peer GET body or cancellation");
      signals.set(handle, signal);
      if (handle !== heldHandle) return response;
      originalBody = response.body;
      const reader = originalBody.getReader();
      void reader.closed.catch(() => undefined);
      return new Response(
        new ReadableStream<Uint8Array>({
          // Retain the actual network reader without completing this GET. Its
          // cancellation is part of the production relay's original pump task.
          cancel: (reason: unknown) => {
            cancellation ??= (async () => {
              entered.resolve();
              const results = await Promise.allSettled([
                reader.cancel(reason),
                reader.closed,
              ]);
              sourceFailures.push(
                ...results.flatMap((result) =>
                  result.status === "rejected"
                    ? [result.reason as unknown]
                    : [],
                ),
              );
              try {
                await releaseCancel.promise;
              } finally {
                reader.releaseLock();
                cleanupJoined = true;
              }
              if (
                brokenCleanup ||
                sourceFailures.some(
                  (error) => !originalCancellation(error, signal),
                )
              )
                throw new AggregateError(
                  [...sourceFailures, ...(brokenCleanup ? [sentinel] : [])],
                  "Original peer reader cleanup failed",
                );
            })();
            return cancellation;
          },
        }),
        { status: response.status, headers: response.headers },
      );
    });
    f.release.push(releaseCancel.resolve);
    const streams: Response[] = [];
    let deletion: Promise<Response> | undefined;
    try {
      const id = await f.open();
      const otherId = await f.open();
      expect(otherId).not.toBe(id);
      heldHandle = id;
      streams.push(await f.send("a", "GET", id));
      streams.push(await f.send("a", "GET", otherId));
      expect(streams.map((response) => response.status)).toEqual([200, 200]);
      const signal = signals.get(id),
        otherSignal = signals.get(otherId);
      if (!signal || !otherSignal || originalBody === undefined)
        throw new Error("Original GET requests were not retained");
      failDelete = true;
      let responded = false;
      deletion = f.send("a", "DELETE", id).then((response) => {
        responded = true;
        return response;
      });
      void deletion.catch(() => undefined);
      await Promise.race([entered.promise, deletion]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(responded).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(otherSignal.aborted).toBe(false);
      expect(cleanupJoined).toBe(false);
      expect(originalBody.locked).toBe(true);
      releaseCancel.resolve();
      const response = await deletion;
      const body = await response.text();
      expect(response.status).toBe(503);
      if (brokenCleanup) {
        expect(body).not.toContain("acp_http_peer_disconnected");
        expect(body).not.toContain("private-canary");
      } else
        expect(JSON.parse(body)).toEqual({
          code: "acp_http_peer_disconnected",
          message: "Original ACP HTTP peer disconnected",
          retryable: true,
        });
      expect(cleanupJoined).toBe(true);
      expect(originalBody.locked).toBe(false);
      expect(otherSignal.aborted).toBe(false);
      for (const failure of sourceFailures)
        expect(originalCancellation(failure, signal)).toBe(true);
      await Promise.allSettled(
        streams.map((stream) => stream.body?.cancel() ?? Promise.resolve()),
      );
      await vi.waitFor(() => expect(f.activeSessionGets()).toEqual([]));
      if (brokenCleanup) {
        await f.ingress.close().then(
          () => {
            throw new Error(
              "Independent peer cleanup must reject ingress close",
            );
          },
          (error: unknown) => {
            const leaves = cleanupLeaves(error);
            expect(leaves).toContain(sentinel);
            const allowed = new Set([
              sentinel,
              ...cleanupLeaves(disconnected),
              ...sourceFailures.flatMap(cleanupLeaves),
              ...cleanupLeaves(signal.reason),
            ]);
            for (const leaf of leaves)
              if (!(
                allowed.has(leaf) ||
                originalCancellation(leaf, signal) ||
                originalCancellation(leaf, otherSignal)
              ))
                throw new Error("Unexpected independent cleanup leaf", {
                  cause: leaf,
                });
            f.expectedCleanupFailures.add(error);
          },
        );
      }
      expect(f.appA.createSession).not.toHaveBeenCalled();
      expect(f.appB.createSession).not.toHaveBeenCalled();
    } finally {
      releaseCancel.resolve();
      await Promise.allSettled([
        ...streams.map((stream) => stream.body?.cancel()),
        cancellation,
        deletion?.then(async (response) => {
          if (!response.bodyUsed) await response.text();
        }),
      ]);
    }
  },
  15000,
);

it("retains an explicit body cleanup failure when it is the primary relay error", async () => {
  const sentinel = new Error("primary-cleanup-private-canary");
  const primary = new HttpRelayBodyCleanupError([sentinel]);
  let injected = false;
  const f = await start(true, undefined, async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method !== "GET") return response;
    await response.body?.cancel();
    injected = true;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(primary);
        },
      }),
      { status: response.status, headers: response.headers },
    );
  });
  const id = await f.open();
  await expect(
    f.send("a", "GET", id).then((response) => response.text()),
  ).rejects.toThrow();
  expect(injected).toBe(true);
  const rejected = await f.send("a", "POST", undefined, initialize);
  await rejected.text();
  expect(rejected.status).toBe(429);
  expect(rejected.headers.get("Retry-After")).toBe("1");
  await f.ingress.close().then(
    () => {
      throw new Error("Primary cleanup failure must remain retained");
    },
    (error: unknown) => {
      const leaves = cleanupLeaves(error);
      expect(leaves.length).toBeGreaterThan(0);
      for (const leaf of leaves) expect(leaf).toBe(sentinel);
      f.expectedCleanupFailures.add(error);
    },
  );
});

it("preserves private missing/invalid CCT 401 and Identity dependency 503 before owner admission", async () => {
  const f = await start();
  for (const token of [undefined, "invalid-context"]) {
    const response = await f.privateInitialize(token);
    expect(response.status).toBe(401);
    await response.text();
  }
  const verifier = vi
    .spyOn(CallerContextVerifier.prototype, "verify")
    .mockRejectedValueOnce(
      new CallerContextError("identity_dependency_unavailable"),
    );
  try {
    const response = await f.privateInitialize(
      identityHeaders(f.identity)[CALLER_CONTEXT_HEADER],
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "identity_dependency_unavailable",
    });
  } finally {
    verifier.mockRestore();
  }
  expect(f.admit).not.toHaveBeenCalled();
  expect(f.appB.createSession).not.toHaveBeenCalled();
});

it("keeps the original DELETE receipt window during ingress shutdown after an official client SSE is established", async () => {
  const f = await start();
  const ready = Promise.withResolvers<void>(),
    deleting = Promise.withResolvers<void>(),
    releaseDelete = Promise.withResolvers<void>(),
    deleted = Promise.withResolvers<number>();
  f.release.push(releaseDelete.resolve);
  const client = f.connect(async (input, init) => {
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "DELETE") {
      deleting.resolve();
      await releaseDelete.promise;
    }
    const response = await f.network(input, init);
    if (method === "GET" && response.status === 200) ready.resolve();
    if (method === "DELETE") deleted.resolve(response.status);
    return response;
  });
  await client.agent.request(acp.methods.agent.initialize, initialize.params);
  await ready.promise;
  let joined = false;
  const shutdown = f.ingress.close().then(() => {
    joined = true;
  });
  void shutdown.catch(() => undefined);
  try {
    await deleting.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(joined).toBe(false);
    releaseDelete.resolve();
    expect(await deleted.promise).toBe(202);
    await client.closed;
    await shutdown;
  } finally {
    releaseDelete.resolve();
    client.close();
    await Promise.allSettled([client.closed, shutdown]);
  }
}, 15000);

it("holds a cross-ingress DELETE until the original owner's real SDK cleanup completes", async () => {
  const f = await start();
  const id = await f.open();
  const cleanup = holdSdkCleanup();
  f.release.push(cleanup.release);
  let acknowledged = false;
  const deletion = f.send("a", "DELETE", id).then((response) => {
    acknowledged = true;
    return response;
  });
  void deletion.catch(() => undefined);
  try {
    await Promise.race([cleanup.entered, deletion]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acknowledged).toBe(false);
    cleanup.release();
    const response = await deletion;
    expect(response.status).toBe(202);
    await response.text();
    expect(cleanup.close).toHaveBeenCalledOnce();
  } finally {
    cleanup.release();
    await Promise.allSettled([
      deletion.then(async (response) => {
        if (!response.bodyUsed) await response.text();
      }),
    ]);
    cleanup.close.mockRestore();
  }
});

it("shares one ingress quota slot across remote connection/session GETs and POSTs and releases it after their cleanup", async () => {
  const f = await start(true);
  const deleted = Promise.withResolvers<number>();
  const client = f.connect(async (input, init) => {
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const response = await f.network(input, init);
    if (method === "DELETE") deleted.resolve(response.status);
    return response;
  });
  await client.agent.request(acp.methods.agent.initialize, initialize.params);
  await expect(
    client.agent.request(acp.methods.agent.session.new, newSession.params),
  ).resolves.toMatchObject({ sessionId: "session-1" });
  await vi.waitFor(() => {
    expect(f.activeSessionGets()).toContain(null);
    expect(f.activeSessionGets()).toContain("session-1");
  });
  const rejected = await f.send("a", "POST", undefined, initialize);
  expect(rejected.status).toBe(429);
  expect(rejected.headers.get("Retry-After")).toBe("1");
  await rejected.text();
  client.close();
  await client.closed;
  expect(await deleted.promise).toBe(202);
  await vi.waitFor(() => expect(f.activeSessionGets()).toEqual([]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const id = await f.open();
  const response = await f.send("a", "DELETE", id);
  expect(response.status).toBe(202);
  await response.text();
}, 15000);

it("relays the official SDK's session permission request and selected response through the non-owner ingress", async () => {
  const permissions = new PermissionConnections();
  const f = await start(false, permissions);
  const requested = Promise.withResolvers<acp.RequestPermissionRequest>(),
    answer = Promise.withResolvers<acp.RequestPermissionResponse>();
  const cancellation = new AbortController();
  const client = f.connect(undefined, undefined, (params) => {
    requested.resolve(params);
    return answer.promise;
  });
  const assertAccess = vi.fn<
    (connection: PermissionConnection) => Promise<void>
  >(() => Promise.resolve());
  let approval: Promise<unknown> | undefined;
  let answered = false;
  try {
    await client.agent.request(acp.methods.agent.initialize, initialize.params);
    const { sessionId } = await client.agent.request<acp.NewSessionResponse>(
      acp.methods.agent.session.new,
      newSession.params,
    );
    approval = permissions
      .request(
        {
          runId: "run-permission",
          sessionId,
          call: {
            id: "read-private",
            name: "read",
            arguments: { path: "private.txt" },
          },
          tool: {
            source: "runtime",
            sourceId: "runtime",
            name: "read",
            modelName: "read",
            description: "read",
          },
        },
        { ...f.identity, accessRevision: "access-1" },
        cancellation.signal,
        assertAccess,
      )
      .then((response) => {
        answered = true;
        return response;
      });
    void approval.catch(() => undefined);
    const permission = await requested.promise;
    expect(permission).toMatchObject({
      sessionId,
      toolCall: {
        toolCallId: "read-private",
        rawInput: { path: "private.txt" },
      },
    });
    expect(permission.options.map((option) => option.optionId)).toContain(
      "allow_once",
    );
    expect(answered).toBe(false);
    const selected: acp.RequestPermissionResponse = {
      outcome: { outcome: "selected", optionId: "allow_once" },
    };
    answer.resolve(selected);
    await expect(approval).resolves.toEqual(selected);
    expect(assertAccess).toHaveBeenCalledTimes(2);
    for (const [connection] of assertAccess.mock.calls)
      expect(connection.binding).toMatchObject({
        ...f.identity,
        ownerFence: f.fence,
      });
    expect(f.appA.createSession).not.toHaveBeenCalled();
    expect(f.appB.createSession).toHaveBeenCalledOnce();
  } finally {
    answer.resolve({ outcome: { outcome: "cancelled" } });
    cancellation.abort();
    client.close();
    await Promise.allSettled([approval, client.closed]);
  }
}, 15000);

it("relays an official SDK session/cancel to the original owner and completes its held Prompt as cancelled", async () => {
  const f = await start();
  const completion = Promise.withResolvers<ExecuteRunResult>();
  const cancelled: ExecuteRunResult = {
    terminalClass: "cancelled",
    executorState: "quiescent",
    toolEffectState: "none",
  };
  f.appB.acceptPrompt.mockImplementation(({ sessionId }) =>
    Promise.resolve({
      outputSequence: 0,
      runId: "run-cancel",
      requestId: "request-cancel",
      sessionId,
      userMessageId: "user-cancel",
      snapshot: snapshot(),
      completion: completion.promise,
    }),
  );
  f.appB.cancelRun.mockImplementation(() => {
    completion.resolve(cancelled);
    return Promise.resolve();
  });
  const client = f.connect();
  let prompt: Promise<acp.PromptResponse> | undefined;
  try {
    await client.agent.request(acp.methods.agent.initialize, initialize.params);
    const { sessionId } = await client.agent.request<acp.NewSessionResponse>(
      acp.methods.agent.session.new,
      newSession.params,
    );
    prompt = client.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "wait for cancellation" }],
    });
    void prompt.catch(() => undefined);
    await vi.waitFor(() => expect(f.appB.acceptPrompt).toHaveBeenCalledOnce());
    await client.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(f.appB.cancelRun).toHaveBeenCalledOnce();
    expect(f.appB.cancelRun.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      binding: { ...f.identity, ownerFence: f.fence },
    });
    expect(f.appB.acceptPrompt.mock.calls[0]?.[0].binding).toMatchObject({
      ...f.identity,
      ownerFence: f.fence,
    });
    expect(f.appA.acceptPrompt).not.toHaveBeenCalled();
    expect(f.appA.cancelRun).not.toHaveBeenCalled();
  } finally {
    completion.resolve(cancelled);
    client.close();
    await Promise.allSettled([prompt, completion.promise, client.closed]);
  }
}, 15000);

it("replays a session/load through the non-owner relay into a fresh official SDK connection", async () => {
  const f = await start();
  const original = f.connect();
  const notifications: Notice[] = [];
  let restored: acp.ClientConnection | undefined;
  try {
    await original.agent.request(
      acp.methods.agent.initialize,
      initialize.params,
    );
    const { sessionId } = await original.agent.request<acp.NewSessionResponse>(
      acp.methods.agent.session.new,
      newSession.params,
    );
    original.close();
    await original.closed;
    f.appB.resumeSession.mockResolvedValueOnce({
      replay: [
        {
          kind: "user_message",
          messageId: "history-user",
          content: [{ type: "text", text: "saved question" }],
        },
        {
          kind: "agent_message",
          messageId: "history-answer",
          content: [{ type: "text", text: "saved answer" }],
        },
      ],
      sequence: 2,
    });
    f.appB.readSessionOutput.mockResolvedValue({
      sequence: 2,
      events: [],
      state: { kind: "state", state: "idle" },
    });
    restored = f.connect(undefined, (notice) => notifications.push(notice));
    await restored.agent.request(
      acp.methods.agent.initialize,
      initialize.params,
    );
    await restored.agent.request(acp.methods.agent.session.load, {
      ...newSession.params,
      sessionId,
    });
    await vi.waitFor(() =>
      expect(
        notifications.filter(
          ({ update }) =>
            update.sessionUpdate === "user_message_chunk" ||
            update.sessionUpdate === "agent_message_chunk",
        ),
      ).toEqual([
        {
          sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: "history-user",
            content: { type: "text", text: "saved question" },
          },
        },
        {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "history-answer",
            content: { type: "text", text: "saved answer" },
          },
        },
      ]),
    );
    expect(f.appB.resumeSession).toHaveBeenCalledOnce();
    expect(f.appB.resumeSession.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      cwd: "/workspace",
      mcpServers: [],
      replayFromStart: true,
      binding: { ...f.identity, ownerFence: f.fence },
    });
    expect(
      f.appB.resumeSession.mock.calls[0]?.[0].binding.connectionId,
    ).not.toBe(f.appB.createSession.mock.calls[0]?.[0].binding.connectionId);
    expect(f.appA.resumeSession).not.toHaveBeenCalled();
    expect(restored.signal.aborted).toBe(false);
  } finally {
    original.close();
    restored?.close();
    await Promise.allSettled([original.closed, restored?.closed]);
  }
}, 15000);
