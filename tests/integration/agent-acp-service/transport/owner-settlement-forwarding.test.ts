import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  testAuthentication,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { CALLER_CONTEXT_HEADER } from "../../../../services/agent-acp-service/src/adapters/caller-context.js";
import { SecretBox } from "../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { HttpOwnerHandles } from "../../../../services/agent-acp-service/src/application/http-owner-handle.js";
import {
  controlBodyDigest,
  encodeOwnerControl,
  parseOwnerControl,
  type OwnerControlRequest,
} from "../../../../services/agent-acp-service/src/application/owner-control-forwarding.js";
import { OWNER_FORWARD_HEADER } from "../../../../services/agent-acp-service/src/application/owner-forwarding.js";
import type { OwnerRegistration } from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import type {
  AgentSettlementRequest,
  AgentSettlementResult,
} from "../../../../services/agent-acp-service/src/domain/agent-settlement.js";
import type { ExecutionAccessSnapshot } from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import type { ExecutionPublication } from "../../../../services/agent-acp-service/src/domain/execution-publication.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import { AGENT_SETTLEMENT_PATH } from "../../../../services/agent-acp-service/src/transport/agent-settlement.js";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import type { HttpOwnerForwardingOptions } from "../../../../services/agent-acp-service/src/transport/owner-http.js";

type SettlementContext = Extract<
  OwnerControlRequest,
  { operation: "settlement" }
>;
type SettlementCall = (
  input: unknown,
  signal?: AbortSignal,
  expected?: { owner: OwnerRegistration; publication: ExecutionPublication },
) => Promise<AgentSettlementResult>;
type Outcome = { status: number; body: unknown } | { error: unknown };

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
      throw new AggregateError(
        failures,
        "Owner settlement fixture cleanup failed",
      );
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

function only(error: unknown, expected: unknown): boolean {
  return (
    error === expected ||
    (error instanceof AggregateError &&
      error.errors.length > 0 &&
      error.errors.every((entry: unknown) => only(entry, expected)))
  );
}

async function beforeResponse(
  entered: Promise<void>,
  outcome: Promise<Outcome>,
) {
  await Promise.race([
    entered,
    outcome.then(() => {
      throw new Error(
        "Settlement responded before the original owner task started",
      );
    }),
  ]);
}

