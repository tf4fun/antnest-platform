import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import {
  createConnection,
  createServer as createTcpServer,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  startAgentAcpService,
  type RunningAgentAcpService,
} from "../../../../services/agent-acp-service/src/composition.js";
import {
  loadConfig,
  type AgentAcpConfig,
} from "../../../../services/agent-acp-service/src/config.js";
import {
  OwnerIncarnationError,
  type OwnerRegistrationRequest,
} from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import { SERVICE_AUTH_HEADER } from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import { RuntimeControllerIncarnations } from "../../../../services/agent-acp-service/src/adapters/runtime-controller-incarnations.js";
import {
  NOOP_TELEMETRY,
  type TelemetryPort,
} from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import {
  testSecurityEnvironment,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";

const probePath = "/internal/acp-owner/incarnation/probe";
const memberId = "acp-startup";
const guardMs = 2000;
const cleanupMs = 8000;
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Mode =
  | "held-body"
  | "rejected"
  | "registered"
  | "receipt-lost-once"
  | "receipt-always-lost";
type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer };
type Exchange = {
  result: Promise<Outcome<Reply>>;
  abort(): void;
  join(): Promise<void>;
};
type RegistrationCall = {
  input: OwnerRegistrationRequest;
  socketClosed: Promise<void>;
  finished: Promise<void>;
};

function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then<Outcome<T>, Outcome<T>>(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

// A guard only reports failure. Fixture cleanup still aborts and joins the
// original startup, authenticated fetches, HTTP handlers and TCP sockets.
async function bounded<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = guardMs,
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

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function startupFailure(outcome: Outcome<RunningAgentAcpService>): unknown {
  if (outcome.ok)
    throw new Error("startup unexpectedly opened the ordinary service");
  expect(outcome.error).toBeInstanceOf(Error);
  return outcome.error;
}

function probeExchange(
  port: number,
  body: string,
  headers: Record<string, string>,
): Exchange {
  const result = Promise.withResolvers<Outcome<Reply>>();
  const requestClosed = Promise.withResolvers<void>();
  let socketClosed = Promise.resolve();
  let responseClosed = Promise.resolve();
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    path: probePath,
    method: "POST",
    agent: false,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
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
    response.once("error", (error) => result.resolve({ ok: false, error }));
    response.once("aborted", () =>
      result.resolve({
        ok: false,
        error: new Error("startup probe response aborted"),
      }),
    );
    response.once("end", () => {
      if (!response.complete) {
        result.resolve({
          ok: false,
          error: new Error("startup probe response incomplete"),
        });
        return;
      }
      result.resolve({
        ok: true,
        value: {
          status: response.statusCode!,
          headers: response.headers,
          body: Buffer.concat(chunks),
        },
      });
    });
  });
  request.once("error", (error) => result.resolve({ ok: false, error }));
  request.once("close", () => {
    result.resolve({
      ok: false,
      error: new Error("startup probe closed without a complete response"),
    });
    requestClosed.resolve();
  });
  request.end(body);
  return {
    result: result.promise,
    abort() {
      request.destroy(new Error("startup fixture cleanup"));
    },
    async join() {
      await requestClosed.promise;
      await responseClosed;
      await socketClosed;
    },
  };
}

async function connectionRefused(port: number): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port });
  const closed = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string>();
  socket.once("connect", () => result.resolve("connected"));
  socket.once("error", (error: NodeJS.ErrnoException) =>
    result.resolve(error.code ?? "unknown"),
  );
  socket.once("close", () => closed.resolve());
  let actual: string;
  try {
    actual = await bounded(result.promise, "TCP connection refusal");
  } finally {
    socket.destroy();
    await bounded(closed.promise, "TCP connection-refusal socket close");
  }
  expect(actual).toBe("ECONNREFUSED");
}

