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
import {
  OWNER_FORWARD_HEADER,
  type OwnerForwardRequest,
} from "../../../../services/agent-acp-service/src/application/owner-forwarding.js";
import type { OwnerRegistration } from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import { learningSkillTextPackage } from "../../../../services/agent-acp-service/src/domain/learning-candidate-package.js";
import type { AgentOwnershipFence } from "../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import type {
  ExecutionAccessSnapshot,
  ExecutionIdentity,
} from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import {
  SkillSourceError,
  skillProjectionSchema,
  skillSourceArtifactSchema,
  type SkillProjection,
  type SkillSourceArtifact,
  type SkillSourceInspect,
  type SkillSourceRecord,
} from "../../../../services/agent-acp-service/src/domain/skill-source.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import type { HttpOwnerForwardingOptions } from "../../../../services/agent-acp-service/src/transport/owner-http.js";

type SourceContext = Extract<
  OwnerControlRequest,
  { operation: "source-inspect" | "source-artifact" }
>;
type SourceAuthority = {
  fence: AgentOwnershipFence;
  signal: AbortSignal;
  assertCurrent(): void;
};
type InspectCall = (
  input: SkillSourceInspect,
  signal: AbortSignal,
  authority?: SourceAuthority,
) => Promise<{ items: SkillProjection[] }>;
type ArtifactCall = (
  input: SkillSourceArtifact,
  signal: AbortSignal,
  authority?: SourceAuthority,
) => Promise<SkillSourceRecord>;
type Outcome =
  | {
      status: number;
      body: unknown;
      headers: Record<string, string>;
    }
  | { error: unknown };

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
      throw new AggregateError(failures, "Owner source fixture cleanup failed");
  } finally {
    vi.restoreAllMocks();
  }
});

async function beforeResponse(
  entered: Promise<void>,
  outcome: Promise<Outcome>,
) {
  await Promise.race([
    entered,
    outcome.then(() => {
      throw new Error(
        "Source responded before the original owner read started",
      );
    }),
  ]);
}

