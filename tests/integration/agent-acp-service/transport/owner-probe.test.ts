import { randomUUID } from "node:crypto";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { describe, expect, it, vi } from "vitest";
import { OwnerIncarnation } from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import { OwnerProbeServer } from "../../../../services/agent-acp-service/src/transport/owner-probe-server.js";
import {
  SERVICES,
  type ServiceAuthentication,
} from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import {
  testAuthentication,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";

const path = "/internal/acp-owner/incarnation/probe";
const challenge = "c".repeat(64);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// This is only a failed-test deadline. Every underlying request/socket and
// server close is still joined independently in withProbe's finally block.
async function bounded<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = 3000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not finish`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Reply = { status: number; headers: IncomingHttpHeaders; rawBody: Buffer };
type Outcome =
  { kind: "response"; value: Reply } | { kind: "error"; error: unknown };
type Exchange = {
  request: ClientRequest;
  result: Promise<Outcome>;
  join(): Promise<void>;
  abort(reason?: Error): void;
};
type RequestOptions = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  held?: boolean;
  chunked?: boolean;
  declaredBytes?: number;
};

function exchange(
  port: number,
  body: string | Buffer,
  options: RequestOptions = {},
): Exchange {
  const result = deferred<Outcome>();
  const requestClosed = deferred<void>();
  let socketClosed = Promise.resolve();
  let responseClosed = Promise.resolve();
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: options.method ?? "POST",
    path: options.path ?? path,
    agent: false,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? workloadHeaders("runtime-controller")),
      ...(options.chunked
        ? { "Transfer-Encoding": "chunked" }
        : {
            "Content-Length": options.declaredBytes ?? Buffer.byteLength(body),
          }),
      Connection: options.headers?.Connection ?? "close",
    },
  });
  request.once("socket", (socket) => {
    const closed = deferred<void>();
    socketClosed = closed.promise;
    socket.once("close", () => closed.resolve());
  });
  request.once("response", (response) => {
    const closed = deferred<void>();
    responseClosed = closed.promise;
    response.once("close", () => closed.resolve());
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.once("error", (error) => result.resolve({ kind: "error", error }));
    response.once("aborted", () =>
      result.resolve({
        kind: "error",
        error: new Error("probe response aborted"),
      }),
    );
    response.once("end", () => {
      if (!response.complete) {
        result.resolve({
          kind: "error",
          error: new Error("probe response incomplete"),
        });
        return;
      }
      result.resolve({
        kind: "response",
        value: {
          status: response.statusCode!,
          headers: response.headers,
          rawBody: Buffer.concat(chunks),
        },
      });
    });
  });
  request.once("error", (error) => result.resolve({ kind: "error", error }));
  request.once("close", () => {
    result.resolve({
      kind: "error",
      error: new Error("probe request closed without a complete response"),
    });
    requestClosed.resolve();
  });
  if (options.held) {
    request.flushHeaders();
    if (Buffer.byteLength(body) !== 0) request.write(body);
  } else {
    request.end(body);
  }
  return {
    request,
    result: result.promise,
    async join() {
      await requestClosed.promise;
      await responseClosed;
      await socketClosed;
    },
    abort(reason = new Error("probe test cleanup")) {
      request.destroy(reason);
    },
  };
}

type ProbeInput = {
  member_id: string;
  incarnation_id: string;
  registration_nonce: string;
  challenge: string;
};
type Fixture = {
  incarnation: OwnerIncarnation;
  authentication: ServiceAuthentication;
  server: OwnerProbeServer;
  input: ProbeInput;
  restores: (() => void)[];
  send(body?: string | Buffer, options?: RequestOptions): Exchange;
  closeServer(): Promise<void>;
};

async function withProbe(
  action: (fixture: Fixture) => Promise<void>,
  timeoutMs?: number,
) {
  const authentication = testAuthentication().workload;
  const exchanges: Exchange[] = [];
  const restores: (() => void)[] = [];
  const errors: unknown[] = [];
  let incarnation: OwnerIncarnation | undefined;
  let server: OwnerProbeServer | undefined;
  let closing: Promise<void> | undefined;
  const closeServer = () => (closing ??= server?.close() ?? Promise.resolve());
  try {
    incarnation = new OwnerIncarnation("acp-a");
    server = new OwnerProbeServer({
      incarnation,
      authentication,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null)
      throw new Error("Owner probe must have a TCP address");
    const input: ProbeInput = {
      ...incarnation.registrationRequest(),
      challenge,
    };
    await action({
      incarnation,
      authentication,
      server,
      input,
      restores,
      closeServer,
      send(body = JSON.stringify(input), options) {
        const task = exchange(address.port, body, options);
        exchanges.push(task);
        return task;
      },
    });
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      incarnation?.close();
    } catch (error) {
      errors.push(error);
    }
    for (const task of exchanges) {
      try {
        task.abort();
      } catch (error) {
        errors.push(error);
      }
    }
    const joined = await Promise.allSettled([
      ...exchanges.map((task) => task.join()),
      Promise.resolve().then(closeServer),
    ]);
    for (const result of joined)
      if (result.status === "rejected") errors.push(result.reason);
    for (const restore of restores.reverse()) {
      try {
        restore();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await authentication.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length !== 0)
    throw new AggregateError(errors, "Owner probe TCP fixture failed");
}

async function reply(task: Exchange, milliseconds = 3000): Promise<Reply> {
  const deadline = performance.now() + milliseconds;
  const outcome = await bounded(
    task.result,
    "original HTTP response",
    milliseconds,
  );
  await bounded(
    task.join(),
    "original HTTP request and socket close",
    Math.max(1, deadline - performance.now()),
  );
  if (outcome.kind === "error") throw outcome.error;
  return outcome.value;
}

function json(response: Reply): unknown {
  expect(response.headers["content-type"]).toMatch(
    /^application\/json(?:;|$)/u,
  );
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.rawBody.byteLength).toBeLessThanOrEqual(8192);
  return JSON.parse(response.rawBody.toString("utf8")) as unknown;
}

function failure(
  response: Reply,
  status: number,
  code: string,
  input: ProbeInput,
) {
  expect(response.status).toBe(status);
  const body = json(response) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["code", "message", "retryable"]);
  expect(body.code).toBe(code);
  expect(body.retryable).toBe(status >= 500);
  expect(typeof body.message).toBe("string");
  expect((body.message as string).length).toBeGreaterThan(0);
  expect((body.message as string).length).toBeLessThanOrEqual(512);
  expect(response.rawBody.toString("utf8")).not.toContain(
    input.registration_nonce,
  );
  expect(response.rawBody.toString("utf8")).not.toContain(input.challenge);
}

function authenticated(fixture: Fixture): Promise<void> {
  const called = deferred<void>();
  const original = fixture.authentication.authenticate.bind(
    fixture.authentication,
  );
  const spy = vi
    .spyOn(fixture.authentication, "authenticate")
    .mockImplementation((request, allowed) => {
      const result = original(request, allowed);
      called.resolve();
      return result;
    });
  fixture.restores.push(() => spy.mockRestore());
  return called.promise;
}

function probes(fixture: Fixture) {
  const spy = vi.spyOn(fixture.incarnation, "probe");
  fixture.restores.push(() => spy.mockRestore());
  return spy;
}

describe("independent authenticated ACP incarnation probe", () => {
  it.each(SERVICES.filter((service) => service !== "agent-acp-service"))(
    "admits only the RC workload on the owner listener: %s",
    async (caller) => {
      await withProbe(async (fixture) => {
        const response = await reply(
          fixture.send(undefined, { headers: workloadHeaders(caller) }),
        );
        if (caller === "runtime-controller") {
          expect(response.status).toBe(200);
          expect(json(response)).toEqual(fixture.input);
        } else {
          failure(response, 403, "caller_not_allowed", fixture.input);
        }
      });
    },
  );
  it("echoes exactly four fields without CCT and leaves the original intent pending", async () => {
    await withProbe(async (fixture) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await reply(fixture.send());
        expect(response.status).toBe(200);
        expect(json(response)).toEqual(fixture.input);
        expect(Object.keys(json(response) as object).sort()).toEqual([
          "challenge",
          "incarnation_id",
          "member_id",
          "registration_nonce",
        ]);
      }
    });
  });

  it.each([
    ["missing", {}, 401, "service_unauthenticated"],
    [
      "unknown",
      { "Antnest-Service-Authorization": `Bearer ${"A".repeat(43)}` },
      401,
      "service_unauthenticated",
    ],
    [
      "Controller",
      workloadHeaders("agent-controller"),
      403,
      "caller_not_allowed",
    ],
    ["UI", workloadHeaders("agent-ui"), 403, "caller_not_allowed"],
  ] as const)(
    "rejects %s authority before an oversized held body or media decoding",
    async (_name, headers, status, code) => {
      await withProbe(async (fixture) => {
        const probe = probes(fixture);
        const task = fixture.send("", {
          headers: { ...headers, "Content-Type": "application/octet-stream" },
          declaredBytes: 4097,
          held: true,
        });
        failure(await reply(task), status, code, fixture.input);
        expect(task.request.writableEnded).toBe(false);
        expect(probe).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    ["GET", path, 405, "method_not_allowed"],
    ["POST", `${path}/`, 404, "route_not_found"],
    ["POST", "/status", 404, "route_not_found"],
    ["POST", "/v1/acp", 404, "route_not_found"],
    ["POST", "/rpc/agent-acp/apply-execution-snapshot", 404, "route_not_found"],
    ["POST", "/internal/acp-owner/incarnation/Probe", 404, "route_not_found"],
    ["POST", `${path}?extra=1`, 400, "invalid_request"],
  ] as const)(
    "limits the independent listener to its exact method/path: %s %s",
    async (method, route, status, code) => {
      await withProbe(async (fixture) => {
        const probe = probes(fixture);
        failure(
          await reply(fixture.send(undefined, { method, path: route })),
          status,
          code,
          fixture.input,
        );
        expect(probe).not.toHaveBeenCalled();
      });
    },
  );

  it.each([false, true])(
    "enforces the real 4096-byte boundary with chunked=%s",
    async (chunked) => {
      await withProbe(async (fixture) => {
        const raw = JSON.stringify(fixture.input);
        const exact = raw + " ".repeat(4096 - Buffer.byteLength(raw));
        const accepted = await reply(fixture.send(exact, { chunked }));
        expect(accepted.status).toBe(200);
        expect(json(accepted)).toEqual(fixture.input);
        failure(
          await reply(fixture.send(`${exact} `, { chunked })),
          413,
          "request_too_large",
          fixture.input,
        );
      });
    },
  );

  it.each([
    "duplicate",
    "decoded duplicate",
    "case alias",
    "extra",
    "missing",
    "null",
    "wrong type",
    "multiple JSON",
    "BOM",
    "invalid UTF-8",
    "invalid nonce",
    "invalid challenge",
  ])("rejects strict probe JSON: %s", async (kind) => {
    await withProbe(async (fixture) => {
      const raw = JSON.stringify(fixture.input);
      const encoded = JSON.stringify(fixture.input.incarnation_id);
      const invalid: Record<string, string | Buffer> = {
        duplicate: `{"incarnation_id":${encoded},${raw.slice(1)}`,
        "decoded duplicate": `{"incarnation_\\u0069d":${encoded},${raw.slice(1)}`,
        "case alias": JSON.stringify({
          ...fixture.input,
          Incarnation_id: fixture.input.incarnation_id,
        }),
        extra: JSON.stringify({
          ...fixture.input,
          container_selector: "untrusted-container",
        }),
        missing: JSON.stringify({
          member_id: fixture.input.member_id,
          incarnation_id: fixture.input.incarnation_id,
          challenge,
        }),
        null: "null",
        "wrong type": JSON.stringify({ ...fixture.input, challenge: 1 }),
        "multiple JSON": `${raw}\n{}`,
        BOM: `\ufeff${raw}`,
        "invalid UTF-8": Buffer.concat([
          Buffer.from(raw.slice(0, -1)),
          Buffer.from([0xff]),
          Buffer.from("}"),
        ]),
        "invalid nonce": JSON.stringify({
          ...fixture.input,
          registration_nonce: "a".repeat(63),
        }),
        "invalid challenge": JSON.stringify({
          ...fixture.input,
          challenge: "C".repeat(64),
        }),
      };
      failure(
        await reply(fixture.send(invalid[kind])),
        400,
        "invalid_request",
        fixture.input,
      );
    });
  });

  it.each(["member_id", "incarnation_id", "registration_nonce"])(
    "uniformly rejects a different pending identity field: %s",
    async (field) => {
      await withProbe(async (fixture) => {
        const changed = {
          member_id: "acp-b",
          incarnation_id: randomUUID(),
          registration_nonce:
            fixture.input.registration_nonce === "a".repeat(64)
              ? "b".repeat(64)
              : "a".repeat(64),
        };
        failure(
          await reply(
            fixture.send(
              JSON.stringify({
                ...fixture.input,
                [field]: changed[field as keyof typeof changed],
              }),
            ),
          ),
          409,
          "acp_probe_intent_mismatch",
          fixture.input,
        );
        expect((await reply(fixture.send())).status).toBe(200);
      });
    },
  );

  it.each(["receipt", "closed"])(
    "returns the same mismatch after intent %s",
    async (state) => {
      await withProbe(async (fixture) => {
        expect((await reply(fixture.send())).status).toBe(200);
        if (state === "receipt") {
          fixture.incarnation.acceptRegistration({
            registration_id: randomUUID(),
            member_id: fixture.input.member_id,
            incarnation_id: fixture.input.incarnation_id,
          });
        } else {
          fixture.incarnation.close();
        }
        failure(
          await reply(fixture.send()),
          409,
          "acp_probe_intent_mismatch",
          fixture.input,
        );
      });
    },
  );

  it.each([false, true])(
    "joins a timed-out held body with chunked=%s and keeps the intent usable",
    async (chunked) => {
      await withProbe(async (fixture) => {
        const started = authenticated(fixture);
        const probe = probes(fixture);
        const raw = JSON.stringify(fixture.input);
        const task = fixture.send(raw.slice(0, -1), {
          held: true,
          chunked,
          declaredBytes: Buffer.byteLength(raw),
        });
        await bounded(started, "actual authenticated request");
        failure(await reply(task), 504, "deadline_exceeded", fixture.input);
        expect(task.request.writableEnded).toBe(false);
        expect(probe).not.toHaveBeenCalled();
        expect((await reply(fixture.send())).status).toBe(200);
      }, 150);
    },
  );

  it("uses the default two-second deadline for an unfinished real body", async () => {
    await withProbe(async (fixture) => {
      const started = authenticated(fixture);
      const raw = JSON.stringify(fixture.input);
      const task = fixture.send(raw.slice(0, -1), {
        held: true,
        declaredBytes: Buffer.byteLength(raw),
      });
      await bounded(started, "default-budget authenticated request");
      failure(await reply(task, 2500), 504, "deadline_exceeded", fixture.input);
    });
  });

  it("joins an actual client cancellation before server cleanup completes", async () => {
    await withProbe(async (fixture) => {
      const started = authenticated(fixture);
      const probe = probes(fixture);
      const raw = JSON.stringify(fixture.input);
      const task = fixture.send(raw.slice(0, -1), {
        held: true,
        chunked: true,
      });
      await bounded(started, "cancelled request authentication");
      const reason = new Error("intentional probe TCP cancellation");
      task.abort(reason);
      const outcome = await bounded(task.result, "cancelled request outcome");
      await bounded(task.join(), "cancelled request actual close");
      expect(outcome).toEqual({ kind: "error", error: reason });
      await bounded(
        fixture.closeServer(),
        "server actual close after client cancellation",
      );
      expect(fixture.server.address()).toBeNull();
      expect(probe).not.toHaveBeenCalled();
    }, 150);
  });

  it("close aborts and joins an unfinished authenticated TCP request", async () => {
    await withProbe(async (fixture) => {
      const started = authenticated(fixture);
      const probe = probes(fixture);
      const raw = JSON.stringify(fixture.input);
      const task = fixture.send(raw.slice(0, -1), {
        held: true,
        chunked: true,
      });
      await bounded(started, "closing request authentication");
      await bounded(
        Promise.all([fixture.closeServer(), task.join()]),
        "server and original TCP request actual close",
      );
      expect(fixture.server.address()).toBeNull();
      expect(task.request.destroyed).toBe(true);
      expect(probe).not.toHaveBeenCalled();
    }, 150);
  });
});

it("authenticates an anonymous WebSocket upgrade on the independent owner listener", async () => {
  await withProbe(async (fixture) => {
    const response = await reply(
      fixture.send("", {
        method: "GET",
        path: "/v1/acp",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "MDEyMzQ1Njc4OWFiY2RlZg==",
        },
      }),
    );
    failure(response, 401, "service_unauthenticated", fixture.input);
  });
});