async function reservePorts() {
  const servers: ReturnType<typeof createTcpServer>[] = [];
  const ports: number[] = [];
  let closing: Promise<void> | undefined;
  const release = (): Promise<void> =>
    (closing ??= (async () => {
      const results = await Promise.allSettled(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              if (!server.listening) {
                resolve();
                return;
              }
              server.close((error) =>
                error === undefined ? resolve() : reject(error),
              );
            }),
        ),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (failures.length !== 0)
        throw new AggregateError(
          failures,
          "startup port reservations did not close",
        );
    })());
  try {
    for (let index = 0; index < 4; index++) {
      const server = createTcpServer();
      servers.push(server);
      await bounded(
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        }),
        "startup port reservation",
      );
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("missing reserved TCP port");
      ports.push(address.port);
    }
    return {
      owner: ports[0]!,
      workspace: ports[1]!,
      control: ports[2]!,
      database: ports[3]!,
      release,
    };
  } catch (error) {
    await bounded(release(), "failed startup port reservation cleanup");
    throw error;
  }
}

async function readRequest(
  request: IncomingMessage,
): Promise<OwnerRegistrationRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = chunk as Buffer;
    bytes += data.byteLength;
    if (bytes > 4096)
      throw new Error("startup registration request exceeded its wire budget");
    chunks.push(data);
  }
  const input = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as OwnerRegistrationRequest;
  expect(Object.keys(input).sort()).toEqual([
    "incarnation_id",
    "member_id",
    "registration_nonce",
  ]);
  expect(input.member_id).toBe(memberId);
  expect(input.incarnation_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(input.registration_nonce).toMatch(/^[0-9a-f]{64}$/u);
  return input;
}

type StartupFixture = {
  config: AgentAcpConfig;
  abort: AbortController;
  startup: Promise<Outcome<RunningAgentAcpService>>;
  verified: Promise<Outcome<RegistrationCall>>;
  firstRegistrationResponse: Promise<Outcome<Response>>;
  registrationResponses: Response[];
  sequence: string[];
  calls: RegistrationCall[];
  socketCount(): number;
  workloadCloseCalls(): number;
  workloadClosed(): boolean;
  expectNoOrdinaryListener(): void;
};