async function start() {
  const organizationId = `org_${"1".repeat(32)}`;
  const principalId = `user_${"2".repeat(32)}`;
  const localAgent = `agent_${"3".repeat(32)}`;
  const remoteAgent = `agent_${"4".repeat(32)}`;
  const registration = (member_id: string): OwnerRegistration => ({
    registration_id: randomUUID(),
    member_id,
    incarnation_id: randomUUID(),
  });
  const a = registration("acp-a"),
    b = registration("acp-b");
  const publication = {
    organization_id: organizationId,
    revision: 7,
    authority_sha256: "b".repeat(64),
  };
  const identity = (agentId = remoteAgent): ExecutionIdentity => ({
    organizationId,
    principalId,
    agentId,
  });
  const fence = (
    selected: ExecutionIdentity,
    owner: OwnerRegistration,
  ): AgentOwnershipFence => ({
    organizationId: selected.organizationId,
    agentId: selected.agentId,
    ownerInstanceId: owner.incarnation_id,
    epoch: "7",
  });
  const record = (
    agentId: string,
    name: string,
    sequence: number,
  ): SkillSourceRecord => {
    const description = `Installed ${name}.`;
    const value = learningSkillTextPackage(
      `---\nname: "${name}"\ndescription: "${description}"\n---\nRead ${name} before acting.\n`,
    );
    return {
      projection: {
        organization_id: organizationId,
        agent_id: agentId,
        owner_id: principalId,
        name,
        description,
        sequence,
        content_digest: value.targetDigest,
        active: true,
      },
      packagePath: `.antnest/skills/${name}`,
      candidateId: `candidate-${name}`,
      taskId: `task-${name}`,
      generation: 1,
      effectRequestId: `installed-${name}`,
      package: value,
    };
  };
  const first = record(remoteAgent, "remote-first", 3);
  const second = record(remoteAgent, "remote-second", 5);
  const local = record(localAgent, "local-source", 2);
  const records = [first, second, local];
  const inspectInput: SkillSourceInspect = {
    organization_id: organizationId,
    actor_id: principalId,
    sources: [
      { agent_id: remoteAgent, name: second.projection.name },
      { agent_id: localAgent, name: local.projection.name },
      { agent_id: remoteAgent, name: "missing-source" },
      { agent_id: remoteAgent, name: first.projection.name },
    ],
  };
  const remoteInput: SkillSourceInspect = {
    ...inspectInput,
    sources: inspectInput.sources.filter(
      (source) => source.agent_id === remoteAgent,
    ),
  };
  const artifactInput: SkillSourceArtifact = {
    organization_id: organizationId,
    actor_id: principalId,
    skill_ref: {
      kind: "agent",
      agent_id: remoteAgent,
      name: first.projection.name,
      sequence: first.projection.sequence,
    },
    expected_digest: first.projection.content_digest,
  };
  const sourceService = (agentId: string) => ({
    inspect: vi.fn<InspectCall>((input, signal, authority) => {
      signal.throwIfAborted();
      authority?.assertCurrent();
      if (input.sources.some((source) => source.agent_id !== agentId))
        throw new SkillSourceError("source_unavailable");
      const items = input.sources.flatMap((source) => {
        const selected = records.find(
          (entry) =>
            entry.projection.agent_id === source.agent_id &&
            entry.projection.name === source.name &&
            entry.projection.owner_id === input.actor_id &&
            entry.projection.organization_id === input.organization_id,
        );
        return selected === undefined ? [] : [selected.projection];
      });
      return Promise.resolve({ items });
    }),
    artifact: vi.fn<ArtifactCall>((input, signal, authority) => {
      signal.throwIfAborted();
      authority?.assertCurrent();
      if (input.skill_ref.agent_id !== agentId)
        throw new SkillSourceError("source_unavailable");
      const selected = records.find(
        (entry) =>
          entry.projection.agent_id === input.skill_ref.agent_id &&
          entry.projection.name === input.skill_ref.name &&
          entry.projection.owner_id === input.actor_id &&
          entry.projection.organization_id === input.organization_id,
      );
      if (selected === undefined) throw new SkillSourceError("not_found");
      if (
        selected.projection.sequence !== input.skill_ref.sequence ||
        selected.projection.content_digest !== input.expected_digest
      )
        throw new SkillSourceError("content_changed");
      return Promise.resolve(selected);
    }),
  });
  const ownerService = sourceService(remoteAgent),
    ingressService = sourceService(localAgent);
  const unexpected = () =>
    Promise.reject(new Error("Source reads cannot dispatch ACP commands"));
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
  const releases: Array<() => void> = [];
  const callers: AbortController[] = [];
  const responses = new Set<Response>();
  const originals = new Set<Promise<unknown>>();
  const handlerFailures: unknown[] = [];
  const expectedCleanupFailures = new Set<unknown>();
  const peerRequests: Array<{
    method: string | undefined;
    url: string | undefined;
    context: SourceContext;
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

  // The same already-authenticated member boundary as the settlement fixture;
  // real directional credentials remain owned by PeerServer/two-main tests.
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
            throw new Error("Missing source peer context");
          const context = parseOwnerControl(header);
          if (
            context.operation !== "source-inspect" &&
            context.operation !== "source-artifact"
          )
            throw new Error("Unexpected source owner operation");
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
    const failures = results.flatMap((result) =>
      result.status === "rejected" &&
      !expectedCleanupFailures.has(result.reason)
        ? [result.reason as unknown]
        : [],
    );
    if (handlerFailures.length || failures.length)
      throw new AggregateError(
        [...handlerFailures, ...failures],
        "Original source HTTP cleanup failed",
      );
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const privateAddress = peer.address();
  if (privateAddress === null || typeof privateAddress === "string")
    throw new Error("Missing private source listener");
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
        throw new Error("Unexpected source peer owner");
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
  const target = (
    selected = identity(),
    originalDeadlineMs = Date.now() + 8500,
  ): OwnerForwardRequest => ({
    request_id: randomUUID(),
    deadline_at: new Date(originalDeadlineMs).toISOString(),
    membership_sha256: sha,
    source: a,
    target: selected.agentId === localAgent ? a : b,
    publication,
    identity: { ...selected },
    epoch: "7",
    protocol: "v1",
    caller: "agent-ui",
    hop: 1,
  });
  const resolver = {
    resolve:
      vi.fn<HttpOwnerForwardingOptions["resolver"]["resolve"]>(unexpected),
    resolveSource: vi.fn<
      (
        selected: ExecutionIdentity,
        originalDeadlineMs: number,
        signal: AbortSignal,
      ) => Promise<OwnerForwardRequest>
    >((selected, deadline, signal) => {
      signal.throwIfAborted();
      return Promise.resolve(target(selected, deadline));
    }),
  };
  const localResolver = {
    resolve: resolver.resolve,
    resolveSource: resolver.resolveSource,
  };
  const lifetime = new AbortController();
  releases.push(() => lifetime.abort());
  const admit = vi.fn<HttpOwnerForwardingOptions["admit"]>(
    (request, signal) => {
      signal.throwIfAborted();
      return Promise.resolve({
        fence: fence(request.identity, request.target),
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      });
    },
  );
  const ownerServer = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application,
    skillSources: { service: ownerService },
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
    skillSources: { service: ingressService },
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
  await ownerServer.listen("127.0.0.1", 0);
  await ingressServer.listen("127.0.0.1", 0);
  const ingressAddress = ingressServer.address();
  if (ingressAddress === null || typeof ingressAddress === "string")
    throw new Error("Missing public source listener");
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
          headers: Object.fromEntries(response.headers),
          body: response.headers
            .get("content-type")
            ?.startsWith("application/json")
            ? ((await response.json()) as unknown)
            : Buffer.from(await response.arrayBuffer()),
        }))
        .catch((error: unknown) => ({ error })),
    );
    return { caller, original, outcome };
  };
  const context = (
    operation: "source-inspect" | "source-artifact",
    body: SkillSourceInspect | SkillSourceArtifact,
  ): SourceContext => {
    const { protocol: _protocol, ...authority } = target();
    void _protocol;
    return {
      ...authority,
      operation,
      caller: "skill-registry",
      body_sha256: controlBodyDigest(body),
    };
  };
  return {
    owner: ownerServer,
    ingress: ingressServer,
    ownerService,
    ingressService,
    organizationId,
    principalId,
    localAgent,
    remoteAgent,
    a,
    b,
    fence,
    identity,
    first,
    second,
    local,
    inspectInput,
    remoteInput,
    artifactInput,
    resolver,
    admit,
    target,
    context,
    peerRequests,
    releases,
    join,
    wrapUpstream: (wrap: typeof wrapUpstream) => {
      wrapUpstream = wrap;
    },
    expectCleanupFailure: (error: unknown) =>
      expectedCleanupFailures.add(error),
    revoked: {
      organization_id: organizationId,
      agents: [],
    } satisfies ExecutionAccessSnapshot,
    request: (
      route: "inspect" | "artifact",
      body: SkillSourceInspect | SkillSourceArtifact,
    ) =>
      post(
        `http://127.0.0.1:${ingressAddress.port}/internal/skill-sources/${route}`,
        workloadHeaders("skill-registry"),
        body,
      ),
    peerRequest: (
      selected: SourceContext,
      body: SkillSourceInspect | SkillSourceArtifact,
    ) =>
      post(
        `${privateOrigin}/internal/acp-peer/control/${selected.operation}`,
        { [OWNER_FORWARD_HEADER]: encodeOwnerControl(selected) },
        body,
      ),
  };
}

