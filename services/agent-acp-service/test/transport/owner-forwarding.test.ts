import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  AgentAcpHttpServer,
  type AgentAcpHttpServerOptions,
} from "../../src/transport/http-server.js";
import type { OwnerForwardRequest } from "../../src/application/owner-forwarding.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";
import { testAuthentication, testHeaders } from "../support/auth-fixture.js";

const identity = {
  organizationId: "organization-1",
  principalId: "principal-1",
  agentId: "agent-1",
};
const target = (): OwnerForwardRequest => ({
  request_id: randomUUID(),
  deadline_at: new Date(Date.now() + 10000).toISOString(),
  membership_sha256: "a".repeat(64),
  source: { registration_id: randomUUID(), incarnation_id: randomUUID(), member_id: "acp-a" },
  target: { registration_id: randomUUID(), incarnation_id: randomUUID(), member_id: "acp-b" },
  publication: {
    organization_id: identity.organizationId,
    revision: 1,
    authority_sha256: "b".repeat(64),
  },
  identity,
  epoch: "1",
  protocol: "v1",
  caller: "agent-ui",
  hop: 1,
});
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  for (const result of results) if (result.status === "rejected") throw result.reason;
});
async function start(
  forwarding: NonNullable<AgentAcpHttpServerOptions["forwarding"]>,
  expectCloseFailure = false,
  capacity = 1,
) {
  const server = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application: {} as AcpApplicationPort,
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 65536,
    connectionLimits: { global: capacity, organization: capacity, principal: capacity },
    forwarding,
  });
  cleanups.push(async () => {
    if (expectCloseFailure) await expect(server.close()).rejects.toThrow();
    else await server.close();
  });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing listener");
  const dial = () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/acp`, {
      headers: testHeaders({ "x-antnest-agent-id": identity.agentId }),
    });
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.on("error", () => undefined);
    cleanups.push(async () => {
      socket.terminate();
      await closed;
    });
    return { socket, closed };
  };
  return { server, dial };
}
const admit = vi.fn<NonNullable<AgentAcpHttpServerOptions["forwarding"]>["admit"]>();
function peerRequest(headers = testHeaders({ "x-antnest-agent-id": identity.agentId })) {
  const request = new IncomingMessage(new Socket());
  request.method = "GET";
  request.headers = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  request.rawHeaders = Object.entries(headers).flat();
  cleanups.push(() => {
    request.destroy();
    return Promise.resolve();
  });
  return request;
}
it("releases ingress capacity after each synchronous peer dial failure", async () => {
  const connect = vi.fn((): WebSocket => {
    throw new Error("service_credential_invalid");
  });
  const f = await start({
    resolver: { resolve: () => Promise.resolve(target()) },
    peers: { connect },
    admit,
  });
  for (let i = 0; i < 3; i++) await f.dial().closed;
  expect(connect).toHaveBeenCalledTimes(3);
});
it("revocation joins the original owner lookup before acknowledging", async () => {
  const held = Promise.withResolvers<OwnerForwardRequest | null>();
  const entered = Promise.withResolvers<AbortSignal>();
  const connect = vi.fn((): WebSocket => {
    throw new Error("must not dial");
  });
  const f = await start({
    resolver: {
      resolve: (_identity, _protocol, signal) => {
        entered.resolve(signal);
        return held.promise;
      },
    },
    peers: { connect },
    admit,
  });
  cleanups.push(() => {
    held.resolve(null);
    return Promise.resolve();
  });
  const client = f.dial();
  const signal = await entered.promise;
  let finished = false;
  const revoked = f.server
    .revokeAccess({ organization_id: identity.organizationId, agents: [] })
    .then(() => {
      finished = true;
    });
  expect(signal.aborted).toBe(true);
  await Promise.resolve();
  expect(finished).toBe(false);
  held.resolve(null);
  await revoked;
  await client.closed;
  expect(connect).not.toHaveBeenCalled();
});
it("owner revocation joins pending private admission before acknowledging", async () => {
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<AbortSignal>();
  const f = await start({
    resolver: { resolve: () => Promise.resolve(null) },
    peers: { connect: vi.fn() },
    admit: async (_target, signal) => {
      entered.resolve(signal);
      await held.promise;
      throw new Error("original admission finished");
    },
  });
  const request = peerRequest();
  const prepared = f.server
    .preparePeerWebSocket(request, target(), new AbortController().signal)
    .catch((error: unknown) => error);
  cleanups.push(async () => {
    held.resolve();
    await prepared;
    request.destroy();
  });
  const signal = await entered.promise;
  let finished = false;
  const revoked = f.server
    .revokeAccess({ organization_id: identity.organizationId, agents: [] })
    .then(() => {
      finished = true;
    });
  cleanups.push(async () => {
    held.resolve();
    await revoked;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(signal.aborted).toBe(true);
  expect(finished).toBe(false);
  held.resolve();
  await prepared;
  await revoked;
});
it("revocation cancels a prepared owner admission without waiting for accept", async () => {
  const expected = target();
  const f = await start({
    resolver: { resolve: () => Promise.resolve(null) },
    peers: { connect: vi.fn() },
    admit: () =>
      Promise.resolve({
        fence: {
          organizationId: identity.organizationId,
          agentId: identity.agentId,
          ownerInstanceId: expected.target.incarnation_id,
          epoch: expected.epoch,
        },
        signal: new AbortController().signal,
        assertCurrent: () => undefined,
      }),
  });
  const request = peerRequest();
  const prepared = await f.server.preparePeerWebSocket(
    request,
    expected,
    new AbortController().signal,
  );
  await f.server.revokeAccess({ organization_id: identity.organizationId, agents: [] });
  expect(request.socket.closed).toBe(true);
  prepared.cancel();
});
it.each(["missing CCT", "different identity"])(
  "rejects a forwarded request with %s before owner admission",
  async (mode) => {
    const check = vi.fn<NonNullable<AgentAcpHttpServerOptions["forwarding"]>["admit"]>();
    const f = await start({
      resolver: { resolve: () => Promise.resolve(null) },
      peers: { connect: vi.fn() },
      admit: check,
    });
    const expected = {
      ...target(),
      identity:
        mode === "different identity"
          ? { ...identity, principalId: "another-principal" }
          : identity,
    };
    const request = mode === "missing CCT" ? peerRequest({}) : peerRequest();
    await expect(
      f.server.preparePeerWebSocket(request, expected, new AbortController().signal),
    ).rejects.toThrow();
    expect(check).not.toHaveBeenCalled();
  },
);
it("retains missing cleanup receipts for subsequent scope revocation", async () => {
  const peer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => peer.once("listening", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of peer.clients) client.terminate();
        peer.close(() => resolve());
      }),
  );
  const address = peer.address();
  if (address === null || typeof address === "string") throw new Error("Missing peer listener");
  const accepted = Promise.withResolvers<WebSocket>();
  peer.once("connection", (socket) => accepted.resolve(socket));
  const f = await start(
    {
      resolver: { resolve: () => Promise.resolve(target()) },
      peers: { connect: () => new WebSocket(`ws://127.0.0.1:${address.port}`) },
      admit,
    },
    true,
  );
  const client = f.dial();
  await new Promise<void>((resolve) => client.socket.once("open", resolve));
  const original = await accepted.promise;
  original.terminate();
  await client.closed;
  const snapshot = { organization_id: identity.organizationId, agents: [] };
  await expect(f.server.revokeAccess(snapshot)).rejects.toThrow();
  await expect(f.server.revokeAccess(snapshot)).rejects.toThrow();
  await expect(
    f.server.revokeAccess({ organization_id: "healthy-other", agents: [] }),
  ).resolves.toBeUndefined();
});
it("shutdown joins another original connection after one cleanup fails", async () => {
  const peer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => peer.once("listening", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of peer.clients) socket.terminate();
        peer.close(() => resolve());
      }),
  );
  const address = peer.address();
  if (address === null || typeof address === "string") throw new Error("Missing peer listener");
  const destinations = [target(), target()];
  let index = 0;
  const f = await start(
    {
      resolver: { resolve: () => Promise.resolve(destinations[index++]!) },
      peers: { connect: () => new WebSocket(`ws://127.0.0.1:${address.port}`) },
      admit,
    },
    true,
    2,
  );
  const originals: WebSocket[] = [];
  for (let i = 0; i < 2; i++) {
    const accepted = new Promise<WebSocket>((resolve) => peer.once("connection", resolve));
    const client = f.dial();
    await new Promise<void>((resolve) => client.socket.once("open", resolve));
    originals.push(await accepted);
  }
  let finished = false;
  const shutdown = f.server
    .close()
    .catch((error: unknown) => error)
    .finally(() => {
      finished = true;
    });
  const release = async () => {
    if (originals[1]!.readyState === WebSocket.OPEN) {
      originals[1]!.send(
        JSON.stringify({ type: "joined", request_id: destinations[1]!.request_id }),
      );
      originals[1]!.close();
    }
    await shutdown;
  };
  cleanups.push(release);
  originals[0]!.terminate();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  await release();
  expect(await shutdown).toBeInstanceOf(AggregateError);
});

