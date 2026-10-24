import { randomBytes, randomUUID } from "node:crypto";
import { createServer, ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { testAuthentication } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import {
  binding,
  identityHeaders,
} from "../../../../services/agent-acp-service/test/support/fixtures.js";
import { SecretBox } from "../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { HttpOwnerHandles } from "../../../../services/agent-acp-service/src/application/http-owner-handle.js";
import type { OwnerRegistration } from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import type { OwnerForwardRequest } from "../../../../services/agent-acp-service/src/application/owner-forwarding.js";
import type { AgentExecutionStateView } from "../../../../services/agent-acp-service/src/domain/agent-execution-state.js";
import type { AgentOwnershipFence } from "../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import type {
  ExecutionAccessSnapshot,
  ExecutionIdentity,
} from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import type { AgentExecutionStatePort } from "../../../../services/agent-acp-service/src/ports/agent-execution-state.js";
import { AGENT_EXECUTION_WATCH_PATH } from "../../../../services/agent-acp-service/src/transport/agent-execution-state.js";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import type { HttpOwnerForwardingOptions } from "../../../../services/agent-acp-service/src/transport/owner-http.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    const results = await Promise.allSettled(
      cleanups
        .splice(0)
        .reverse()
        .map((close) => close()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Owner state fixture cleanup failed");
  } finally {
    vi.restoreAllMocks();
  }
});

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