it("merges local and remote Agent inspect parts in original order while retaining omissions and fixed authority", async () => {
  const f = await start();
  const request = f.request("inspect", f.inspectInput);
  try {
    expect(await request.outcome).toMatchObject({
      status: 200,
      body: {
        items: [f.second.projection, f.local.projection, f.first.projection],
      },
    });
    expect(f.ownerService.inspect).toHaveBeenCalledOnce();
    expect(f.ingressService.inspect).toHaveBeenCalledOnce();
    expect(f.ownerService.inspect.mock.calls[0]?.[0]).toEqual(f.remoteInput);
    expect(f.ingressService.inspect.mock.calls[0]?.[0]).toEqual({
      ...f.inspectInput,
      sources: f.inspectInput.sources.filter(
        (source) => source.agent_id === f.localAgent,
      ),
    });
    expect(f.ownerService.inspect.mock.calls[0]?.[2]?.fence).toEqual(
      f.fence(f.identity(), f.b),
    );
    expect(f.ingressService.inspect.mock.calls[0]?.[2]?.fence).toEqual(
      f.fence(f.identity(f.localAgent), f.a),
    );
    expect(f.resolver.resolve).not.toHaveBeenCalled();
    expect(f.resolver.resolveSource).toHaveBeenCalledTimes(2);
    expect(f.peerRequests).toHaveLength(1);
    const forwarded = f.peerRequests[0]!;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe("/internal/acp-peer/control/source-inspect");
    expect(forwarded.callerContext).toBeUndefined();
    expect(forwarded.context.caller).toBe("skill-registry");
    expect(forwarded.context.identity).toEqual(f.identity());
    expect(forwarded.context.body_sha256).toBe(
      controlBodyDigest(f.remoteInput),
    );
  } finally {
    request.caller.abort();
    await request.outcome;
  }
});

