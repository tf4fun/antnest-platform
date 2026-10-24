import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import {
  PeerServer,
  type PeerServerOptions,
} from "../../../../services/agent-acp-service/src/transport/peer-server.js";
import { PeerAuthentication } from "../../../../services/agent-acp-service/src/adapters/peer-authentication.js";
import {
  ServiceAuthentication,
  SERVICE_AUTH_HEADER,
} from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import {
  testSecurityEnvironment,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import type { PeerPublicationRequest } from "../../../../services/agent-acp-service/src/ports/agent-peers.js";
import { PeerDeadlineError } from "../../../../services/agent-acp-service/src/ports/agent-peers.js";
import { encodeOwnerForward } from "../../../../services/agent-acp-service/src/application/owner-forwarding.js";

const identityPath = "/internal/acp-peer/identity";
const publicationPath = "/internal/acp-peer/publications/apply";
const receipt = (request: PeerPublicationRequest) => ({
  request_id: request.request_id,
  membership_sha256: request.membership_sha256,
  registration: request.target,
  publication: request.publication,
  status: "applied" as const,
  revocation: "joined" as const,
  owned_agents: [],
});
type Reply = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
};
type SendOptions = {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  held?: boolean;
  declaredBytes?: number;
};
type Exchange = {
  request: ClientRequest;
  result: Promise<Reply | Error>;
  join(): Promise<void>;
};

