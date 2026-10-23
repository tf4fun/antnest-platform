import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { RuntimeControllerIncarnations } from "../../../../services/agent-acp-service/src/adapters/runtime-controller-incarnations.js";
import { ServiceAuthentication } from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import {
  OwnerIncarnationError,
  type OwnerRegistration,
  type OwnerRegistrationRequest,
} from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";

const request: OwnerRegistrationRequest = {
  member_id: "acp-a",
  incarnation_id: "12345678-1234-4abc-8abc-1234567890ab",
  registration_nonce: "e".repeat(64),
};
const registration: OwnerRegistration = {
  registration_id: "cafe1234-cafe-4abc-8abc-1234567890ab",
  member_id: request.member_id,
  incarnation_id: request.incarnation_id,
};
const validReply = JSON.stringify(registration);
const token = Buffer.alloc(32, 7).toString("base64url");
const privateCause = "PRIVATE_REGISTRATION_PEER_CAUSE";

describe("Runtime Controller incarnation registration over real HTTP", () => {
  it("sends the original closed tuple once with only workload authority", async () => {
    await withRegistrationPeer(
      ({ response }) => {
        response.end(validReply);
      },
      async (peer) => {
        const input = structuredClone(request);
        const original = structuredClone(input);
        const pending = peer.start(input);
        expectRegistration(await deadline(pending.promise), registration);
        expect(
          isDeepStrictEqual(input, original),
          "registration mutated its original tuple",
        ).toBe(true);
        expect(peer.calls).toHaveLength(1);
        const call = peer.calls[0];
        if (!call) throw new Error("missing real registration request");
        expect(call.method).toBe("POST");
        expect(call.path).toBe("/internal/acp-incarnations/register");
        expect(
          isDeepStrictEqual(call.body, request),
          "registration changed its exact three-field body",
        ).toBe(true);
        expect(call.headers["content-type"]).toBe("application/json");
        expect(call.headers["cache-control"]).toBe("no-store");
        expect(
          call.headers["antnest-service-authorization"] === `Bearer ${token}`,
          "registration lost its exact workload credential",
        ).toBe(true);
        for (const header of [
          "authorization",
          "cookie",
          "antnest-caller-context",
        ])
          expect(
            call.headers[header],
            "registration forwarded user authority",
          ).toBeUndefined();
        expect(
          Object.keys(call.headers).some((name) =>
            name.startsWith("x-antnest-"),
          ),
          "registration forwarded a user hint",
        ).toBe(false);
        await deadline(call.finished);
        expect(peer.authentication.flights).toHaveLength(1);
      },
    );
  });

  const invalidReplies: Array<{ name: string; body: string; media?: string }> =
    [
      { name: "null", body: "null" },
      { name: "array", body: "[]" },
      {
        name: "missing registration",
        body: JSON.stringify({
          member_id: request.member_id,
          incarnation_id: request.incarnation_id,
        }),
      },
      {
        name: "missing member",
        body: JSON.stringify({
          registration_id: registration.registration_id,
          incarnation_id: request.incarnation_id,
        }),
      },
      {
        name: "missing incarnation",
        body: JSON.stringify({
          registration_id: registration.registration_id,
          member_id: request.member_id,
        }),
      },
      {
        name: "different member",
        body: JSON.stringify({ ...registration, member_id: "acp-other" }),
      },
      {
        name: "different incarnation",
        body: JSON.stringify({
          ...registration,
          incarnation_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }),
      },
      {
        name: "uppercase UUID",
        body: JSON.stringify({
          ...registration,
          registration_id: registration.registration_id.toUpperCase(),
        }),
      },
      {
        name: "non-v4 UUID",
        body: JSON.stringify({
          ...registration,
          registration_id: registration.registration_id.replace(
            "-4abc-",
            "-1abc-",
          ),
        }),
      },
      {
        name: "unknown field",
        body: JSON.stringify({ ...registration, private: privateCause }),
      },
      {
        name: "duplicate member",
        body: validReply.replace(
          '"member_id":',
          '"member_id":"acp-other","member_id":',
        ),
      },
      {
        name: "decoded duplicate member",
        body: validReply.replace(
          '"member_id":',
          String.raw`"\u006dember_id":"acp-other","member_id":`,
        ),
      },
      {
        name: "case alias",
        body: validReply.replace('"member_id":', '"Member_id":'),
      },
      {
        name: "wrong type",
        body: JSON.stringify({ ...registration, registration_id: 7 }),
      },
      { name: "second document", body: validReply + " {}" },
      { name: "malformed JSON", body: '{"registration_id":' },
      { name: "wrong media", body: validReply, media: "text/plain" },
    ];
  it.each(invalidReplies)(
    "rejects $name without treating it as a receipt or retrying",
    async ({ body, media }) => {
      await withRegistrationPeer(
        ({ response }) => {
          if (media !== undefined) response.setHeader("Content-Type", media);
          response.end(body);
        },
        async (peer) => {
          const pending = peer.start();
          expectFailure(
            await deadline(pending.promise),
            "acp_registration_unavailable",
            peer.origin,
          );
          expect(peer.calls).toHaveLength(1);
          expect(peer.authentication.flights).toHaveLength(1);
          expectBodiesJoined(peer.authentication);
        },
      );
    },
  );

  it.each([
    201, 204, 400, 401, 403, 404, 405, 408, 409, 413, 415, 429, 500, 503,
  ])(
    "rejects HTTP %i with a fixed private failure and no automatic retry",
    async (status) => {
      await withRegistrationPeer(
        ({ response }) => {
          response.statusCode = status;
          response.end(
            JSON.stringify({
              code: privateCause,
              message: request.registration_nonce,
              credential: token,
            }),
          );
        },
        async (peer) => {
          const outcome = await deadline(peer.start().promise);
          expectFailure(outcome, "acp_registration_unavailable", peer.origin);
          if (outcome.ok) throw new Error("unexpected registration receipt");
          expect(outcome.error).toMatchObject({
            retryable: !(
              status >= 400 &&
              status < 500 &&
              status !== 408 &&
              status !== 429
            ),
          });
          expect(peer.calls).toHaveLength(1);
          expect(peer.authentication.flights).toHaveLength(1);
          expectBodiesJoined(peer.authentication);
        },
      );
    },
  );

  it("leaves an unknown delivery for the caller to retry with the same original tuple", async () => {
    let accepted: OwnerRegistration | undefined;
    await withRegistrationPeer(
      ({ response, index }) => {
        if (index === 0) {
          accepted = structuredClone(registration);
          response.setHeader(
            "Content-Length",
            String(Buffer.byteLength(validReply) + 32),
          );
          response.end(validReply);
          return;
        }
        if (accepted === undefined)
          throw new Error("missing accepted registration fixture");
        response.end(JSON.stringify(accepted));
      },
      async (peer) => {
        const original = structuredClone(request);
        expectFailure(
          await deadline(peer.start(original).promise),
          "acp_registration_unavailable",
          peer.origin,
        );
        expect(peer.calls).toHaveLength(1);
        const first = peer.calls[0];
        if (first === undefined)
          throw new Error("missing truncated real HTTP request");
        await deadline(first.socketClosed);
        await deadline(first.finished);
        expectBodiesJoined(peer.authentication);
        expectRegistration(
          await deadline(peer.start(original).promise),
          registration,
        );
        expect(peer.calls).toHaveLength(2);
        expect(
          peer.calls.every((call) => isDeepStrictEqual(call.body, request)),
          "caller retry changed the original nonce or process tuple",
        ).toBe(true);
        expect(
          isDeepStrictEqual(original, request),
          "unknown outcome changed the caller input",
        ).toBe(true);
        expect(peer.authentication.flights).toHaveLength(2);
      },
    );
  });

  it("does not follow a cross-origin redirect or disclose its origin in errors", async () => {
    await withRegistrationPeer(
      ({ response }) => {
        response.end(validReply);
      },
      async (target) => {
        await withRegistrationPeer(
          ({ response }) => {
            response.writeHead(307, {
              Location: `${target.origin}/private-redirect`,
            });
            response.end();
          },
          async (source) => {
            expectFailure(
              await deadline(source.start().promise),
              "acp_registration_unavailable",
              source.origin,
              target.origin,
            );
            expect(source.calls).toHaveLength(1);
            expect(source.authentication.flights).toHaveLength(1);
            expect(target.calls).toHaveLength(0);
          },
        );
      },
    );
  });

  it("accepts an exact eight-KiB complete response", async () => {
    await withRegistrationPeer(
      ({ response }) => {
        response.end(
          validReply + " ".repeat(8192 - Buffer.byteLength(validReply)),
        );
      },
      async (peer) => {
        expectRegistration(await deadline(peer.start().promise), registration);
        expect(peer.calls).toHaveLength(1);
        expectBodiesJoined(peer.authentication);
      },
    );
  });

  it.each([false, true])(
    "cancels and joins an oversized unfinished response, declared=%s",
    async (declared) => {
      await withRegistrationPeer(
        async (call) => {
          if (declared) call.response.setHeader("Content-Length", "8293");
          call.response.write(
            validReply + " ".repeat(8193 - Buffer.byteLength(validReply)),
          );
          call.response.flushHeaders();
          await call.socketClosed;
        },
        async (peer) => {
          const pending = peer.start();
          const call = await deadline(peer.firstCall);
          expectFailure(
            await deadline(pending.promise),
            "acp_registration_unavailable",
            peer.origin,
          );
          await deadline(call.socketClosed);
          await deadline(call.finished);
          expect(peer.socketCount()).toBe(0);
          expectBodiesJoined(peer.authentication);
          expect(peer.calls).toHaveLength(1);
        },
      );
    },
  );

  it("preserves an independent joined body cleanup failure ahead of parent cancellation", async () => {
    await withRegistrationPeer(
      async (call) => {
        call.response.write('{"registration_id":');
        call.response.flushHeaders();
        await call.socketClosed;
      },
      async (peer) => {
        const controller = new AbortController();
        const cancelled = Promise.withResolvers<void>();
        const releaseCleanup = Promise.withResolvers<void>();
        const cleanupExited = Promise.withResolvers<void>();
        const cleanupError = new Error(
          `${privateCause}:${token}:${peer.origin}`,
        );
        const restores: Array<() => void> = [];
        let bodyOutcome: Outcome<void> | undefined;
        let cancelOutcome: Outcome<void> | undefined;
        const cancellation = { started: false };
        peer.authentication.beforeResponseRead = (response) => {
          const body = response.body;
          if (body === null)
            throw new Error("missing actual held response body");
          const getReader = body.getReader.bind(body);
          const descriptor = Object.getOwnPropertyDescriptor(body, "getReader");
          restores.push(() => {
            if (descriptor === undefined)
              Reflect.deleteProperty(body, "getReader");
            else Object.defineProperty(body, "getReader", descriptor);
          });
          Object.defineProperty(body, "getReader", {
            configurable: true,
            value: () => {
              const reader = getReader();
              const originalClosed = reader.closed.then<
                Outcome<void>,
                Outcome<void>
              >(
                () => ({ ok: true, value: undefined }),
                (error: unknown) => ({ ok: false, error }),
              );
              const cancel = reader.cancel.bind(reader);
              const cancelDescriptor = Object.getOwnPropertyDescriptor(
                reader,
                "cancel",
              );
              restores.push(() => {
                if (cancelDescriptor === undefined)
                  Reflect.deleteProperty(reader, "cancel");
                else Object.defineProperty(reader, "cancel", cancelDescriptor);
              });
              Object.defineProperty(reader, "cancel", {
                configurable: true,
                value: async (reason?: unknown): Promise<void> => {
                  cancellation.started = true;
                  try {
                    // Let the real fetch abort error its stream, then join the
                    // original cancel before injecting a distinct cleanup error.
                    bodyOutcome = await originalClosed;
                    cancelOutcome = await cancel(reason).then<
                      Outcome<void>,
                      Outcome<void>
                    >(
                      () => ({ ok: true, value: undefined }),
                      (error: unknown) => ({ ok: false, error }),
                    );
                    cancelled.resolve();
                    await releaseCleanup.promise;
                    throw cleanupError;
                  } finally {
                    cleanupExited.resolve();
                  }
                },
              });
              return reader;
            },
          });
        };
        const pending = peer.start(request, controller.signal);
        try {
          const call = await deadline(peer.firstCall);
          const response = await originalResponse(peer.authentication);
          expect(response.body?.locked).toBe(true);
          controller.abort(
            new DOMException("cancel held registration", "AbortError"),
          );
          await deadline(cancelled.promise);
          await deadline(call.socketClosed);
          await deadline(call.finished);
          expect(bodyOutcome?.ok).toBe(false);
          expect(cancelOutcome?.ok).toBe(false);
          if (
            bodyOutcome === undefined ||
            bodyOutcome.ok ||
            cancelOutcome === undefined ||
            cancelOutcome.ok
          )
            throw new Error(
              "actual fetch abort and original cancel errors were not observed",
            );
          expect(
            bodyOutcome.error instanceof Error &&
              bodyOutcome.error.name === "AbortError",
          ).toBe(true);
          expect(cancelOutcome.error === bodyOutcome.error).toBe(true);
          expect(cleanupError === bodyOutcome.error).toBe(false);
          expect(
            pending.settled,
            "register returned before its original cleanup joined",
          ).toBe(false);
          expect(response.body?.locked).toBe(true);
          releaseCleanup.resolve();
          const outcome = await deadline(pending.promise);
          await deadline(cleanupExited.promise);
          expect(pending.settled).toBe(true);
          expect(peer.socketCount()).toBe(0);
          expectBodiesJoined(peer.authentication);
          expect(peer.calls).toHaveLength(1);
          expect(peer.authentication.flights).toHaveLength(1);
          expectFailure(
            outcome,
            "acp_registration_unavailable",
            peer.origin,
            cleanupError.message,
          );
          if (outcome.ok)
            throw new Error("cleanup failure became a registration receipt");
          expect(outcome.error).toMatchObject({
            code: "acp_registration_unavailable",
            retryable: false,
            cleanupFailed: true,
          });
        } finally {
          controller.abort(
            new DOMException("registration fixture cleanup", "AbortError"),
          );
          releaseCleanup.resolve();
          await pending.promise;
          if (cancellation.started) await cleanupExited.promise;
          peer.authentication.beforeResponseRead = undefined;
          for (const restore of restores.reverse()) restore();
        }
      },
    );
  });

  it("preserves a definite HTTP rejection when joined body cleanup outlasts the attempt deadline", async () => {
    await withRegistrationPeer(
      ({ response }) => {
        response.statusCode = 403;
        response.end(
          JSON.stringify({
            code: "acp_member_not_allowed",
            message: privateCause,
            retryable: false,
          }),
        );
      },
      async (peer) => {
        const controller = new AbortController();
        const cancelled = Promise.withResolvers<void>();
        const releaseCleanup = Promise.withResolvers<void>();
        const cleanupExited = Promise.withResolvers<void>();
        const restores: Array<() => void> = [];
        const cancellation = { started: false };
        let cancelOutcome: Outcome<void> | undefined;
        let bodyOutcome: Outcome<void> | undefined;
        let elapsedTimer: ReturnType<typeof setTimeout> | undefined;
        peer.authentication.beforeResponseRead = (response) => {
          const body = response.body;
          if (body === null)
            throw new Error("missing actual rejected response body");
          const getReader = body.getReader.bind(body);
          const descriptor = Object.getOwnPropertyDescriptor(body, "getReader");
          restores.push(() => {
            if (descriptor === undefined)
              Reflect.deleteProperty(body, "getReader");
            else Object.defineProperty(body, "getReader", descriptor);
          });
          Object.defineProperty(body, "getReader", {
            configurable: true,
            value: () => {
              const reader = getReader();
              const originalClosed = reader.closed.then<
                Outcome<void>,
                Outcome<void>
              >(
                () => ({ ok: true, value: undefined }),
                (error: unknown) => ({ ok: false, error }),
              );
              const cancel = reader.cancel.bind(reader);
              const cancelDescriptor = Object.getOwnPropertyDescriptor(
                reader,
                "cancel",
              );
              restores.push(() => {
                if (cancelDescriptor === undefined)
                  Reflect.deleteProperty(reader, "cancel");
                else Object.defineProperty(reader, "cancel", cancelDescriptor);
              });
              Object.defineProperty(reader, "cancel", {
                configurable: true,
                value: async (reason?: unknown): Promise<void> => {
                  cancellation.started = true;
                  try {
                    cancelOutcome = await cancel(reason).then<
                      Outcome<void>,
                      Outcome<void>
                    >(
                      () => ({ ok: true, value: undefined }),
                      (error: unknown) => ({ ok: false, error }),
                    );
                    bodyOutcome = await originalClosed;
                    cancelled.resolve();
                    // The real cancel is already joined. Hold only this
                    // cleanup receipt, then complete without a new error.
                    await releaseCleanup.promise;
                  } finally {
                    cleanupExited.resolve();
                  }
                },
              });
              return reader;
            },
          });
        };
        const pending = peer.start(request, controller.signal);
        try {
          const call = await deadline(peer.firstCall);
          const response = await originalResponse(peer.authentication);
          expect(response.status).toBe(403);
          await deadline(cancelled.promise);
          await deadline(call.socketClosed);
          await deadline(call.finished);
          if (cancelOutcome === undefined)
            throw new Error("original response cancel was not joined");
          if (!cancelOutcome.ok) {
            if (bodyOutcome === undefined || bodyOutcome.ok)
              throw new Error(
                "original cancel failed independently of the closed stream",
              );
            expect(cancelOutcome.error === bodyOutcome.error).toBe(true);
          }
          // The configured attempt timer was installed before the HTTP call.
          // A later real 200ms timer keeps cleanup held past its 100ms deadline.
          await deadline(
            new Promise<void>((resolve) => {
              elapsedTimer = setTimeout(resolve, 200);
            }),
          );
          expect(controller.signal.aborted).toBe(false);
          expect(
            pending.settled,
            "register returned before its cleanup receipt joined",
          ).toBe(false);
          expect(response.body?.locked).toBe(true);
          releaseCleanup.resolve();
          const outcome = await deadline(pending.promise);
          await deadline(cleanupExited.promise);
          expect(pending.settled).toBe(true);
          expect(controller.signal.aborted).toBe(false);
          expect(peer.socketCount()).toBe(0);
          expectBodiesJoined(peer.authentication);
          expect(peer.calls).toHaveLength(1);
          expect(peer.authentication.flights).toHaveLength(1);
          expectFailure(outcome, "acp_registration_unavailable", peer.origin);
          if (outcome.ok)
            throw new Error("HTTP rejection became a registration receipt");
          expect(outcome.error).toMatchObject({
            code: "acp_registration_unavailable",
            retryable: false,
          });
          expect([false, undefined]).toContain(
            (outcome.error as { cleanupFailed?: boolean }).cleanupFailed,
          );
        } finally {
          clearTimeout(elapsedTimer);
          controller.abort(
            new DOMException("registration fixture cleanup", "AbortError"),
          );
          releaseCleanup.resolve();
          await pending.promise;
          if (cancellation.started) await cleanupExited.promise;
          peer.authentication.beforeResponseRead = undefined;
          for (const restore of restores.reverse()) restore();
        }
      },
      100,
    );
  });

  for (const stage of ["headers", "partial-body"] as const) {
    it(`joins an actual ${stage} request after parent cancellation`, async () => {
      await withRegistrationPeer(
        async (call) => {
          if (stage === "partial-body") {
            call.response.write('{"registration_id":');
            call.response.flushHeaders();
          }
          await call.socketClosed;
        },
        async (peer) => {
          const controller = new AbortController();
          const pending = peer.start(request, controller.signal);
          const call = await deadline(peer.firstCall);
          if (stage === "partial-body") {
            const response = await originalResponse(peer.authentication);
            expect(
              response.body?.locked,
              "original response body read did not start",
            ).toBe(true);
          }
          controller.abort(
            new Error(`${privateCause}:${request.registration_nonce}`),
          );
          expectFailure(
            await deadline(pending.promise),
            "deadline_exceeded",
            peer.origin,
          );
          await deadline(call.socketClosed);
          await deadline(call.finished);
          expect(pending.settled).toBe(true);
          expect(peer.socketCount()).toBe(0);
          expectBodiesJoined(peer.authentication);
          expect(peer.calls).toHaveLength(1);
        },
      );
    });

    it(`bounds actual ${stage} work with the shortened total deadline`, async () => {
      await withRegistrationPeer(
        async (call) => {
          if (stage === "partial-body") {
            call.response.write('{"registration_id":');
            call.response.flushHeaders();
          }
          await call.socketClosed;
        },
        async (peer) => {
          const pending = peer.start();
          const call = await deadline(peer.firstCall);
          expectFailure(
            await deadline(pending.promise),
            "deadline_exceeded",
            peer.origin,
          );
          await deadline(call.socketClosed);
          await deadline(call.finished);
          expect(peer.socketCount()).toBe(0);
          expectBodiesJoined(peer.authentication);
          expect(peer.calls).toHaveLength(1);
        },
        200,
      );
    });
  }
});

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Pending = {
  promise: Promise<Outcome<OwnerRegistration>>;
  settled: boolean;
};
type PeerCall = {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
  response: ServerResponse;
  index: number;
  socketClosed: Promise<void>;
  finished: Promise<void>;
};
type Peer = {
  origin: string;
  calls: PeerCall[];
  authentication: RegistrationAuthentication;
  firstCall: Promise<PeerCall>;
  start(input?: OwnerRegistrationRequest, signal?: AbortSignal): Pending;
  socketCount(): number;
};