async function start() {
  const registration = (member_id: string): OwnerRegistration => ({
    registration_id: randomUUID(),
    member_id,
    incarnation_id: randomUUID(),
  });
  const a = registration("acp-a"),
    b = registration("acp-b");
  const input: AgentSettlementRequest = {
    organization_id: "organization-settlement",
    agent_id: "closed-agent",
    minimum_revision: 7,
    operation_id: "closed-operation",
    mode: "cancel",
    deadline_at: new Date(Date.now() + 8000).toISOString(),
  };
  const publication: ExecutionPublication = {
    organization_id: input.organization_id,
    revision: 7,
    authority_sha256: "b".repeat(64),
  };
  const result: AgentSettlementResult = {
    applied_revision: 7,
    outcome: "runtime_barrier_required",
  };
  const revoked: ExecutionAccessSnapshot = {
    organization_id: input.organization_id,
    agents: [],
  };
  const unexpected = () =>
    Promise.reject(
      new Error(
        "Settlement cannot dispatch ACP execution or acquire a live lease",
      ),
    );
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
  const ownerSettlement = {
    settle: vi.fn<SettlementCall>(() => Promise.resolve(result)),
  };
  const ingressSettlement = { settle: vi.fn<SettlementCall>(unexpected) };
  const releases: Array<() => void> = [];
  const callers: AbortController[] = [];
  const responses = new Set<Response>();
  const originals = new Set<Promise<unknown>>();
  const handlerFailures: unknown[] = [];
  const expectedCleanupFailures = new Set<unknown>();
  const peerRequests: Array<{
    method: string | undefined;
    url: string | undefined;
    context: SettlementContext;
    callerContext: string | string[] | undefined;
  }> = [];
  let ingress: AgentAcpHttpServer | undefined = undefined;
  let owner: AgentAcpHttpServer | undefined = undefined;
  let wrapUpstream: (
    response: Response,
    signal: AbortSignal | undefined,
  ) => Response = (response) => response;
  const join = <T>(original: Promise<T>): Promise<T> => {
    originals.add(original);
    const forget = () => originals.delete(original);
    void original.then(forget, forget);
    return original;
  };

  // As in owner-state-forwarding, this is the already-authenticated directional
  // member boundary. PeerServer and two-main tests own real peer credentials.
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
          const header = request.headers[OWNER_FORWARD_HEADER.toLowerCase()];
          if (typeof header !== "string")
            throw new Error("Missing settlement peer context");
          const context = parseOwnerControl(header);
          if (context.operation !== "settlement")
            throw new Error("Unexpected owner operation");
          peerRequests.push({
            method: request.method,
            url: request.url,
            context,
            callerContext: request.headers[CALLER_CONTEXT_HEADER.toLowerCase()],
          });
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
    const expected = (error: unknown) =>
      [...expectedCleanupFailures].some((sentinel) => only(error, sentinel));
    const failures = results.flatMap((settled) =>
      settled.status === "rejected" && !expected(settled.reason)
        ? [settled.reason as unknown]
        : [],
    );
    if (handlerFailures.length || failures.length)
      throw new AggregateError(
        [...handlerFailures, ...failures],
        "Original settlement HTTP cleanup failed",
      );
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const privateAddress = peer.address();
  if (privateAddress === null || typeof privateAddress === "string")
    throw new Error("Missing private settlement listener");
  const privateOrigin = `http://127.0.0.1:${privateAddress.port}`;
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
      if (member !== b.member_id)
        throw new Error("Unexpected settlement owner");
      return (selected, init) => {
        const url = new URL(
          selected instanceof Request ? selected.url : String(selected),
        );
        if (url.origin !== privateOrigin)
          throw new Error("Unexpected peer origin");
        const signal =
          init?.signal ??
          (selected instanceof Request ? selected.signal : undefined);
        return join(
          fetch(selected, init).then((response) =>
            wrapUpstream(response, signal ?? undefined),
          ),
        );
      };
    },
  };
  const target = (selected = input): SettlementContext => ({
    operation: "settlement",
    caller: "agent-controller",
    request_id: randomUUID(),
    deadline_at: selected.deadline_at,
    membership_sha256: sha,
    source: a,
    target: b,
    publication,
    scope: {
      organizationId: selected.organization_id,
      agentId: selected.agent_id,
    },
    body_sha256: controlBodyDigest(selected),
    hop: 1,
  });
  // A closed Agent has no execution identity/epoch to resolve. The added
  // optional method is intentionally structural until production implements it.
  const resolver = {
    resolve:
      vi.fn<HttpOwnerForwardingOptions["resolver"]["resolve"]>(unexpected),
    resolveSettlement: vi.fn<
      (
        selected: AgentSettlementRequest,
        signal: AbortSignal,
      ) => Promise<SettlementContext | null>
    >((selected) => Promise.resolve(target(selected))),
  };
  const admit = vi.fn<HttpOwnerForwardingOptions["admit"]>(unexpected);
  const localResolver = {
    resolve: resolver.resolve,
    resolveSettlement: () => Promise.resolve(null),
  };
  const ownerServer = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application,
    settlement: ownerSettlement,
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 4096,
    httpForwarding: {
      registration: b,
      handles: handles(),
      peers,
      admit,
      resolver: localResolver,
    },
  });
  owner = ownerServer;
  const ingressServer = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application,
    settlement: ingressSettlement,
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 4096,
    httpForwarding: {
      registration: a,
      handles: handles(),
      peers,
      admit,
      resolver,
    },
  });
  ingress = ingressServer;
  await ownerServer.listenControl("127.0.0.1", 0);
  await ingressServer.listenControl("127.0.0.1", 0);
  const ingressAddress = ingressServer.controlAddress();
  if (ingressAddress === null || typeof ingressAddress === "string")
    throw new Error("Missing public settlement listener");
  const ownerAddress = ownerServer.controlAddress();
  if (ownerAddress === null || typeof ownerAddress === "string")
    throw new Error("Missing public owner settlement listener");
  const post = (
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ) => {
    const caller = new AbortController();
    callers.push(caller);
    const original = join(
      fetch(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: caller.signal,
      }).then((response) => {
        responses.add(response);
        return response;
      }),
    );
    const outcome: Promise<Outcome> = join(
      original
        .then(async (response) => ({
          status: response.status,
          body: (await response.json()) as unknown,
        }))
        .catch((error: unknown) => ({ error })),
    );
    return { caller, original, outcome };
  };
  return {
    ingress: ingressServer,
    owner: ownerServer,
    ownerSettlement,
    ingressSettlement,
    input,
    result,
    publication,
    b,
    revoked,
    resolver,
    admit,
    peerRequests,
    target,
    releases,
    join,
    expectCleanupFailure: (error: unknown) =>
      expectedCleanupFailures.add(error),
    wrapUpstream: (wrap: typeof wrapUpstream) => {
      wrapUpstream = wrap;
    },
    request: () =>
      post(
        `http://127.0.0.1:${ingressAddress.port}${AGENT_SETTLEMENT_PATH}`,
        workloadHeaders("agent-controller"),
        input,
      ),
    ownerRequest: () =>
      post(
        `http://127.0.0.1:${ownerAddress.port}${AGENT_SETTLEMENT_PATH}`,
        workloadHeaders("agent-controller"),
        input,
      ),
    peerRequest: (context: SettlementContext, body = input) =>
      post(
        `${privateOrigin}/internal/acp-peer/control/settlement`,
        { [OWNER_FORWARD_HEADER]: encodeOwnerControl(context) },
        body,
      ),
  };
}