async function bounded<T>(promise: Promise<T>, ms = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Peer test deadline")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withPeer(
  action: (fixture: {
    server: PeerServer;
    registration: {
      registration_id: string;
      member_id: string;
      incarnation_id: string;
    };
    authentication: PeerAuthentication;
    apply: ReturnType<typeof vi.fn<PeerServerOptions["apply"]>>;
    release: Array<() => void>;
    identity(): Record<string, unknown>;
    publication(): PeerPublicationRequest;
    send(body: unknown, options?: SendOptions): Exchange;
    reply(task: Exchange): Promise<Reply>;
    close(): Promise<void>;
    connectForward(value: unknown): WebSocket;
  }) => Promise<void>,
  options: {
    apply?: PeerServerOptions["apply"];
    timeoutMs?: number;
    forward?: PeerServerOptions["forward"];
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "acp-peer-server-"));
  const workload = new ServiceAuthentication(testSecurityEnvironment());
  const tasks: Exchange[] = [];
  const sockets: { socket: WebSocket; closed: Promise<void> }[] = [];
  const release: Array<() => void> = [];
  const errors: unknown[] = [];
  let server: PeerServer | undefined;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= server?.close() ?? Promise.resolve());
  try {
    const current = randomBytes(32).toString("base64url");
    const membershipFile = join(directory, "membership.json"),
      callersFile = join(directory, "callers.json"),
      tokenDirectory = join(directory, "tokens");
    mkdirSync(tokenDirectory);
    writeFileSync(
      membershipFile,
      JSON.stringify({
        version: 1,
        cluster_id: randomUUID(),
        members: [
          { member_id: "acp-a", origin: "http://acp-a.internal:8083" },
          { member_id: "acp-b", origin: "http://acp-b.internal:8083" },
        ],
      }),
    );
    writeFileSync(
      callersFile,
      JSON.stringify({
        "acp-a": [
          `sha256:${createHash("sha256").update(current).digest("hex")}`,
        ],
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(tokenDirectory, "acp-a"),
      randomBytes(32).toString("base64url"),
      { mode: 0o600 },
    );
    const authentication = new PeerAuthentication({
      memberId: "acp-b",
      membershipFile,
      callersFile,
      tokenDirectory,
      workload,
    });
    const registration = {
      registration_id: randomUUID(),
      member_id: "acp-b",
      incarnation_id: randomUUID(),
    };
    const source = {
      registration_id: randomUUID(),
      member_id: "acp-a",
      incarnation_id: randomUUID(),
    };
    const common = () => ({
      request_id: randomUUID(),
      deadline_at: new Date(Date.now() + 1000).toISOString(),
      membership_sha256: authentication.membership.sha256,
      source,
    });
    const identity = () => ({
      ...common(),
      target_member_id: "acp-b",
      challenge: randomBytes(32).toString("hex"),
    });
    const publication = (): PeerPublicationRequest => ({
      ...common(),
      target: registration,
      publication: {
        organization_id: "org-1",
        revision: 1,
        authority_sha256: "d".repeat(64),
      },
      hop: 1,
    });
    const apply = vi.fn<PeerServerOptions["apply"]>(
      options.apply ?? ((input) => Promise.resolve(receipt(input))),
    );
    server = new PeerServer({
      registration,
      authentication,
      apply,
      timeoutMs: options.timeoutMs ?? 2000,
      ...(options.forward === undefined ? {} : { forward: options.forward }),
    });
    await server.listen("127.0.0.1", 0);
    const port = server.address()!.port;
    const send = (body: unknown, settings: SendOptions = {}): Exchange => {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      const result = Promise.withResolvers<Reply | Error>();
      const requestClosed = Promise.withResolvers<void>();
      let responseClosed = Promise.resolve();
      let socketClosed = Promise.resolve();
      const request = httpRequest({
        host: "127.0.0.1",
        port,
        method: settings.method ?? "POST",
        path: settings.path ?? identityPath,
        agent: false,
        headers: {
          "Content-Type": "application/json",
          [SERVICE_AUTH_HEADER]: `Bearer ${current}`,
          "Content-Length": settings.declaredBytes ?? Buffer.byteLength(raw),
          Connection: "close",
          ...settings.headers,
        },
      });
      request.once("socket", (socket) => {
        const closed = Promise.withResolvers<void>();
        socketClosed = closed.promise;
        socket.once("close", () => closed.resolve());
      });
      request.once("response", (response) => {
        const closed = Promise.withResolvers<void>();
        responseClosed = closed.promise;
        response.once("close", () => closed.resolve());
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", (error) => result.resolve(error));
        response.once("end", () => {
          try {
            result.resolve({
              status: response.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()) as Record<
                string,
                unknown
              >,
              headers: response.headers,
            });
          } catch {
            result.resolve(new Error("Invalid peer JSON response"));
          }
        });
      });
      request.once("error", (error) => result.resolve(error));
      request.once("close", () => {
        requestClosed.resolve();
        result.resolve(new Error("Request closed before complete reply"));
      });
      if (settings.held) {
        request.flushHeaders();
        if (raw) request.write(raw);
      } else request.end(raw);
      const task = {
        request,
        result: result.promise,
        async join() {
          await requestClosed.promise;
          await responseClosed;
          await socketClosed;
        },
      };
      tasks.push(task);
      return task;
    };
    await action({
      server,
      registration,
      authentication,
      apply,
      release,
      identity,
      publication,
      send,
      close,
      connectForward(value) {
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/internal/acp-peer/forward/ws`,
          {
            headers: {
              [SERVICE_AUTH_HEADER]: `Bearer ${current}`,
              "Antnest-ACP-Forward": encodeOwnerForward(value),
            },
            handshakeTimeout: 2000,
          },
        );
        socket.on("error", () => undefined);
        sockets.push({
          socket,
          closed: new Promise<void>((resolve) =>
            socket.once("close", () => resolve()),
          ),
        });
        return socket;
      },
      async reply(task) {
        const result = await bounded(task.result);
        await bounded(task.join());
        if (result instanceof Error) throw result;
        return result;
      },
    });
  } catch (error) {
    errors.push(error);
  } finally {
    for (const finish of release) finish();
    for (const { socket } of sockets)
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    for (const task of tasks)
      task.request.destroy(new Error("Peer fixture cleanup"));
    for (const result of await Promise.allSettled([
      ...tasks.map((task) => task.join()),
      ...sockets.map(({ closed }) => closed),
      close(),
    ]))
      if (result.status === "rejected") errors.push(result.reason);
    try {
      await workload.close();
    } catch (error) {
      errors.push(error);
    }
    rmSync(directory, { recursive: true, force: true });
  }
  if (errors.length) throw new AggregateError(errors, "Peer fixture failed");
}

it("returns its fixed registration for a fresh authenticated identity challenge", async () => {
  await withPeer(async (f) => {
    const input = f.identity();
    const reply = await f.reply(f.send(input));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      request_id: input.request_id,
      membership_sha256: input.membership_sha256,
      challenge: input.challenge,
      registration: f.registration,
    });
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(f.apply).not.toHaveBeenCalled();
  });
});

it("returns only an exact local publication/revocation receipt after the leaf operation finishes", async () => {
  await withPeer(async (f) => {
    const input = f.publication();
    const reply = await f.reply(f.send(input, { path: publicationPath }));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(receipt(input));
    expect(f.apply).toHaveBeenCalledOnce();
    expect(Object.isFrozen(f.apply.mock.calls[0]![0])).toBe(true);
    expect(Object.isFrozen(f.apply.mock.calls[0]![0].target)).toBe(true);
  });
});

it("rejects ordinary credentials before consuming an unfinished request body", async () => {
  await withPeer(async (f) => {
    const task = f.send("", {
      held: true,
      declaredBytes: 1000,
      headers: workloadHeaders("agent-ui"),
    });
    const reply = await bounded(f.reply(task), 500);
    expect(reply.status).toBe(401);
    expect(f.apply).not.toHaveBeenCalled();
  });
});

it.each([
  ["GET", identityPath, 405, "method_not_allowed"],
  ["POST", identityPath + "?target=other", 400, "invalid_request"],
  ["POST", "/rpc/agent-acp/apply-execution-snapshot", 404, "route_not_found"],
  ["POST", "/internal/acp-owner/incarnation/probe", 404, "route_not_found"],
] as const)(
  "restricts peer purpose to exact routes: %s %s",
  async (method, path, status, code) => {
    await withPeer(async (f) => {
      const reply = await f.reply(f.send(f.identity(), { method, path }));
      expect(reply.status).toBe(status);
      expect(reply.body.code).toBe(code);
      expect(f.apply).not.toHaveBeenCalled();
    });
  },
);

it.each([
  "source",
  "membership",
  "target",
  "old-incarnation",
  "hop",
  "deadline",
  "extended-deadline",
  "extra",
  "cct",
  "media",
  "oversize",
])("rejects %s before invoking the leaf", async (kind) => {
  await withPeer(async (f) => {
    const input: Record<string, unknown> = { ...f.publication() };
    const options: SendOptions = { path: publicationPath };
    let code = "invalid_request";
    if (kind === "source") {
      input.source = { ...(input.source as object), member_id: "acp-b" };
      code = "caller_not_allowed";
    }
    if (kind === "membership") {
      input.membership_sha256 = "c".repeat(64);
      code = "acp_peer_membership_conflict";
    }
    if (kind === "target") {
      input.target = { ...(input.target as object), member_id: "acp-a" };
      code = "acp_peer_incarnation_mismatch";
    }
    if (kind === "old-incarnation") {
      input.target = {
        ...(input.target as object),
        incarnation_id: randomUUID(),
      };
      code = "acp_peer_incarnation_mismatch";
    }
    if (kind === "hop") {
      input.hop = 2;
      code = "acp_peer_hop_rejected";
    }
    if (kind === "deadline") {
      input.deadline_at = new Date(Date.now() - 1).toISOString();
      code = "deadline_exceeded";
    }
    if (kind === "extended-deadline")
      input.deadline_at = new Date(Date.now() + 20000).toISOString();
    if (kind === "extra") input.origin = "http://other.invalid";
    if (kind === "cct")
      options.headers = { "Antnest-Caller-Context": "not-permitted" };
    if (kind === "media") {
      options.headers = { "Content-Type": "text/plain" };
      code = "unsupported_media_type";
    }
    if (kind === "oversize") {
      options.declaredBytes = 16385;
      options.held = true;
      code = "request_too_large";
    }
    const reply = await f.reply(f.send(input, options));
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.body.code).toBe(code);
    expect(f.apply).not.toHaveBeenCalled();
  });
});

it("preserves the private deadline status when WebSocket admission expires", async () => {
  await withPeer(
    async (f) => {
      const socket = f.connectForward({
        ...f.publication(),
        identity: {
          organizationId: "org-1",
          principalId: "principal-1",
          agentId: "agent-1",
        },
        epoch: "1",
        protocol: "v1",
        caller: "agent-ui",
      });
      await expect(once(socket, "open")).rejects.toThrow(
        "Unexpected server response: 504",
      );
    },
    { forward: () => Promise.reject(new PeerDeadlineError()) },
  );
});

it("preserves the private deadline status when publication admission expires", async () => {
  await withPeer(
    async (f) => {
      const reply = await f.reply(
        f.send(f.publication(), { path: publicationPath }),
      );
      expect(reply.status).toBe(504);
      expect(reply.body.code).toBe("deadline_exceeded");
    },
    { apply: () => Promise.reject(new PeerDeadlineError()) },
  );
});

it("waits for the original operation after its request deadline and never sends a late success", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const released = Promise.withResolvers<void>();
  await withPeer(
    async (f) => {
      f.release.push(() => released.resolve());
      const input = {
        ...f.publication(),
        deadline_at: new Date(Date.now() + 100).toISOString(),
      };
      const task = f.send(input, { path: publicationPath });
      const signal = await bounded(entered.promise);
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      let complete = false;
      void task.result.then(() => {
        complete = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(complete).toBe(false);
      released.resolve();
      const reply = await f.reply(task);
      expect(reply.status).toBe(504);
      expect(reply.body.code).toBe("deadline_exceeded");
    },
    {
      apply: async (input, signal) => {
        entered.resolve(signal);
        await released.promise;
        return receipt(input);
      },
    },
  );
});

it("shutdown retains the original leaf operation before closing its sockets and listener", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const released = Promise.withResolvers<void>();
  await withPeer(
    async (f) => {
      f.release.push(() => released.resolve());
      const task = f.send(f.publication(), { path: publicationPath });
      const signal = await bounded(entered.promise);
      let closed = false;
      const closing = f.close().then(() => {
        closed = true;
      });
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect(closed).toBe(false);
      released.resolve();
      await bounded(closing);
      await task.join();
      expect(f.server.address()).toBeNull();
    },
    {
      apply: async (input, signal) => {
        entered.resolve(signal);
        await released.promise;
        return receipt(input);
      },
    },
  );
});

it("rejects a leaf receipt that does not prove this fixed registration and joined revocation", async () => {
  await withPeer(
    async (f) => {
      const reply = await f.reply(
        f.send(f.publication(), { path: publicationPath }),
      );
      expect(reply.status).toBe(500);
    },
    {
      apply: (input) =>
        Promise.resolve({
          ...receipt(input),
          registration: { ...input.target, incarnation_id: randomUUID() },
        }),
    },
  );
});

it("checks the absolute deadline after a leaf returns even before its timer callback runs", async () => {
  const clock = vi.spyOn(Date, "now");
  try {
    await withPeer(
      async (f) => {
        const reply = await f.reply(
          f.send(f.publication(), { path: publicationPath }),
        );
        expect(reply.status).toBe(504);
      },
      {
        apply: (input) => {
          clock.mockReturnValue(Date.parse(input.deadline_at) + 1);
          return Promise.resolve(receipt(input));
        },
      },
    );
  } finally {
    clock.mockRestore();
  }
});

it("keeps a late independent leaf failure observable after client disconnection", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const late = new Error("independent original leaf failure");
  const failure: unknown = await withPeer(
    async (f) => {
      f.release.push(() => release.resolve());
      const task = f.send(f.publication(), { path: publicationPath });
      const signal = await bounded(entered.promise);
      task.request.destroy(new Error("caller disconnected"));
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      let finished = false;
      const closing = f.close().then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      release.reject(late);
      await bounded(closing);
      await task.join();
    },
    {
      apply: async (input, signal) => {
        entered.resolve(signal);
        await release.promise;
        return receipt(input);
      },
    },
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toHaveLength(1);
  const errors = (failure as AggregateError).errors[0] as AggregateError;
  expect(errors).toBeInstanceOf(AggregateError);
  expect(
    errors.errors.some(
      (error: unknown) => error instanceof Error && error.cause === late,
    ),
  ).toBe(true);
});

it("bounds a valid multibyte publication receipt by UTF-8 bytes before sending it", async () => {
  await withPeer(
    async (f) => {
      const input = {
        ...f.publication(),
        deadline_at: new Date(Date.now() + 9000).toISOString(),
      };
      const reply = await f.reply(f.send(input, { path: publicationPath }));
      expect(reply.status).toBe(500);
      expect(reply.body.code).toBe("internal_error");
      expect(Number(reply.headers["content-length"])).toBeLessThan(1024);
      expect(f.apply).toHaveBeenCalledOnce();
    },
    {
      timeoutMs: 10000,
      apply: (input) =>
        Promise.resolve({
          ...receipt(input),
          owned_agents: Array.from({ length: 40000 }, (_unused, index) => ({
            agent_id: "界".repeat(150) + String(index),
            epoch: "1",
          })),
        }),
    },
  );
});