async function start() {
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
  const ready: AgentExecutionStateView = {
    agent_id: identity.agentId,
    access_allowed: true,
    availability: "ready",
    active_session_id: null,
    configuration_revision: "c".repeat(64),
    unavailable_reason: null,
  };
  const revoked: ExecutionAccessSnapshot = {
    organization_id: identity.organizationId,
    agents: [],
  };
  const ownerState = {
    read: vi.fn<AgentExecutionStatePort["read"]>(
      async (_identity, send, signal) => send(ready, signal),
    ),
    watch: vi.fn<AgentExecutionStatePort["watch"]>(
      async (_identity, send, signal) => {
        await send(ready, signal);
        await aborted(signal);
      },
    ),
  };
  const unexpected = () =>
    Promise.reject(new Error("State forwarding cannot dispatch ACP commands"));
  const application: AcpApplicationPort = {
    assertAccess: unexpected,
    getSessionConfiguration: unexpected,
    setSessionConfiguration: unexpected,
    createSession: unexpected,
    listSessions: unexpected,
    deleteSession: unexpected,
    forkSession: unexpected,
    closeSession: unexpected,
    cancelRun: unexpected,
    resumeSession: unexpected,
    readSessionOutput: unexpected,
    acceptPrompt: unexpected,
  };
  const ingressState = {
    read: vi.fn<AgentExecutionStatePort["read"]>(unexpected),
    watch: vi.fn<AgentExecutionStatePort["watch"]>(unexpected),
  };
  const releases: Array<() => void> = [];
  const callers: AbortController[] = [];
  const responses = new Set<Response>();
  const originals = new Set<Promise<unknown>>();
  const handlerFailures: unknown[] = [];
  let ingress: AgentAcpHttpServer | undefined = undefined;
  let owner: AgentAcpHttpServer | undefined = undefined;
  const join = <T>(original: Promise<T>): Promise<T> => {
    originals.add(original);
    const forget = () => originals.delete(original);
    void original.then(forget, forget);
    return original;
  };

  // Already-authenticated directional member boundary. Real member credentials
  // remain covered by PeerServer and the two-main acceptance, not public headers.
  const peer = createServer((request, response) => {
    response.shouldKeepAlive = false;
    response.setHeader("Connection", "close");
    const cancellation = new AbortController();
    const cancel = () => {
      if (!response.writableFinished) cancellation.abort();
    };
    request.once("aborted", cancel);
    response.once("close", cancel);
    const original = join(
      (async () => {
        try {
          if (owner === undefined)
            throw new Error("Owner listener is not ready");
          await owner.handlePeerControl(
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
      })(),
    );
    void original.catch((error: unknown) => {
      handlerFailures.push(error);
      response.destroy();
    });
  });
  cleanups.push(async () => {
    for (const release of releases) release();
    const results: PromiseSettledResult<unknown>[] = [];
    for (const response of responses)
      if (response.body !== null && !response.bodyUsed && !response.body.locked)
        results.push(...(await Promise.allSettled([response.body.cancel()])));
    for (const caller of callers) caller.abort();
    results.push(
      ...(await Promise.allSettled([ingress?.close(), owner?.close()])),
    );
    results.push(
      ...(await Promise.allSettled([
        new Promise<void>((resolve, reject) => {
          peer.close((error) => (error ? reject(error) : resolve()));
          peer.closeAllConnections();
        }),
      ])),
    );
    while (originals.size) await Promise.allSettled([...originals]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (handlerFailures.length || failures.length)
      throw new AggregateError(
        [...handlerFailures, ...failures],
        "Original state HTTP cleanup failed",
      );
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const address = peer.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing private state listener");
  const privateOrigin = `http://127.0.0.1:${address.port}`;
  const sha = "a".repeat(64),
    key = randomBytes(32);
  const handles = () =>
    new HttpOwnerHandles({
      secretBox: new SecretBox(Buffer.from(key)),
      membershipSha256: sha,
    });
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
      if (member !== b.member_id) throw new Error("Unexpected state owner");
      return (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.origin !== privateOrigin)
          throw new Error("Unexpected peer origin");
        return join(fetch(input, init));
      };
    },
  };
  const target = (selected = identity): OwnerForwardRequest => ({
    request_id: randomUUID(),
    deadline_at: new Date(Date.now() + 10000).toISOString(),
    membership_sha256: sha,
    source: a,
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
  const resolver = {
    resolve: vi.fn<HttpOwnerForwardingOptions["resolver"]["resolve"]>(
      (selected) => Promise.resolve(target(selected)),
    ),
  };
  const lifetime = new AbortController();
  const admit: HttpOwnerForwardingOptions["admit"] = (request, signal) => {
    signal.throwIfAborted();
    expect(request.target).toEqual(b);
    return Promise.resolve({
      fence,
      signal: lifetime.signal,
      assertCurrent: () => lifetime.signal.throwIfAborted(),
    });
  };
  const ownerServer = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application,
    executionState: ownerState,
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 4096,
    stateDeliveryTimeoutMs: 50,
    httpForwarding: {
      registration: b,
      handles: handles(),
      peers,
      admit,
      resolver: { resolve: () => Promise.resolve(null) },
    },
  });
  owner = ownerServer;
  const ingressServer = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application,
    executionState: ingressState,
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 4096,
    stateDeliveryTimeoutMs: 50,
    httpForwarding: {
      registration: a,
      handles: handles(),
      peers,
      admit,
      resolver,
    },
  });
  ingress = ingressServer;
  await ownerServer.listen("127.0.0.1", 0);
  await ingressServer.listen("127.0.0.1", 0);
  const ingressAddress = ingressServer.address();
  if (ingressAddress === null || typeof ingressAddress === "string")
    throw new Error("Missing public state listener");
  const request = () => {
    const caller = new AbortController();
    callers.push(caller);
    const original = join(
      fetch(
        `http://127.0.0.1:${ingressAddress.port}${AGENT_EXECUTION_WATCH_PATH}`,
        {
          method: "POST",
          headers: {
            ...identityHeaders(identity),
            "Content-Type": "application/json",
          },
          body: "{}",
          signal: caller.signal,
        },
      ).then((response) => {
        responses.add(response);
        return response;
      }),
    );
    return { caller, original };
  };
  return {
    ingress: ingressServer,
    owner: ownerServer,
    ingressPort: ingressAddress.port,
    ownerState,
    ingressState,
    resolver,
    target,
    ready,
    revoked,
    releases,
    join,
    request,
  };
}