it("forwards a closed Agent settlement without a live lease or CCT and preserves its original authority and deadline", async () => {
  const f = await start();
  const request = f.request();
  try {
    expect(await request.outcome).toEqual({ status: 200, body: f.result });
    expect(f.resolver.resolveSettlement).toHaveBeenCalledOnce();
    expect(f.resolver.resolveSettlement.mock.calls[0]?.[0]).toEqual(f.input);
    expect(f.resolver.resolve).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.ingressSettlement.settle).not.toHaveBeenCalled();
    expect(f.ownerSettlement.settle).toHaveBeenCalledOnce();
    expect(f.ownerSettlement.settle.mock.calls[0]?.[0]).toEqual(f.input);
    expect(f.ownerSettlement.settle.mock.calls[0]?.[2]).toEqual({
      owner: f.b,
      publication: f.publication,
    });
    expect(f.peerRequests).toHaveLength(1);
    const forwarded = f.peerRequests[0]!;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe("/internal/acp-peer/control/settlement");
    expect(forwarded.callerContext).toBeUndefined();
    expect(forwarded.context.deadline_at).toBe(f.input.deadline_at);
    expect(forwarded.context.body_sha256).toBe(controlBodyDigest(f.input));
    expect(forwarded.context.scope).toEqual({
      organizationId: f.input.organization_id,
      agentId: f.input.agent_id,
    });
    expect(forwarded.context).not.toHaveProperty("identity");
    expect(forwarded.context).not.toHaveProperty("epoch");
  } finally {
    request.caller.abort();
    await request.outcome;
  }
});

it("rejects a settlement body digest or Agent scope mismatch before owner dispatch", async () => {
  const f = await start();
  for (const mismatch of ["digest", "scope"] as const) {
    const context = f.target();
    const altered: SettlementContext =
      mismatch === "digest"
        ? { ...context, body_sha256: "c".repeat(64) }
        : {
            ...context,
            scope: { ...context.scope, agentId: "another-closed-agent" },
          };
    const request = f.peerRequest(altered);
    try {
      const outcome = await request.outcome;
      expect("status" in outcome ? outcome.status : undefined).toBe(503);
      expect("body" in outcome ? outcome.body : undefined).toMatchObject({
        code: "settlement_unavailable",
      });
      expect(f.ownerSettlement.settle).not.toHaveBeenCalled();
      expect(f.ingressSettlement.settle).not.toHaveBeenCalled();
    } finally {
      request.caller.abort();
      await request.outcome;
    }
  }
});

it("keeps an adopted controller settlement alive across user access revocation", async () => {
  const f = await start();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.releases.push(release.resolve);
  let originalSignal: AbortSignal | undefined;
  f.ownerSettlement.settle.mockImplementation(async (_input, signal) => {
    originalSignal = signal;
    entered.resolve();
    await release.promise;
    return f.result;
  });
  const request = f.request();
  let completed = false,
    revocation: Promise<void> | undefined;
  void request.outcome.then(() => {
    completed = true;
  });
  try {
    await beforeResponse(entered.promise, request.outcome);
    revocation = Promise.all([
      f.ingress.revokeAccess(f.revoked),
      f.owner.revokeAccess(f.revoked),
    ]).then(() => undefined);
    void revocation.catch(() => undefined);
    await turn();
    expect(originalSignal).toBeDefined();
    expect(originalSignal?.aborted).toBe(false);
    expect(completed).toBe(false);
    release.resolve();
    await revocation;
    expect(await request.outcome).toEqual({ status: 200, body: f.result });
    expect(f.ownerSettlement.settle).toHaveBeenCalledOnce();
    expect(f.ingressSettlement.settle).not.toHaveBeenCalled();
  } finally {
    request.caller.abort();
    release.resolve();
    await Promise.allSettled([request.outcome, revocation]);
  }
});