it("fails the whole inspect instead of returning a successful local partial result", async () => {
  const f = await start();
  f.ownerService.inspect.mockRejectedValueOnce(
    new SkillSourceError("source_unavailable"),
  );
  const request = f.request("inspect", {
    ...f.inspectInput,
    sources: [
      { agent_id: f.localAgent, name: f.local.projection.name },
      { agent_id: f.remoteAgent, name: f.first.projection.name },
    ],
  });
  try {
    const outcome = await request.outcome;
    expect("status" in outcome ? outcome.status : undefined).toBe(503);
    expect("body" in outcome ? outcome.body : undefined).toMatchObject({
      error: { code: "source_unavailable" },
    });
    expect("body" in outcome ? outcome.body : undefined).not.toHaveProperty(
      "items",
    );
    expect(f.ingressService.inspect).toHaveBeenCalledOnce();
    expect(f.ownerService.inspect).toHaveBeenCalledOnce();
  } finally {
    request.caller.abort();
    await request.outcome;
  }
});

it("relays the owner's exact ZIP, ETag, artifact/content digests and source sequence without a CCT", async () => {
  const f = await start();
  const request = f.request("artifact", f.artifactInput);
  try {
    const outcome = await request.outcome;
    expect("status" in outcome ? outcome.status : undefined).toBe(200);
    expect("body" in outcome ? outcome.body : undefined).toEqual(
      f.first.package.artifact,
    );
    expect("headers" in outcome ? outcome.headers : undefined).toMatchObject({
      "content-type": "application/zip",
      "content-length": String(f.first.package.artifact.length),
      "cache-control": "no-store",
      etag: `"${f.first.package.artifactDigest}"`,
      "x-antnest-artifact-digest": f.first.package.artifactDigest,
      "x-antnest-content-digest": f.first.projection.content_digest,
      "x-antnest-source-sequence": String(f.first.projection.sequence),
    });
    expect(f.ownerService.artifact).toHaveBeenCalledOnce();
    expect(f.ownerService.artifact.mock.calls[0]?.[0]).toEqual(f.artifactInput);
    expect(f.ownerService.artifact.mock.calls[0]?.[2]?.fence).toEqual(
      f.fence(f.identity(), f.b),
    );
    expect(f.ingressService.artifact).not.toHaveBeenCalled();
    expect(f.peerRequests[0]?.url).toBe(
      "/internal/acp-peer/control/source-artifact",
    );
    expect(f.peerRequests[0]?.callerContext).toBeUndefined();
    expect(f.peerRequests[0]?.context.body_sha256).toBe(
      controlBodyDigest(skillSourceArtifactSchema.parse(f.artifactInput)),
    );
  } finally {
    request.caller.abort();
    await request.outcome;
  }
});

it("rejects a peer source scope, body digest or actor mismatch before source dispatch", async () => {
  const f = await start();
  for (const mismatch of ["scope", "body", "actor"] as const) {
    const body =
      mismatch === "actor"
        ? { ...f.remoteInput, actor_id: `user_${"9".repeat(32)}` }
        : f.remoteInput;
    const original = f.context("source-inspect", body);
    const selected: SourceContext =
      mismatch === "scope"
        ? {
            ...original,
            identity: { ...original.identity, agentId: f.localAgent },
          }
        : mismatch === "body"
          ? { ...original, body_sha256: "f".repeat(64) }
          : original;
    const request = f.peerRequest(selected, body);
    try {
      const outcome = await request.outcome;
      expect("status" in outcome && outcome.status >= 400).toBe(true);
      expect(f.ownerService.inspect).not.toHaveBeenCalled();
      expect(f.ownerService.artifact).not.toHaveBeenCalled();
      expect(f.ingressService.inspect).not.toHaveBeenCalled();
      expect(f.admit).not.toHaveBeenCalled();
    } finally {
      request.caller.abort();
      await request.outcome;
    }
  }
});