async function abruptForwarding(
  expected: OwnerForwardRequest,
  stopped: (registration: OwnerForwardRequest["target"]) => boolean,
  expectCloseFailure: boolean,
  decorate?: (wire: WebSocket) => void,
) {
  const peer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => peer.once("listening", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of peer.clients) socket.terminate();
        peer.close(() => resolve());
      }),
  );
  const address = peer.address();
  if (address === null || typeof address === "string") throw new Error("Missing peer listener");
  const accepted = Promise.withResolvers<WebSocket>();
  peer.once("connection", (socket) => accepted.resolve(socket));
  const f = await start(
    {
      resolver: { resolve: () => Promise.resolve(expected) },
      peers: {
        connect: () => {
          const wire = new WebSocket(`ws://127.0.0.1:${address.port}`);
          decorate?.(wire);
          return wire;
        },
      },
      admit,
      stopped,
    },
    expectCloseFailure,
  );
  const client = f.dial();
  await new Promise<void>((resolve) => client.socket.once("open", resolve));
  const original = await accepted.promise;
  const peerClosed = new Promise<void>((resolve) => original.once("close", () => resolve()));
  return { ...f, client, original, peerClosed };
}

it.each(["missing", "another incarnation"] as const)(
  "keeps an abruptly disconnected owner unknown with %s stop evidence",
  async (evidence) => {
    const expected = target();
    const foreign = {
      ...expected.target,
      registration_id: randomUUID(),
      incarnation_id: randomUUID(),
    };
    const stopped = vi.fn(
      (registration: OwnerForwardRequest["target"]) =>
        evidence === "another incarnation" &&
        registration.registration_id === foreign.registration_id &&
        registration.member_id === foreign.member_id &&
        registration.incarnation_id === foreign.incarnation_id,
    );
    const f = await abruptForwarding(expected, stopped, true);
    f.original.terminate();
    await Promise.all([f.peerClosed, f.client.closed]);
    const snapshot = { organization_id: identity.organizationId, agents: [] };
    await expect(f.server.revokeAccess(snapshot)).rejects.toThrow();
    await expect(f.server.revokeAccess(snapshot)).rejects.toThrow();
    await expect(
      f.server.revokeAccess({ organization_id: "healthy-other", agents: [] }),
    ).resolves.toBeUndefined();
    await expect(f.server.close()).rejects.toThrow();
    expect(stopped).toHaveBeenCalledWith(expected.target);
  },
);

