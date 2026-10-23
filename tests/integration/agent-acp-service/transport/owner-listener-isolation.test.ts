import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import {
  testAuthentication,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";

const path = "/internal/acp-owner/incarnation/probe";
const listeners = ["workspace", "control"] as const;
type Listener = (typeof listeners)[number];
type Reply = { status: number; headers: IncomingHttpHeaders };
type Exchange = {
  request: ClientRequest;
  response: Promise<Reply>;
  join(): Promise<void>;
};

const credentials: Array<[string, Record<string, string>]> = [
  ["anonymous", {}],
  [
    "forged",
    {
      Authorization: "Bearer forged-session",
      "Antnest-Service-Authorization": "Bearer forged-workload",
      "X-Antnest-Service": "runtime-controller",
      "Antnest-Caller-Context": "forged.context.signature",
    },
  ],
  ...["runtime-controller", "agent-controller", "edge-gateway"].map(
    (caller): [string, Record<string, string>] => [
      caller,
      workloadHeaders(caller),
    ],
  ),
];

let server: AgentAcpHttpServer | undefined;
let admit: MockInstance<ReturnType<typeof testAuthentication>["admit"]>;
const ready = vi.fn(() => Promise.resolve(true));
const application = vi.fn();
const exchanges: Exchange[] = [];
const ports: Partial<Record<Listener, number>> = {};

beforeEach(async () => {
  const authentication = testAuthentication();
  admit = vi.spyOn(authentication, "admit");
  ready.mockClear();
  application.mockClear();
  server = new AgentAcpHttpServer({
    authentication,
    application: new Proxy(
      {},
      { get: () => application },
    ) as AcpApplicationPort,
    executionConfiguration: { apply: application },
    settlement: { settle: application },
    ready,
    maxWebSocketPayloadBytes: 65536,
  });
  await server.listen("127.0.0.1", 0);
  await server.listenControl("127.0.0.1", 0);
  const workspace = server.address();
  const control = server.controlAddress();
  if (
    !workspace ||
    typeof workspace === "string" ||
    !control ||
    typeof control === "string"
  )
    throw new Error("Missing ordinary ACP listeners");
  ports.workspace = workspace.port;
  ports.control = control.port;
});

afterEach(async () => {
  // Stop every original client even when an assertion or test deadline failed.
  // Listener close and each request/response/socket receipt are joined separately.
  for (const exchange of exchanges) exchange.request.destroy();
  const closing = server;
  const results = await Promise.allSettled([
    Promise.resolve().then(() => closing?.close()),
    ...exchanges.map((exchange) => exchange.join()),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  try {
    if (closing !== undefined) {
      expect(closing.address()).toBeNull();
      expect(closing.controlAddress()).toBeNull();
    }
  } catch (error) {
    failures.push(error);
  } finally {
    exchanges.length = 0;
    server = undefined;
    delete ports.workspace;
    delete ports.control;
    vi.restoreAllMocks();
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "Owner listener isolation cleanup failed",
    );
});

function send(
  listener: Listener,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    heldBody?: boolean;
    upgrade?: boolean;
  } = {},
): Exchange {
  const response = Promise.withResolvers<Reply>();
  const requestClosed = Promise.withResolvers<void>();
  let socketClosed = Promise.resolve();
  let responseClosed = Promise.resolve();
  let failure: Error | undefined;
  const fail = (error: unknown) => {
    failure ??=
      error instanceof Error
        ? error
        : new Error("Isolation exchange failed", { cause: error });
    response.reject(failure);
  };
  const trackResponse = (incoming: IncomingMessage) => {
    const closed = Promise.withResolvers<void>();
    responseClosed = closed.promise;
    incoming.once("close", () => closed.resolve());
    incoming.once("error", fail);
    incoming.once("aborted", () =>
      fail(new Error("Isolation response was aborted")),
    );
  };
  const request = httpRequest({
    host: "127.0.0.1",
    port: ports[listener],
    method: options.method ?? "POST",
    path: options.path ?? path,
    agent: false,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": options.heldBody ? "4096" : "0",
      Connection: "close",
      ...(options.upgrade
        ? {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "MDEyMzQ1Njc4OWFiY2RlZg==",
          }
        : {}),
      ...options.headers,
    },
  });
  request.once("socket", (socket) => {
    const closed = Promise.withResolvers<void>();
    socketClosed = closed.promise;
    socket.once("close", () => closed.resolve());
  });
  request.once("response", (incoming) => {
    trackResponse(incoming);
    incoming.once("end", () => {
      if (!incoming.complete)
        fail(new Error("Isolation response was incomplete"));
      else
        response.resolve({
          status: incoming.statusCode!,
          headers: incoming.headers,
        });
    });
    incoming.resume();
  });
  request.once("upgrade", (incoming, socket) => {
    trackResponse(incoming);
    fail(new Error("Ordinary listener accepted an owner probe upgrade"));
    incoming.destroy();
    socket.destroy();
    request.destroy();
  });
  request.once("error", fail);
  request.once("close", () => {
    response.reject(
      new Error("Isolation request closed without a complete response"),
    );
    requestClosed.resolve();
  });
  // A failure deadline destroys the real request; it cannot count as a close proof.
  request.setTimeout(3000, () =>
    request.destroy(new Error("Isolation request timed out")),
  );
  const exchange: Exchange = {
    request,
    response: response.promise,
    async join() {
      await requestClosed.promise;
      await responseClosed;
      await socketClosed;
      if (failure !== undefined) throw failure;
    },
  };
  void response.promise.catch(() => undefined);
  exchanges.push(exchange);
  if (options.heldBody) {
    request.flushHeaders();
    request.write("{");
  } else {
    request.end();
  }
  return exchange;
}

function expectUntouched() {
  expect(admit).not.toHaveBeenCalled();
  expect(ready).not.toHaveBeenCalled();
  expect(application).not.toHaveBeenCalled();
}

it.each(listeners)(
  "isolates owner HTTP methods and queries on %s before authentication",
  async (listener) => {
    for (const [caller, headers] of credentials) {
      for (const method of [
        "POST",
        "GET",
        "HEAD",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ]) {
        for (const suffix of ["", "?probe=1"]) {
          const exchange = send(listener, {
            method,
            path: path + suffix,
            headers,
          });
          const response = await exchange.response;
          expect(
            response.status,
            `${listener} ${caller} ${method} ${suffix}`,
          ).toBe(404);
          expect(response.headers["www-authenticate"]).toBeUndefined();
          await exchange.join();
          expectUntouched();
        }
      }
    }
  },
);

it.each(listeners)(
  "rejects owner WebSocket upgrades on %s before authentication",
  async (listener) => {
    for (const [caller, headers] of credentials) {
      for (const suffix of ["", "?probe=1"]) {
        const exchange = send(listener, {
          method: "GET",
          path: path + suffix,
          headers,
          upgrade: true,
        });
        const response = await exchange.response;
        expect(response.status, `${listener} ${caller} upgrade ${suffix}`).toBe(
          404,
        );
        expect(response.headers["www-authenticate"]).toBeUndefined();
        await exchange.join();
        expectUntouched();
      }
    }
  },
);

it.each(listeners)(
  "rejects an unfinished owner body on %s without waiting for or parsing it",
  async (listener) => {
    const exchange = send(listener, {
      headers: workloadHeaders("runtime-controller"),
      heldBody: true,
    });
    const response = await exchange.response;
    expect(response.status).toBe(404);
    expect(exchange.request.writableEnded).toBe(false);
    expect(response.headers.connection).toBe("close");
    expectUntouched();
    await exchange.join();
  },
);

it("preserves authentication for an ordinary unknown workspace path", async () => {
  const exchange = send("workspace", {
    method: "GET",
    path: "/owner-isolation-unknown",
  });
  const response = await exchange.response;
  expect(response.status).toBe(401);
  expect(response.headers["www-authenticate"]).toBe(
    'Bearer realm="antnest-service"',
  );
  expect(admit).toHaveBeenCalledOnce();
  expect(ready).not.toHaveBeenCalled();
  expect(application).not.toHaveBeenCalled();
  await exchange.join();
});