async function withStartup(
  mode: Mode,
  work: (fixture: StartupFixture) => Promise<void>,
  registrationTimeout = "5s",
): Promise<void> {
  const failures: unknown[] = [];
  const controller = new AbortController();
  const releaseBody = Promise.withResolvers<void>();
  const verified = Promise.withResolvers<Outcome<RegistrationCall>>();
  const firstRegistrationResponse = Promise.withResolvers<Outcome<Response>>();
  const sequence: string[] = [];
  const calls: RegistrationCall[] = [];
  const handlers: Promise<void>[] = [];
  const closedSockets: Promise<void>[] = [];
  const sockets = new Set<Socket>();
  const probes: Exchange[] = [];
  const flights: Promise<Outcome<Response>>[] = [];
  const registrationFlights: Promise<Outcome<Response>>[] = [];
  const registrationResponses: Response[] = [];
  const registrationId = randomUUID();
  const restores: Array<() => void> = [];
  let config: AgentAcpConfig | undefined;
  let startup: Promise<Outcome<RunningAgentAcpService>> | undefined;
  let ports: Awaited<ReturnType<typeof reservePorts>> | undefined;
  let ownerPort = 0;
  let expectedToken = "";
  let productionWorkloadCloses = 0;
  let didCloseWorkload = false;
  let originalClose: (() => Promise<void>) | undefined;

  const sendProbe = async (
    input: OwnerRegistrationRequest,
    headers: Record<string, string>,
  ): Promise<Reply> => {
    const task = probeExchange(
      ownerPort,
      JSON.stringify({ ...input, challenge: randomBytes(32).toString("hex") }),
      headers,
    );
    probes.push(task);
    const response = value(
      await bounded(task.result, "real startup probe response"),
    );
    await bounded(task.join(), "real startup probe request and socket close");
    return response;
  };
  const server = createServer((request, response) => {
    const finished = Promise.withResolvers<void>();
    const socketClosed = new Promise<void>((resolve) =>
      request.socket.once("close", () => resolve()),
    );
    const responseClosed = new Promise<void>((resolve) =>
      response.once("close", () => resolve()),
    );
    const task = (async () => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/internal/acp-incarnations/register");
      expect(
        request.headers[SERVICE_AUTH_HEADER.toLowerCase()] ===
          `Bearer ${expectedToken}`,
        "startup registration lost its workload credential",
      ).toBe(true);
      for (const name of ["authorization", "cookie", "antnest-caller-context"])
        expect(request.headers[name]).toBeUndefined();
      const input = await readRequest(request);
      const call = { input, socketClosed, finished: finished.promise };
      const callIndex = calls.length;
      calls.push(call);
      if (mode === "receipt-lost-once" || mode === "receipt-always-lost") {
        const original = calls[0]!.input;
        expect(
          input.member_id === original.member_id,
          "registration retry changed its member",
        ).toBe(true);
        expect(
          input.incarnation_id === original.incarnation_id,
          "registration retry changed its incarnation",
        ).toBe(true);
        expect(
          input.registration_nonce === original.registration_nonce,
          "registration retry changed its pending nonce",
        ).toBe(true);
      }
      sequence.push("rc.register");

      for (const [headers, status] of [
        [{}, 401],
        [workloadHeaders("agent-controller"), 403],
      ] as const) {
        const rejected = await sendProbe(input, headers);
        expect(rejected.status).toBe(status);
        expect(rejected.headers["cache-control"]).toBe("no-store");
        expect(
          rejected.body.toString("utf8").includes(input.registration_nonce),
          "probe auth failure disclosed its pending nonce",
        ).toBe(false);
      }
      const challenge = randomBytes(32).toString("hex");
      const probe = probeExchange(
        ownerPort,
        JSON.stringify({ ...input, challenge }),
        workloadHeaders("runtime-controller"),
      );
      probes.push(probe);
      const probed = value(
        await bounded(probe.result, "authenticated early startup probe"),
      );
      await bounded(probe.join(), "authenticated early startup probe close");
      expect(probed.status).toBe(200);
      expect(probed.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(probed.body.toString("utf8")) as Record<
        string,
        unknown
      >;
      expect(Object.keys(body).sort()).toEqual([
        "challenge",
        "incarnation_id",
        "member_id",
        "registration_nonce",
      ]);
      expect(body.member_id === input.member_id).toBe(true);
      expect(body.incarnation_id === input.incarnation_id).toBe(true);
      expect(body.registration_nonce === input.registration_nonce).toBe(true);
      expect(body.challenge === challenge).toBe(true);
      sequence.push("rc.probe");

      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      if (mode === "rejected") {
        response.statusCode = 409;
        verified.resolve({ ok: true, value: call });
        response.end(
          JSON.stringify({
            code: "acp_incarnation_conflict",
            message: "Registration conflict",
            retryable: false,
          }),
        );
      } else {
        const receipt = JSON.stringify({
          registration_id: registrationId,
          member_id: input.member_id,
          incarnation_id: input.incarnation_id,
        });
        response.setHeader("Content-Length", Buffer.byteLength(receipt));
        if (mode === "held-body") {
          response.write(receipt.slice(0, -1));
          verified.resolve({ ok: true, value: call });
          await Promise.race([releaseBody.promise, responseClosed]);
          if (!response.destroyed) response.end(receipt.slice(-1));
        } else if (
          mode === "receipt-always-lost" ||
          (mode === "receipt-lost-once" && callIndex === 0)
        ) {
          // Flush a genuine 200 receipt prefix, then wait until the actual
          // authenticated client is reading it before breaking the TCP stream.
          // The retained registration ID and pending tuple survive this loss.
          await bounded(
            new Promise<void>((resolve, reject) => {
              response.write(receipt.slice(0, -1), (error) =>
                error ? reject(error) : resolve(),
              );
            }),
            "truncated registration receipt prefix write",
          );
          verified.resolve({ ok: true, value: call });
          const flight = registrationFlights[callIndex];
          if (flight === undefined)
            throw new Error("missing original registration HTTP flight");
          const actualResponse = value(
            await bounded(flight, "truncated registration response headers"),
          );
          await vi.waitFor(() => expect(actualResponse.bodyUsed).toBe(true), {
            timeout: guardMs,
            interval: 10,
          });
          sequence.push("rc.receipt_lost");
          response.destroy();
        } else {
          sequence.push("rc.receipt");
          verified.resolve({ ok: true, value: call });
          response.end(receipt);
        }
      }
    })()
      .catch((error: unknown) => {
        failures.push(error);
        verified.resolve({ ok: false, error });
        response.destroy();
      })
      .finally(() => finished.resolve());
    handlers.push(task);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    closedSockets.push(
      new Promise<void>((resolve) => {
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    );
  });
  server.on("error", (error) => failures.push(error));
  const attempt = async (
    label: string,
    action: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await bounded(action(), label, cleanupMs);
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }),
      "startup RC fixture listen",
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing startup RC fixture address");
    ports = await reservePorts();
    ownerPort = ports.owner;
    const environment = testSecurityEnvironment();
    expectedToken = readFileSync(
      join(environment.ANTNEST_SERVICE_AUTH_TOKEN_DIR, "runtime-controller"),
      "utf8",
    );
    config = loadConfig({
      ...environment,
      ANTNEST_ACP_DATABASE_URL: `postgres://startup:synthetic@127.0.0.1:${ports.database}/owner_startup_test`,
      ANTNEST_ACP_DATABASE_TIMEOUT: "500ms",
      ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from(
        "0123456789abcdef0123456789abcdef",
      ).toString("base64"),
      ANTNEST_ACP_LISTEN: `127.0.0.1:${ports.workspace}`,
      ANTNEST_ACP_CONTROL_LISTEN: `127.0.0.1:${ports.control}`,
      ANTNEST_ACP_OWNER_MEMBER_ID: memberId,
      ANTNEST_ACP_OWNER_LISTEN: `127.0.0.1:${ports.owner}`,
      ANTNEST_ACP_RUNTIME_CONTROLLER_URL: `http://127.0.0.1:${address.port}/`,
      ANTNEST_ACP_OWNER_REGISTRATION_TIMEOUT: registrationTimeout,
    });
    const workload = config.authentication.workload;
    const rawClose = workload.close.bind(workload);
    let closePromise: Promise<void> | undefined;
    originalClose = () => (closePromise ??= Promise.resolve().then(rawClose));
    const closeWorkload = originalClose;
    const closeSpy = vi
      .spyOn(workload, "close")
      .mockImplementation(async () => {
        productionWorkloadCloses++;
        await closeWorkload();
        didCloseWorkload = true;
      });
    restores.push(() => closeSpy.mockRestore());
    const fetchFor = workload.fetchFor.bind(workload);
    const fetchSpy = vi
      .spyOn(workload, "fetchFor")
      .mockImplementation((receiver, origin) => {
        const send = fetchFor(receiver, origin);
        return (input, init) => {
          const actual = send(input, init);
          const flight = observe(actual);
          flights.push(flight);
          if (receiver === "runtime-controller") {
            registrationFlights.push(flight);
            void flight.then((outcome) => {
              if (outcome.ok) registrationResponses.push(outcome.value);
              firstRegistrationResponse.resolve(outcome);
            });
          }
          return actual;
        };
      });
    restores.push(() => fetchSpy.mockRestore());
    const workspace = vi.spyOn(AgentAcpHttpServer.prototype, "listen");
    const control = vi.spyOn(AgentAcpHttpServer.prototype, "listenControl");
    restores.push(
      () => workspace.mockRestore(),
      () => control.mockRestore(),
    );
    const ownershipLost = vi.fn();
    const log = vi.fn<TelemetryPort["log"]>();
    const telemetry: TelemetryPort = {
      ...NOOP_TELEMETRY,
      log,
      span(name, _attributes, operation) {
        if (name.startsWith("postgres.")) sequence.push(name);
        return operation();
      },
    };
    // Keep all four ports reserved until configuration is ready. The database
    // port is then genuinely unreachable; no Pool or migration is mocked.
    await bounded(ports.release(), "startup reserved ports release");
    startup = observe(
      startAgentAcpService(config, telemetry, ownershipLost, controller.signal),
    );
    await work({
      config,
      abort: controller,
      startup,
      verified: verified.promise,
      firstRegistrationResponse: firstRegistrationResponse.promise,
      registrationResponses,
      sequence,
      calls,
      socketCount: () => sockets.size,
      workloadCloseCalls: () => productionWorkloadCloses,
      workloadClosed: () => didCloseWorkload,
      expectNoOrdinaryListener() {
        expect(workspace).not.toHaveBeenCalled();
        expect(control).not.toHaveBeenCalled();
        expect(ownershipLost).not.toHaveBeenCalled();
        expect(
          log.mock.calls.some((call) => call[1] === "service_started"),
        ).toBe(false);
      },
    });
  } catch (error) {
    failures.push(error);
  } finally {
    controller.abort(new Error("owner startup fixture cleanup"));
    releaseBody.resolve();
    for (const probe of probes) probe.abort();
    const closing = server.listening
      ? new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        })
      : Promise.resolve();
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await attempt("startup RC fixture close", () => closing);
    const pendingStartup = startup;
    if (pendingStartup !== undefined) {
      await attempt("original startup fixture join", async () => {
        const result = await pendingStartup;
        if (result.ok) await result.value.shutdown();
      });
    }
    await attempt("startup HTTP handlers and sockets join", async () => {
      await Promise.all(handlers);
      await Promise.all(closedSockets);
      await Promise.all(probes.map((probe) => probe.join()));
      await Promise.all(flights);
      expect(sockets.size).toBe(0);
    });
    if (ports !== undefined)
      await attempt("startup reservations cleanup", ports.release);
    if (originalClose !== undefined)
      await attempt("startup workload cleanup", originalClose);
    for (const restore of restores.reverse()) restore();
  }
  if (failures.length !== 0)
    throw new AggregateError(failures, "Owner startup HTTP regression failed");
}

