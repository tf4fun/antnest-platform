import { randomUUID } from "node:crypto";
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
} from "../../../../services/agent-acp-service/test/support/fixtures.js";
import type { AgentOwnershipFence } from "../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import type { ExecutionIdentity } from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import { AcpHttpTransport } from "../../../../services/agent-acp-service/src/transport/acp/http-transport.js";
import { SessionOutputStreams } from "../../../../services/agent-acp-service/src/transport/acp/session-output.js";

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
    throw new AggregateError(failures, "HTTP owner fixture cleanup failed");
});

function onlyCleanupFailure(error: unknown, expected: Error): boolean {
  return (
    error === expected ||
    (error instanceof AggregateError &&
      error.errors.length > 0 &&
      (error.errors as unknown[]).every((cause) =>
        onlyCleanupFailure(cause, expected),
      ))
  );
}

async function start(expectedCleanupFailure?: Error) {
  const originalBinding = binding();
  const identity: ExecutionIdentity = {
    organizationId: originalBinding.organizationId,
    principalId: originalBinding.principalId,
    agentId: originalBinding.agentId,
  };
  const fence: AgentOwnershipFence = {
    organizationId: identity.organizationId,
    agentId: identity.agentId,
    ownerInstanceId: randomUUID(),
    epoch: "7",
  };
  const authority = new AbortController();
  const owner = {
    fence,
    signal: authority.signal,
    assertCurrent: vi.fn(() => authority.signal.throwIfAborted()),
    encodeConnectionId: vi.fn((sdkId: string) => `opaque-owner.${sdkId}`),
  };
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
  const transport = new AcpHttpTransport({
    application,
    outputs: new SessionOutputStreams(),
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 4096,
  });
  const authentication = testAuthentication();
  const handlers = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const listener = createServer((request, response) => {
    const original = (async () => {
      const admission = await authentication.admit(request);
      if ("status" in admission) {
        response.writeHead(admission.status);
        response.end();
        return;
      }
      await transport.handle(
        request,
        response,
        request.method === "DELETE" ? undefined : owner,
      );
    })();
    handlers.add(original);
    void original.then(
      () => handlers.delete(original),
      (error: unknown) => {
        errors.push(error);
        response.destroy();
        handlers.delete(original);
      },
    );
  });
  const clients: acp.ClientConnection[] = [];
  const outgoing = new Set<Promise<Response>>();
  cleanups.push(async () => {
    for (const client of clients) client.close();
    const results = await Promise.allSettled(
      clients.map((client) => client.closed),
    );
    results.push(
      ...(await Promise.allSettled([
        transport.close().catch((error: unknown) => {
          if (
            expectedCleanupFailure !== undefined &&
            onlyCleanupFailure(error, expectedCleanupFailure)
          )
            return;
          throw error;
        }),
      ])),
    );
    results.push(
      ...(await Promise.allSettled([
        new Promise<void>((resolve, reject) => {
          listener.close((error) => (error ? reject(error) : resolve()));
          listener.closeAllConnections();
        }),
      ])),
    );
    while (handlers.size)
      results.push(...(await Promise.allSettled([...handlers])));
    while (outgoing.size) {
      await Promise.allSettled([...outgoing]);
    }
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length || errors.length)
      throw new AggregateError(
        [...failures, ...errors],
        "HTTP owner fixture cleanup failed",
      );
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing HTTP owner listener");
  const url = `http://127.0.0.1:${address.port}/v1/acp`;
  const sentIds: string[] = [];
  const responseIds: string[] = [];
  const trackedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : {}),
    );
    const id = headers.get("Acp-Connection-Id");
    if (id) sentIds.push(id);
    const original = fetch(input, init).then((response) => {
      const returnedId = response.headers.get("Acp-Connection-Id");
      if (returnedId) responseIds.push(returnedId);
      return response;
    });
    outgoing.add(original);
    void original.then(
      () => outgoing.delete(original),
      () => outgoing.delete(original),
    );
    return original;
  };
  const send = (method: string, id?: string, body?: unknown) =>
    trackedFetch(url, {
      method,
      headers: {
        ...identityHeaders(identity),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(id === undefined ? {} : { "Acp-Connection-Id": id }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const open = async () => {
    const response = await send("POST", undefined, initialize);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { protocolVersion: 1 },
    });
    const id = response.headers.get("Acp-Connection-Id");
    if (!id) throw new Error("Missing external connection ID");
    return id;
  };
  return {
    application,
    authority,
    fence,
    identity,
    owner,
    transport,
    send,
    open,
    sentIds,
    responseIds,
    connect: () => {
      const client = acp.client().connect(
        createHttpStream(url, {
          headers: identityHeaders(identity),
          fetch: trackedFetch,
        }),
      );
      clients.push(client);
      return client;
    },
  };
}

function holdSdkCleanup() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
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

it("issues one opaque ID and routes the official HTTP client back to its original SDK with the owner fence", async () => {
  const f = await start();
  const client = f.connect();
  await client.agent.request(acp.methods.agent.initialize, initialize.params);
  const externalId = f.responseIds[0];
  expect(f.owner.encodeConnectionId).toHaveBeenCalledOnce();
  expect(externalId).toBe(f.owner.encodeConnectionId.mock.results[0]!.value);
  expect(externalId).not.toBe(f.owner.encodeConnectionId.mock.calls[0]![0]);
  await expect(
    client.agent.request(acp.methods.agent.session.new, newSession.params),
  ).resolves.toMatchObject({ sessionId: "session-1" });
  expect(f.sentIds).toContain(externalId);
  expect(f.sentIds.every((id) => id === externalId)).toBe(true);
  expect(f.owner.encodeConnectionId).toHaveBeenCalledOnce();
  expect(f.application.createSession).toHaveBeenCalledOnce();
  expect(f.application.createSession.mock.calls[0]![0].binding).toMatchObject({
    ...f.identity,
    ownerFence: f.fence,
  });
});

it("rejects old-connection business after owner loss but preserves the original identity's DELETE receipt", async () => {
  const f = await start();
  const id = await f.open();
  f.authority.abort(new Error("Original owner lease lost"));
  const denied = await f.send("POST", id, newSession);
  await denied.text();
  expect([404, 503]).toContain(denied.status);
  expect(f.application.createSession).not.toHaveBeenCalled();
  const deleted = await f.send("DELETE", id);
  expect(deleted.status).toBe(202);
  await deleted.text();
});

it("does not acknowledge DELETE until the original SDK cleanup has joined", async () => {
  const f = await start();
  const id = await f.open();
  const cleanup = holdSdkCleanup();
  let responded = false;
  const deletion = f.send("DELETE", id).then((response) => {
    responded = true;
    return response;
  });
  void deletion.catch(() => undefined);
  try {
    await Promise.race([cleanup.entered, deletion]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(responded).toBe(false);
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

it("retains failed SDK cleanup after release without failing an unrelated scope", async () => {
  const failure = new Error("original-sdk-cleanup-sentinel");
  const f = await start(failure);
  const id = await f.open();
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = AcpServer.prototype.close;
  const close = vi
    .spyOn(AcpServer.prototype, "close")
    .mockImplementation(async function (this: AcpServer) {
      await original.call(this);
      throw failure;
    });
  try {
    const response = await f.send("DELETE", id);
    expect(response.status).toBe(503);
    await response.text();
    expect(close).toHaveBeenCalledOnce();

    // Explicit close releases the retained ID/receipt without waiting for its timer.
    const stopped = await f.transport.close().catch((error: unknown) => error);
    expect(onlyCleanupFailure(stopped, failure)).toBe(true);
    const revoked = { organization_id: f.identity.organizationId, agents: [] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await f.transport
        .revokeAccess(revoked)
        .catch((error: unknown) => error);
      expect(onlyCleanupFailure(rejected, failure)).toBe(true);
    }
    await expect(
      f.transport.revokeAccess({
        organization_id: f.identity.organizationId,
        agents: [
          {
            agent_id: f.identity.agentId,
            principal_ids: [f.identity.principalId],
          },
        ],
      }),
    ).resolves.toBeUndefined();
    await expect(
      f.transport.revokeAccess({
        organization_id: "unrelated-organization",
        agents: [],
      }),
    ).resolves.toBeUndefined();
  } finally {
    close.mockRestore();
  }
});