it("joins the original owner settlement after shutdown or client abort instead of treating cancellation as cleanup", async () => {
  for (const action of ["shutdown", "client-abort"] as const) {
    const f = await start();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    f.releases.push(release.resolve);
    let cleaned = false,
      ownerClosed = false;
    let originalSignal: AbortSignal | undefined;
    f.ownerSettlement.settle.mockImplementation(async (_input, signal) => {
      if (signal === undefined)
        throw new Error("Original settlement signal required");
      originalSignal = signal;
      entered.resolve();
      await aborted(signal);
      cancelled.resolve();
      await release.promise;
      cleaned = true;
      return f.result;
    });
    const request = f.request();
    let ingressClose: Promise<void> | undefined,
      ownerClose: Promise<void> | undefined;
    try {
      await beforeResponse(entered.promise, request.outcome);
      if (action === "shutdown") ingressClose = f.ingress.close();
      else request.caller.abort();
      await vi.waitFor(() => expect(originalSignal?.aborted).toBe(true), {
        timeout: 500,
        interval: 10,
      });
      await cancelled.promise;
      ownerClose = f.owner.close().then(() => {
        ownerClosed = true;
      });
      void ownerClose.catch(() => undefined);
      await turn();
      expect(cleaned).toBe(false);
      expect(ownerClosed, "closed socket is not original owner cleanup").toBe(
        false,
      );
      release.resolve();
      await Promise.all([ownerClose, ingressClose, request.outcome]);
      expect(cleaned).toBe(true);
      expect(ownerClosed).toBe(true);
      const outcome = await request.outcome;
      expect("status" in outcome && outcome.status === 200).toBe(false);
    } finally {
      request.caller.abort();
      release.resolve();
      await Promise.allSettled([
        request.outcome,
        ingressClose,
        ownerClose,
        f.ingress.close(),
        f.owner.close(),
      ]);
    }
  }
}, 15000);

it("joins the original relay body cancellation and retains its independent cleanup failure", async () => {
  const f = await start();
  const reading = Promise.withResolvers<void>(),
    releaseRead = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>(),
    releaseCancel = Promise.withResolvers<void>();
  const sentinel = new Error("original settlement relay cleanup failed");
  let relayBody: ReadableStream<Uint8Array> | undefined;
  let relaySignal: AbortSignal | undefined;
  const sourceCleanupFailures: unknown[] = [];
  f.releases.push(releaseRead.resolve, releaseCancel.resolve);
  f.wrapUpstream((response, signal) => {
    if (signal === undefined)
      throw new Error("Original relay fetch signal required");
    relaySignal = signal;
    if (response.body === null)
      throw new Error("Original settlement body required");
    const reader = response.body.getReader();
    const closed = reader.closed;
    void closed.catch(() => undefined);
    let cancelled = false;
    const isCancelled = () => cancelled;
    let released = false;
    const releaseReader = () => {
      if (released) return;
      released = true;
      reader.releaseLock();
    };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        return f.join(
          (async () => {
            reading.resolve();
            await releaseRead.promise;
            if (cancelled) return;
            const part = await reader.read();
            if (isCancelled()) return;
            if (part.done) {
              controller.close();
              await closed;
              releaseReader();
            } else controller.enqueue(part.value);
          })(),
        );
      },
      cancel() {
        cancelled = true;
        cancelling.resolve();
        return f.join(
          (async () => {
            const results = await Promise.allSettled([
              Promise.resolve().then(() => reader.cancel()),
              closed,
            ]);
            for (const result of results)
              if (
                result.status === "rejected" &&
                !sourceCleanupFailures.includes(result.reason)
              )
                sourceCleanupFailures.push(result.reason);
            try {
              releaseReader();
            } catch (error) {
              sourceCleanupFailures.push(error);
            }
            await releaseCancel.promise;
            throw new AggregateError(
              [...sourceCleanupFailures, sentinel],
              "Original settlement relay cancellation failed",
            );
          })(),
        );
      },
    });
    relayBody = body;
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  });
  const request = f.request();
  let closing: Promise<void> | undefined,
    finished = false;
  try {
    await beforeResponse(reading.promise, request.outcome);
    closing = f.ingress.close().finally(() => {
      finished = true;
    });
    void closing.catch(() => undefined);
    await cancelling.promise;
    await turn();
    expect(relaySignal?.aborted).toBe(true);
    expect(
      finished,
      "cancel signal is not the original relay cleanup receipt",
    ).toBe(false);
    releaseRead.resolve();
    releaseCancel.resolve();
    const [result] = await Promise.allSettled([closing]);
    expect(result.status).toBe("rejected");
    for (const error of sourceCleanupFailures)
      expect(
        relaySignal?.aborted &&
          (error === relaySignal.reason ||
            (error instanceof Error &&
              (error.name === "AbortError" ||
                ("code" in error && error.code === "ABORT_ERR")))),
        "only the recorded relay cancellation may accompany the independent sentinel",
      ).toBe(true);
    const leaves = (error: unknown): unknown[] =>
      error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
    const failures = result.status === "rejected" ? leaves(result.reason) : [];
    expect(failures).toContain(sentinel);
    for (const error of sourceCleanupFailures)
      expect(failures).toContain(error);
    expect(
      failures.every(
        (error) => error === sentinel || sourceCleanupFailures.includes(error),
      ),
    ).toBe(true);
    if (result.status === "rejected") f.expectCleanupFailure(result.reason);
    expect(
      relayBody?.locked,
      "original relay reader must release its lock",
    ).toBe(false);
    const outcome = await request.outcome;
    expect("status" in outcome && outcome.status === 200).toBe(false);
    expect(f.ownerSettlement.settle).toHaveBeenCalledOnce();
    expect(f.ingressSettlement.settle).not.toHaveBeenCalled();
  } finally {
    request.caller.abort();
    releaseRead.resolve();
    releaseCancel.resolve();
    await Promise.allSettled([closing, request.outcome]);
  }
}, 15000);