// Observe the real authenticated fetch without replacing its Promise, Response,
// body, dispatch, credentials or error. Header receipts let the body case prove
// it has passed the distinct waiting-for-headers stage before cancelling.
class RegistrationAuthentication extends ServiceAuthentication {
  public readonly flights: Array<Promise<Outcome<Response>>> = [];
  public readonly responses: Response[] = [];
  public beforeResponseRead: ((response: Response) => void) | undefined;

  public override fetchFor(receiver: string, origin: string): typeof fetch {
    const send = super.fetchFor(receiver, origin);
    return (input, init) => {
      const actual = send(input, init);
      const observed = actual.then<Outcome<Response>, Outcome<Response>>(
        (response) => {
          this.responses.push(response);
          this.beforeResponseRead?.(response);
          return { ok: true, value: response };
        },
        (error: unknown) => ({ ok: false, error }),
      );
      this.flights.push(observed);
      return actual;
    };
  }
}

async function withRegistrationPeer(
  respond: (call: PeerCall) => void | Promise<void>,
  work: (peer: Peer) => Promise<void>,
  timeoutMs?: number,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "antnest-owner-registration-"));
  const callersPath = join(directory, "callers.json");
  const failures: unknown[] = [];
  const pending: Pending[] = [];
  const controllers: AbortController[] = [];
  const handlers: Promise<void>[] = [];
  const closedSockets: Promise<void>[] = [];
  const sockets = new Set<Socket>();
  const calls: PeerCall[] = [];
  const firstCall = Promise.withResolvers<PeerCall>();
  let authentication: RegistrationAuthentication | undefined;
  let listening = false;
  const server = createServer((incoming, response) => {
    const finished = Promise.withResolvers<void>();
    const socketClosed = new Promise<void>((resolve) =>
      incoming.socket.once("close", () => resolve()),
    );
    const task = (async () => {
      try {
        const body = await readRequest(incoming);
        const call: PeerCall = {
          method: incoming.method,
          path: incoming.url,
          headers: { ...incoming.headers },
          body,
          response,
          index: calls.length,
          socketClosed,
          finished: finished.promise,
        };
        calls.push(call);
        firstCall.resolve(call);
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Connection", "close");
        await respond(call);
      } finally {
        finished.resolve();
      }
    })().catch(() => {
      failures.push(new Error("registration HTTP fixture handler failed"));
      response.destroy();
    });
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
  try {
    writeFileSync(callersPath, "{}", { mode: 0o600 });
    writeFileSync(join(directory, "runtime-controller"), token, {
      mode: 0o600,
    });
    authentication = new RegistrationAuthentication({
      ANTNEST_SERVICE_AUTH_MODE: "token",
      ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "true",
      ANTNEST_SERVICE_AUTH_CALLERS_FILE: callersPath,
      ANTNEST_SERVICE_AUTH_TOKEN_DIR: directory,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    listening = true;
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing registration HTTP fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = new RuntimeControllerIncarnations({
      origin,
      authentication,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    await work({
      origin,
      authentication,
      calls,
      firstCall: firstCall.promise,
      socketCount: () => sockets.size,
      start(input = request, signal) {
        const controller = new AbortController();
        controllers.push(controller);
        const actual = client.register(
          input,
          signal === undefined
            ? controller.signal
            : AbortSignal.any([signal, controller.signal]),
        );
        const operation: Pending = {
          settled: false,
          promise: actual.then<
            Outcome<OwnerRegistration>,
            Outcome<OwnerRegistration>
          >(
            (value) => {
              operation.settled = true;
              return { ok: true, value };
            },
            (error: unknown) => {
              operation.settled = true;
              return { ok: false, error };
            },
          ),
        };
        pending.push(operation);
        return operation;
      },
    });
  } catch (error: unknown) {
    failures.push(error);
  } finally {
    for (const controller of controllers)
      controller.abort(new Error("registration fixture cleanup"));
    // This forced cleanup occurs after all behavioral observations; none of the
    // socket/body assertions above can be satisfied by this fallback closure.
    const closing = listening
      ? new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      : Promise.resolve();
    const closed = closing.then<Outcome<void>, Outcome<void>>(
      () => ({ ok: true, value: undefined }),
      (error: unknown) => ({ ok: false, error }),
    );
    server.closeAllConnections();
    try {
      await Promise.all(pending.map((operation) => operation.promise));
      const result = await closed;
      if (!result.ok) failures.push(result.error);
      await Promise.all(handlers);
      await Promise.all(closedSockets);
    } catch (error: unknown) {
      failures.push(error);
    }
    if (authentication !== undefined) {
      try {
        await Promise.all(authentication.flights);
        await authentication.close();
        expectBodiesJoined(authentication);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    try {
      expect(sockets.size, "registration fixture retained a real socket").toBe(
        0,
      );
      expect(
        pending.every((operation) => operation.settled),
        "registration fixture did not join its original calls",
      ).toBe(true);
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length === 1 && failures[0] instanceof Error) throw failures[0];
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "registration business and cleanup failures",
    );
}

async function readRequest(incoming: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > 4096)
      throw new Error("registration request exceeded the fixture wire bound");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function expectRegistration(
  outcome: Outcome<OwnerRegistration>,
  expected: OwnerRegistration,
): void {
  expect(outcome.ok, "registration did not return an accepted receipt").toBe(
    true,
  );
  if (!outcome.ok) throw new Error("registration unexpectedly failed");
  expect(
    isDeepStrictEqual(outcome.value, expected),
    "registration returned a changed or non-closed receipt",
  ).toBe(true);
}

function expectFailure(
  outcome: Outcome<OwnerRegistration>,
  code: "acp_registration_unavailable" | "deadline_exceeded",
  ...origins: string[]
): void {
  expect(outcome.ok, "registration failure became a successful receipt").toBe(
    false,
  );
  if (outcome.ok) throw new Error("registration unexpectedly succeeded");
  expect(
    outcome.error instanceof OwnerIncarnationError,
    "registration lost its fixed error type",
  ).toBe(true);
  if (!(outcome.error instanceof OwnerIncarnationError))
    throw new Error("registration returned an untyped error");
  expect(outcome.error.code).toBe(code);
  expect(
    outcome.error.cause,
    "registration retained a raw dependency cause",
  ).toBeUndefined();
  const rendered = inspect(outcome.error, { depth: 8 });
  expect(
    [request.registration_nonce, token, privateCause, ...origins].every(
      (secret) => !rendered.includes(secret),
    ),
    "registration error disclosed private material",
  ).toBe(true);
}

function expectBodiesJoined(authentication: RegistrationAuthentication): void {
  expect(
    authentication.responses.every(
      (response) => response.body === null || !response.body.locked,
    ),
    "registration returned with an original body task still locked",
  ).toBe(true);
}

async function originalResponse(
  authentication: RegistrationAuthentication,
): Promise<Response> {
  const flight = authentication.flights[0];
  if (flight === undefined)
    throw new Error("missing actual authenticated fetch");
  const result = await deadline(flight);
  if (!result.ok)
    throw new Error("authenticated fetch failed before its response body");
  return result.value;
}

// This watchdog only reports a failed observation. Fixture finally blocks still
// abort, release real sockets and await every original request and handler.
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("registration HTTP observation timed out")),
        3000,
      );
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