async function expectStopped(
  fixture: StartupFixture,
  call: RegistrationCall,
  expectedCalls = 1,
): Promise<void> {
  await bounded(call.finished, "original RC registration handler finish");
  await bounded(call.socketClosed, "original RC registration socket close");
  expect(fixture.calls).toHaveLength(expectedCalls);
  await bounded(
    Promise.all(fixture.calls.map((registration) => registration.finished)),
    "all original RC registration handlers finish",
  );
  await bounded(
    Promise.all(fixture.calls.map((registration) => registration.socketClosed)),
    "all original RC registration sockets close",
  );
  expect(fixture.socketCount()).toBe(0);
  expect(fixture.workloadCloseCalls()).toBe(1);
  expect(
    fixture.workloadClosed(),
    "startup did not join its actual workload dispatcher close",
  ).toBe(true);
  fixture.expectNoOrdinaryListener();
  const owner = fixture.config.ownerIncarnation;
  if (owner === undefined)
    throw new Error("missing owner startup configuration");
  await connectionRefused(owner.listen.port);
  await connectionRefused(fixture.config.listen.port);
  await connectionRefused(fixture.config.controlListen.port);
}

describe("owner incarnation production startup over real HTTP", () => {
  it("serves the independently authenticated probe before storage and joins cancellation while the RC receipt body is held", async () => {
    await withStartup("held-body", async (fixture) => {
      const call = value(
        await bounded(fixture.verified, "RC registration and early probe"),
      );
      const response = value(
        await bounded(
          fixture.firstRegistrationResponse,
          "actual RC response headers",
        ),
      );
      await vi.waitFor(() => expect(response.bodyUsed).toBe(true), {
        timeout: guardMs,
        interval: 10,
      });
      expect(fixture.sequence).toEqual(["rc.register", "rc.probe"]);
      expect(fixture.workloadCloseCalls()).toBe(0);
      expect(fixture.workloadClosed()).toBe(false);
      fixture.expectNoOrdinaryListener();
      await connectionRefused(fixture.config.listen.port);
      await connectionRefused(fixture.config.controlListen.port);

      fixture.abort.abort(new Error("cancel held owner registration startup"));
      startupFailure(
        await bounded(fixture.startup, "original startup cancellation"),
      );
      // These observations happen before withStartup's forced fallback cleanup.
      expect(response.body?.locked).toBe(false);
      await expectStopped(fixture, call);
      expect(fixture.sequence).toEqual(["rc.register", "rc.probe"]);
    });
  }, 15_000);

  it("expires the shared registration budget while the real RC receipt body is held and joins startup cleanup without caller cancellation", async () => {
    await withStartup(
      "held-body",
      async (fixture) => {
        const call = value(
          await bounded(
            fixture.verified,
            "RC registration and probe before shared budget expiry",
          ),
        );
        const response = value(
          await bounded(
            fixture.firstRegistrationResponse,
            "real RC response headers before shared budget expiry",
          ),
        );
        await vi.waitFor(() => expect(response.bodyUsed).toBe(true), {
          timeout: guardMs,
          interval: 10,
        });
        expect(fixture.abort.signal.aborted).toBe(false);
        expect(fixture.sequence).toEqual(["rc.register", "rc.probe"]);

        const error = startupFailure(
          await bounded(
            fixture.startup,
            "original startup shared registration budget expiry",
            3000,
          ),
        );
        expect(error).toBeInstanceOf(OwnerIncarnationError);
        expect(error).toMatchObject({ code: "deadline_exceeded" });
        expect(fixture.abort.signal.aborted).toBe(false);
        expect(response.body?.locked).toBe(false);
        await expectStopped(fixture, call);
        expect(fixture.sequence).toEqual(["rc.register", "rc.probe"]);
      },
      "1s",
    );
  }, 15_000);

  it("closes the early listener and workload after a rejected registration without touching storage or ordinary listeners", async () => {
    await withStartup("rejected", async (fixture) => {
      const call = value(
        await bounded(
          fixture.verified,
          "rejected RC registration and early probe",
        ),
      );
      const error = startupFailure(
        await bounded(fixture.startup, "rejected registration startup"),
      );
      expect(error).toBeInstanceOf(OwnerIncarnationError);
      expect(error).toMatchObject({ code: "acp_registration_unavailable" });
      expect(fixture.sequence).toEqual(["rc.register", "rc.probe"]);
      await expectStopped(fixture, call);
    });
  }, 15_000);

  it("attempts real storage only after the verified RC receipt and cleans both listener and dispatcher when storage refuses the connection", async () => {
    await withStartup("registered", async (fixture) => {
      const call = value(
        await bounded(
          fixture.verified,
          "successful RC registration and early probe",
        ),
      );
      const error = startupFailure(
        await bounded(fixture.startup, "real unreachable PostgreSQL startup"),
      );
      expect(error).toMatchObject({ code: "ECONNREFUSED" });
      expect(fixture.sequence).toEqual([
        "rc.register",
        "rc.probe",
        "rc.receipt",
        "postgres.migrate",
      ]);
      await expectStopped(fixture, call);
    });
  }, 15_000);

  it("retries a lost receipt with the original pending tuple and original registration before touching real storage", async () => {
    await withStartup("receipt-lost-once", async (fixture) => {
      const first = value(
        await bounded(
          fixture.verified,
          "first RC registration before its receipt is lost",
        ),
      );
      const error = startupFailure(
        await bounded(
          fixture.startup,
          "same-tuple registration retry and real PostgreSQL refusal",
          6000,
        ),
      );
      expect(error).toMatchObject({ code: "ECONNREFUSED" });
      expect(fixture.calls).toHaveLength(2);
      for (const call of fixture.calls) {
        expect(call.input.member_id === first.input.member_id).toBe(true);
        expect(call.input.incarnation_id === first.input.incarnation_id).toBe(
          true,
        );
        expect(
          call.input.registration_nonce === first.input.registration_nonce,
        ).toBe(true);
      }
      expect(fixture.sequence).toEqual([
        "rc.register",
        "rc.probe",
        "rc.receipt_lost",
        "rc.register",
        "rc.probe",
        "rc.receipt",
        "postgres.migrate",
      ]);
      expect(fixture.registrationResponses).toHaveLength(2);
      expect(
        fixture.registrationResponses.every(
          (response) => response.bodyUsed && response.body?.locked === false,
        ),
      ).toBe(true);
      await expectStopped(fixture, first, 2);
    });
  }, 15_000);

  it("stops after three lost receipts for the same tuple and joins every request without storage or ordinary listeners", async () => {
    await withStartup("receipt-always-lost", async (fixture) => {
      const first = value(
        await bounded(
          fixture.verified,
          "first RC registration before repeated receipt loss",
        ),
      );
      const error = startupFailure(
        await bounded(
          fixture.startup,
          "three bounded same-tuple registration attempts",
          6000,
        ),
      );
      expect(error).toBeInstanceOf(OwnerIncarnationError);
      expect(error).toMatchObject({ code: "acp_registration_unavailable" });
      expect(fixture.calls).toHaveLength(3);
      for (const call of fixture.calls) {
        expect(call.input.member_id === first.input.member_id).toBe(true);
        expect(call.input.incarnation_id === first.input.incarnation_id).toBe(
          true,
        );
        expect(
          call.input.registration_nonce === first.input.registration_nonce,
        ).toBe(true);
      }
      expect(fixture.sequence).toEqual([
        "rc.register",
        "rc.probe",
        "rc.receipt_lost",
        "rc.register",
        "rc.probe",
        "rc.receipt_lost",
        "rc.register",
        "rc.probe",
        "rc.receipt_lost",
      ]);
      expect(fixture.registrationResponses).toHaveLength(3);
      expect(
        fixture.registrationResponses.every(
          (response) => response.bodyUsed && response.body?.locked === false,
        ),
      ).toBe(true);
      await expectStopped(fixture, first, 3);
    });
  }, 15_000);

  it("withdraws the pending probe intent on startup cancellation before the original registration Promise has joined", async () => {
    const releaseRegistration = Promise.withResolvers<void>();
    const actualRegistrationSettled = Promise.withResolvers<void>();
    // The wrapper invokes this original method with its actual observed instance.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalRegister = RuntimeControllerIncarnations.prototype.register;
    const register = vi
      .spyOn(RuntimeControllerIncarnations.prototype, "register")
      .mockImplementation(async function (
        this: RuntimeControllerIncarnations,
        input,
        signal,
      ) {
        try {
          return await originalRegister.call(this, input, signal);
        } finally {
          actualRegistrationSettled.resolve();
          await releaseRegistration.promise;
        }
      });
    try {
      await withStartup("held-body", async (fixture) => {
        const probes: Exchange[] = [];
        try {
          const call = value(
            await bounded(
              fixture.verified,
              "held registration before startup cancellation",
            ),
          );
          const response = value(
            await bounded(
              fixture.firstRegistrationResponse,
              "held registration response headers",
            ),
          );
          await vi.waitFor(() => expect(response.bodyUsed).toBe(true), {
            timeout: guardMs,
            interval: 10,
          });
          let startupSettled = false;
          const originalStartup = fixture.startup.then((outcome) => {
            startupSettled = true;
            return outcome;
          });

          fixture.abort.abort(
            new Error("withdraw pending owner intent before registration join"),
          );
          await bounded(
            call.socketClosed,
            "cancelled original registration TCP socket close",
          );
          await bounded(
            actualRegistrationSettled.promise,
            "actual registration request cancellation and body join",
          );
          expect(startupSettled).toBe(false);
          expect(response.body?.locked).toBe(false);
          expect(fixture.sequence).toEqual(["rc.register", "rc.probe"]);
          fixture.expectNoOrdinaryListener();

          const owner = fixture.config.ownerIncarnation;
          if (owner === undefined)
            throw new Error("missing owner cancellation probe listener");
          const probe = probeExchange(
            owner.listen.port,
            JSON.stringify({
              ...call.input,
              challenge: randomBytes(32).toString("hex"),
            }),
            workloadHeaders("runtime-controller"),
          );
          probes.push(probe);
          const rejected = value(
            await bounded(
              probe.result,
              "probe after outer startup cancellation before registration join",
            ),
          );
          await bounded(
            probe.join(),
            "cancelled-intent probe request and socket close",
          );
          expect(rejected.status).toBe(409);
          expect(rejected.headers["cache-control"]).toBe("no-store");
          const body = JSON.parse(rejected.body.toString("utf8")) as Record<
            string,
            unknown
          >;
          expect(Object.keys(body).sort()).toEqual([
            "code",
            "message",
            "retryable",
          ]);
          expect(body.code).toBe("acp_probe_intent_mismatch");
          expect(body.retryable).toBe(false);
          expect(
            rejected.body
              .toString("utf8")
              .includes(call.input.registration_nonce),
          ).toBe(false);
          expect(startupSettled).toBe(false);
          expect(fixture.sequence).toEqual(["rc.register", "rc.probe"]);

          releaseRegistration.resolve();
          startupFailure(
            await bounded(
              originalStartup,
              "original startup after registration cleanup gate release",
            ),
          );
          expect(register).toHaveBeenCalledOnce();
          await expectStopped(fixture, call);
        } finally {
          releaseRegistration.resolve();
          for (const probe of probes) probe.abort();
          await bounded(
            Promise.all(probes.map((probe) => probe.join())),
            "cancelled-intent probe fixture cleanup",
            cleanupMs,
          );
        }
      });
    } finally {
      releaseRegistration.resolve();
      register.mockRestore();
    }
  }, 15_000);
});