it("shares the original 8.5 second absolute deadline across local and remote inspect groups", async () => {
  const f = await start();
  const now = Date.now();
  let elapsed = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now + elapsed);
  f.resolver.resolveSource.mockImplementation((identity, deadline, signal) => {
    signal.throwIfAborted();
    elapsed += 750;
    return Promise.resolve(f.target(identity, deadline));
  });
  const request = f.request("inspect", f.inspectInput);
  try {
    expect(await request.outcome).toMatchObject({ status: 200 });
    const deadlines = f.resolver.resolveSource.mock.calls.map(
      (call) => call[1],
    );
    expect(deadlines).toEqual([now + 8500, now + 8500]);
    expect(f.peerRequests[0]?.context.deadline_at).toBe(
      new Date(now + 8500).toISOString(),
    );
  } finally {
    clock.mockRestore();
    request.caller.abort();
    await request.outcome;
  }
});

it.each(["revocation", "shutdown"] as const)(
  "%s cancels delivery but joins the original held owner source read",
  async (action) => {
    const f = await start();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    f.releases.push(release.resolve);
    let originalSignal: AbortSignal | undefined;
    let cleaned = false,
      acknowledged = false;
    f.ownerService.inspect.mockImplementation(async (_input, signal) => {
      originalSignal = signal;
      entered.resolve();
      await release.promise;
      cleaned = true;
      return { items: [f.first.projection] };
    });
    const request = f.request("inspect", {
      ...f.remoteInput,
      sources: [f.remoteInput.sources.at(-1)!],
    });
    let ingressAction: Promise<void> | undefined,
      ownerAction: Promise<void> | undefined;
    try {
      await beforeResponse(entered.promise, request.outcome);
      ingressAction =
        action === "revocation"
          ? f.ingress.revokeAccess(f.revoked)
          : f.ingress.close();
      ownerAction = (
        action === "revocation"
          ? f.owner.revokeAccess(f.revoked)
          : f.owner.close()
      ).then(() => {
        acknowledged = true;
      });
      void ingressAction.catch(() => undefined);
      void ownerAction.catch(() => undefined);
      await vi.waitFor(() => expect(originalSignal?.aborted).toBe(true), {
        timeout: 500,
        interval: 10,
      });
      expect(cleaned).toBe(false);
      expect(
        acknowledged,
        "cancel signal is not the original source read receipt",
      ).toBe(false);
      release.resolve();
      await Promise.all([ingressAction, ownerAction, request.outcome]);
      expect(cleaned).toBe(true);
      expect(acknowledged).toBe(true);
      const outcome = await request.outcome;
      expect("status" in outcome && outcome.status === 200).toBe(false);
    } finally {
      request.caller.abort();
      release.resolve();
      await Promise.allSettled([
        request.outcome,
        ingressAction,
        ownerAction,
        f.ingress.close(),
        f.owner.close(),
      ]);
    }
  },
  15000,
);

it("returns all fifty legal source projections when escaped descriptions exceed 65536 response bytes", async () => {
  const f = await start();
  const description = "\u0001".repeat(512);
  const items = Array.from({ length: 50 }, (_, index) =>
    skillProjectionSchema.parse({
      ...f.first.projection,
      name: `escaped-${String(index).padStart(2, "0")}`,
      description,
    }),
  );
  const input: SkillSourceInspect = {
    ...f.remoteInput,
    sources: items.map((item) => ({
      agent_id: item.agent_id,
      name: item.name,
    })),
  };
  expect(Buffer.byteLength(description)).toBe(512);
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(8192);
  expect(Buffer.byteLength(JSON.stringify({ items }))).toBeGreaterThan(65_536);
  f.ownerService.inspect.mockResolvedValueOnce({ items });
  const request = f.request("inspect", input);
  try {
    expect(await request.outcome).toMatchObject({
      status: 200,
      body: { items },
    });
    expect(f.ownerService.inspect).toHaveBeenCalledOnce();
    expect(f.ownerService.inspect.mock.calls[0]?.[0]).toEqual(input);
    expect(f.ingressService.inspect).not.toHaveBeenCalled();
  } finally {
    request.caller.abort();
    await request.outcome;
  }
});