it("returns the same original not_settled result after deadline cleanup through owner and nonowner entrances", async () => {
  const f = await start();
  const entered = Promise.withResolvers<void>(),
    deadlineReached = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const timerReleases: Array<() => void> = [];
  const releaseTimers = () => {
    for (const release of timerReleases) release();
  };
  f.releases.push(cleanup.resolve, releaseTimers);
  const deadline = new Date(Date.now() + 300).toISOString();
  f.input.deadline_at = deadline;
  let started = 0,
    reached = 0;
  const deadlines: string[] = [];
  const result: AgentSettlementResult = {
    applied_revision: 7,
    outcome: "not_settled",
  };
  f.ownerSettlement.settle.mockImplementation(async (value) => {
    const input = value as AgentSettlementRequest;
    deadlines.push(input.deadline_at);
    if (++started === 2) entered.resolve();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        resolve,
        Math.max(0, Date.parse(input.deadline_at) - Date.now()),
      );
      timerReleases.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (++reached === 2) deadlineReached.resolve();
    await cleanup.promise;
    return result;
  });
  const direct = f.ownerRequest(),
    forwarded = f.request();
  let directResponded = false,
    forwardedResponded = false;
  void direct.outcome.then(() => {
    directResponded = true;
  });
  void forwarded.outcome.then(() => {
    forwardedResponded = true;
  });
  try {
    await beforeResponse(entered.promise, forwarded.outcome);
    await deadlineReached.promise;
    await turn();
    expect(deadlines).toEqual([deadline, deadline]);
    expect(f.input.deadline_at).toBe(deadline);
    expect(f.peerRequests[0]?.context.deadline_at).toBe(deadline);
    expect(
      directResponded,
      "owner response must join post-deadline cleanup",
    ).toBe(false);
    expect(
      forwardedResponded,
      "relay must retain the original post-deadline result",
    ).toBe(false);
    cleanup.resolve();
    expect(await Promise.all([direct.outcome, forwarded.outcome])).toEqual([
      { status: 200, body: result },
      { status: 200, body: result },
    ]);
    expect(f.ownerSettlement.settle).toHaveBeenCalledTimes(2);
    expect(f.ingressSettlement.settle).not.toHaveBeenCalled();
    expect(f.resolver.resolveSettlement).toHaveBeenCalledOnce();
  } finally {
    cleanup.resolve();
    releaseTimers();
    direct.caller.abort();
    forwarded.caller.abort();
    await Promise.allSettled([direct.outcome, forwarded.outcome]);
  }
}, 15000);