it("allows later revocation and shutdown only after the original disconnected owner is proven stopped", async () => {
  const expected = target();
  const originalRegistration = structuredClone(expected.target);
  let proof: OwnerForwardRequest["target"] | undefined;
  const stopped = vi.fn(
    (registration: OwnerForwardRequest["target"]) =>
      proof !== undefined &&
      registration.registration_id === proof.registration_id &&
      registration.member_id === proof.member_id &&
      registration.incarnation_id === proof.incarnation_id,
  );
  const f = await abruptForwarding(expected, stopped, false);
  f.original.terminate();
  await Promise.all([f.peerClosed, f.client.closed]);
  const snapshot = { organization_id: identity.organizationId, agents: [] };
  await expect(f.server.revokeAccess(snapshot)).rejects.toThrow();
  proof = { ...originalRegistration, incarnation_id: randomUUID() };
  await expect(f.server.revokeAccess(snapshot)).rejects.toThrow();
  proof = originalRegistration;
  await expect(f.server.revokeAccess(snapshot)).resolves.toBeUndefined();
  await expect(f.server.close()).resolves.toBeUndefined();
  expect(stopped).toHaveBeenCalledWith(originalRegistration);
});

it("joins a held original send and retains its independent failure even when that owner is stopped", async () => {
  const expected = target();
  const sent = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sentinel = new Error("original local peer frame send failed");
  const sends: Promise<void>[] = [];
  let proof = false;
  const f = await abruptForwarding(
    expected,
    (registration) =>
      proof &&
      registration.registration_id === expected.target.registration_id &&
      registration.member_id === expected.target.member_id &&
      registration.incarnation_id === expected.target.incarnation_id,
    true,
    (wire) => {
      const originalSend = wire.send.bind(wire);
      Object.defineProperty(wire, "send", {
        configurable: true,
        value: (value: string, done: (error?: Error) => void) => {
          const frame = JSON.parse(value) as { type?: unknown };
          if (frame.type !== "frame") {
            originalSend(value, done);
            return;
          }
          originalSend(value, (originalError) => {
            sent.resolve();
            const original = release.promise.then(() => done(originalError ?? sentinel));
            sends.push(original);
            void original.catch(() => undefined);
          });
        },
      });
    },
  );
  let revocation: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  const failures: unknown[] = [];
  try {
    f.client.socket.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    await sent.promise;
    f.original.terminate();
    // The ingress intentionally pauses client reads until its original send
    // callback joins; waiting for that client's close before releasing it deadlocks.
    await f.peerClosed;
    proof = true;
    let settled = false;
    revocation = f.server
      .revokeAccess({ organization_id: identity.organizationId, agents: [] })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => {
        settled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve();
    const result = await revocation;
    await f.client.closed;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(nestedErrors(result.error)).toContain(sentinel);
    await expect(f.server.close()).rejects.toThrow();
  } catch (error) {
    failures.push(error);
  } finally {
    release.resolve();
    for (const result of await Promise.allSettled([...sends, revocation]))
      if (result.status === "rejected") failures.push(result.reason as unknown);
  }
  if (failures.length) throw new AggregateError(failures, "Original send fixture failed");
});

function nestedErrors(error: unknown): unknown[] {
  const children: unknown[] =
    error instanceof AggregateError ? [...(error.errors as unknown[])] : [];
  if (error instanceof Error && error.cause !== undefined) children.push(error.cause);
  return [error, ...children.flatMap(nestedErrors)];
}