it("joins held source relay cancellation and retains its independent cleanup sentinel", async () => {
  const f = await start();
  const reading = Promise.withResolvers<void>(),
    releaseRead = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>(),
    releaseCancel = Promise.withResolvers<void>();
  const sentinel = new Error("original source relay cleanup failed");
  const sourceCleanupFailures: unknown[] = [];
  let relayBody: ReadableStream<Uint8Array> | undefined;
  let relaySignal: AbortSignal | undefined;
  f.releases.push(releaseRead.resolve, releaseCancel.resolve);
  f.wrapUpstream((response, signal) => {
    if (signal === undefined || response.body === null)
      throw new Error("Original source relay body and signal required");
    relaySignal = signal;
    const reader = response.body.getReader();
    const closed = reader.closed;
    void closed.catch(() => undefined);
    let cancelled = false,
      released = false;
    const isCancelled = () => cancelled;
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
              "Original source relay cancellation failed",
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
  const request = f.request("inspect", {
    ...f.remoteInput,
    sources: [f.remoteInput.sources.at(-1)!],
  });
  let closing: Promise<void> | undefined,
    finished = false;
  try {
    await beforeResponse(reading.promise, request.outcome);
    closing = f.ingress.close().finally(() => {
      finished = true;
    });
    void closing.catch(() => undefined);
    await cancelling.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relaySignal?.aborted).toBe(true);
    expect(
      finished,
      "cancel signal cannot replace original source relay cleanup",
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
      "original source relay reader must release its lock",
    ).toBe(false);
    const outcome = await request.outcome;
    expect("status" in outcome && outcome.status === 200).toBe(false);
    expect(f.ownerService.inspect).toHaveBeenCalledOnce();
    expect(f.ingressService.inspect).not.toHaveBeenCalled();
  } finally {
    request.caller.abort();
    releaseRead.resolve();
    releaseCancel.resolve();
    await Promise.allSettled([closing, request.outcome]);
  }
}, 15000);

it("rejects owner shutdown when the original held source service fails after cancellation", async () => {
  const f = await start();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const sentinel = new Error("original owner source cleanup failed");
  f.releases.push(release.resolve);
  let serviceOriginal: Promise<never> | undefined;
  let cleaned = false,
    finished = false;
  f.ownerService.inspect.mockImplementation(() => {
    entered.resolve();
    serviceOriginal = f.join(
      (async () => {
        await release.promise;
        cleaned = true;
        throw sentinel;
      })(),
    );
    return serviceOriginal;
  });
  const request = f.request("inspect", {
    ...f.remoteInput,
    sources: [f.remoteInput.sources.at(-1)!],
  });
  let closing: Promise<void> | undefined;
  try {
    await beforeResponse(entered.promise, request.outcome);
    closing = f.owner.close().finally(() => {
      finished = true;
    });
    void closing.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleaned).toBe(false);
    expect(
      finished,
      "owner ACK must wait for its original source service",
    ).toBe(false);
    release.resolve();
    const [result] = await Promise.allSettled([closing]);
    expect(cleaned).toBe(true);
    expect(result.status).toBe("rejected");
    const leaves = (error: unknown): unknown[] =>
      error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
    const failures = result.status === "rejected" ? leaves(result.reason) : [];
    expect(failures).toContain(sentinel);
    expect(failures.every((error) => error === sentinel)).toBe(true);
    if (result.status === "rejected") f.expectCleanupFailure(result.reason);
    const outcome = await request.outcome;
    expect("status" in outcome && outcome.status === 200).toBe(false);
    expect(f.ownerService.inspect).toHaveBeenCalledOnce();
    expect(f.ingressService.inspect).not.toHaveBeenCalled();
  } finally {
    request.caller.abort();
    release.resolve();
    await Promise.allSettled([serviceOriginal, closing, request.outcome]);
  }
}, 15000);