it("revokes a resolver-held state watch before adoption but joins the original lookup", async () => {
  const f = await start();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.releases.push(release.resolve);
  let resolving: AbortSignal | undefined;
  f.resolver.resolve.mockImplementationOnce(
    async (_identity, _protocol, signal) => {
      resolving = signal;
      entered.resolve();
      await release.promise;
      return f.target();
    },
  );
  const request = f.request();
  const outcome = f.join(
    request.original
      .then(async (response) => ({
        status: response.status,
        body: await response.text(),
      }))
      .catch((error: unknown) => ({ error })),
  );
  let acknowledged = false;
  let revocation: Promise<void> | undefined;
  try {
    await entered.promise;
    revocation = f.ingress.revokeAccess(f.revoked).then(() => {
      acknowledged = true;
    });
    void revocation.catch(() => undefined);
    await turn();
    expect(resolving?.aborted).toBe(true);
    expect(
      acknowledged,
      "cancelling lookup is not its original completion",
    ).toBe(false);
    release.resolve();
    await revocation;
    const result = await outcome;
    expect("status" in result && result.status === 200).toBe(false);
    expect(f.ownerState.read).not.toHaveBeenCalled();
    expect(f.ownerState.watch).not.toHaveBeenCalled();
  } finally {
    request.caller.abort();
    await turn();
    release.resolve();
    await Promise.allSettled([outcome, revocation]);
  }
});

it("bounds a stalled ingress SSE write and joins the original owner watch cleanup before ACK", async () => {
  const f = await start();
  const blocked = Promise.withResolvers<void>(),
    releaseCleanup = Promise.withResolvers<void>();
  f.releases.push(releaseCleanup.resolve);
  let cancelled = false,
    cleaned = false;
  f.ownerState.watch.mockImplementation(async (_identity, send, signal) => {
    await send(f.ready, signal);
    await aborted(signal);
    cancelled = true;
    await releaseCleanup.promise;
    cleaned = true;
  });
  // Only the ingress's real SSE response reports backpressure. No drain is
  // fabricated; the owner listener and its port remain independently live.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalWrite = ServerResponse.prototype.write;
  const write = vi
    .spyOn(ServerResponse.prototype, "write")
    .mockImplementation(function (this: ServerResponse, ...args: unknown[]) {
      const sent = Reflect.apply(originalWrite, this, args) as boolean;
      if (
        this.socket?.localPort === f.ingressPort &&
        this.getHeader("content-type") === "text/event-stream"
      ) {
        blocked.resolve();
        return false;
      }
      return sent;
    });
  const request = f.request();
  let body: Promise<unknown> | undefined;
  let ingressRevocation: Promise<void> | undefined,
    ownerRevocation: Promise<void> | undefined;
  let ownerAcknowledged = false;
  try {
    const response = await request.original;
    expect(response.status).toBe(200);
    body = f.join(
      response.text().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
    );
    await blocked.promise;
    ingressRevocation = f.ingress.revokeAccess(f.revoked);
    ownerRevocation = f.owner.revokeAccess(f.revoked).then(() => {
      ownerAcknowledged = true;
    });
    void ingressRevocation.catch(() => undefined);
    void ownerRevocation.catch(() => undefined);
    await vi.waitFor(() => expect(cancelled).toBe(true), {
      timeout: 500,
      interval: 10,
    });
    expect(cleaned).toBe(false);
    expect(
      ownerAcknowledged,
      "port cancellation cannot replace original cleanup",
    ).toBe(false);
    releaseCleanup.resolve();
    await Promise.all([body, ingressRevocation, ownerRevocation]);
    expect(cleaned).toBe(true);
    expect(ownerAcknowledged).toBe(true);
  } finally {
    write.mockRestore();
    request.caller.abort();
    releaseCleanup.resolve();
    await Promise.allSettled([
      request.original,
      body,
      ingressRevocation,
      ownerRevocation,
    ]);
  }
}, 15000);
