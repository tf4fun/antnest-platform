import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
  parseOwnerRegistration,
  type OwnerRegistration,
} from "../application/owner-incarnation.js";
import {
  parsePeerIdentityRequest,
  parsePeerPublicationRequest,
  peerDeadline,
} from "../application/peer-request.js";
import { parsePeerPublicationReceipt } from "../domain/peer-receipt.js";
import { DomainError } from "../domain/errors.js";
import type { PeerPublicationRequest } from "../ports/agent-peers.js";
import { PeerDeadlineError } from "../ports/agent-peers.js";
import type { PeerAuthentication } from "../adapters/peer-authentication.js";
import { fields } from "../adapters/service-authentication.js";
import { OWNER_HTTP_PATH } from "./owner-http.js";
import { OWNER_CONTROL_PATHS } from "./owner-control.js";
import { strictObject } from "../adapters/strict-json.js";
import { WebSocketServer, type WebSocket } from "ws";
import type { Duplex } from "node:stream";
import {
  OWNER_FORWARD_HEADER,
  OWNER_FORWARD_PATH,
  parseOwnerForward,
  type OwnerForwardRequest,
} from "../application/owner-forwarding.js";

const identityPath = "/internal/acp-peer/identity";
const publicationPath = "/internal/acp-peer/publications/apply";
const requestBytes = 16384;
const responseBytes = 16777216;
const defaultTimeoutMs = 10000;
const configurationError = "Peer listener configuration is invalid";

const failures = {
  service_unauthenticated: { status: 401, retryable: false },
  caller_not_allowed: { status: 403, retryable: false },
  invalid_request: { status: 400, retryable: false },
  unsupported_media_type: { status: 415, retryable: false },
  request_too_large: { status: 413, retryable: false },
  acp_peer_membership_conflict: { status: 409, retryable: false },
  acp_peer_incarnation_mismatch: { status: 409, retryable: false },
  acp_peer_hop_rejected: { status: 409, retryable: false },
  configuration_unavailable: { status: 503, retryable: true },
  deadline_exceeded: { status: 504, retryable: true },
  internal_error: { status: 500, retryable: true },
  route_not_found: { status: 404, retryable: false },
  method_not_allowed: { status: 405, retryable: false },
} as const;
type FailureCode = keyof typeof failures;

class PeerFailure extends Error {
  public constructor(public readonly code: FailureCode) {
    super(code);
  }
}

export type PeerServerOptions = {
  registration: OwnerRegistration;
  authentication: PeerAuthentication;
  apply: (request: PeerPublicationRequest, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
  maxWebSocketPayloadBytes?: number;
  forwardHttp?: (
    request: IncomingMessage,
    response: ServerResponse,
    member: string,
    signal: AbortSignal,
    admitted: () => void,
  ) => Promise<void>;
  forwardControl?: PeerServerOptions["forwardHttp"];
  forward?: (
    request: IncomingMessage,
    target: OwnerForwardRequest,
    signal: AbortSignal,
  ) => Promise<{ accept(socket: WebSocket): Promise<void>; cancel(): void }>;
};

type SocketOwner = {
  closed: Promise<void>;
  deadline: number;
  transfer: () => void;
};
type RequestOwner = {
  request: IncomingMessage;
  response: ServerResponse;
  controller: AbortController;
  requestClosed: Promise<void>;
  responseClosed: Promise<void>;
  socket: SocketOwner;
  httpReceipt: boolean;
};

export class PeerServer {
  private readonly server: Server;
  private readonly registration: Readonly<OwnerRegistration>;
  private readonly authentication: PeerAuthentication;
  private readonly apply: PeerServerOptions["apply"];
  private readonly timeoutMs: number;
  private readonly sockets = new Map<Socket, SocketOwner>();
  private readonly active = new Set<RequestOwner>();
  private readonly handlers = new Set<Promise<void>>();
  private readonly cleanupErrors: Error[] = [];
  private closed = false;
  private httpReceiptDeadline = 0;
  private listening: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly webSockets: WebSocketServer;
  private readonly forwards = new Set<AbortController>();
  private readonly forward: PeerServerOptions["forward"];
  private readonly forwardHttp: PeerServerOptions["forwardHttp"];
  private readonly forwardControl: PeerServerOptions["forwardControl"];

  public constructor(options: PeerServerOptions) {
    const timeoutMs = options.timeoutMs === undefined ? defaultTimeoutMs : options.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultTimeoutMs)
      throw new Error(configurationError);
    // JavaScript callers must fail closed before any listener is allocated.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!options.registration || !options.authentication || typeof options.apply !== "function")
      throw new Error(configurationError);
    this.registration = parseOwnerRegistration(options.registration);
    if (this.registration.member_id !== options.authentication.memberId)
      throw new Error(configurationError);
    this.authentication = options.authentication;
    this.apply = options.apply;
    this.timeoutMs = timeoutMs;
    this.forward = options.forward;
    this.forwardHttp = options.forwardHttp;
    this.forwardControl = options.forwardControl;
    this.webSockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: (options.maxWebSocketPayloadBytes ?? 1048576) * 2 + 1024,
    });
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      this.handle(request, response);
    };
    this.server =
      this.authentication.serverTLS === undefined
        ? createServer({ maxHeaderSize: 32768 }, handler)
        : createSecureServer(
            { ...this.authentication.serverTLS, handshakeTimeout: timeoutMs, maxHeaderSize: 32768 },
            handler,
          );
    // The owned timers also cover incomplete headers and TLS connections.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.timeout = 0;
    this.server.on("connection", (socket: Socket) => {
      this.ownSocket(socket);
      if (this.closed && !this.receivingHttpReceipts()) socket.destroy();
    });
    this.server.on("checkContinue", handler);
    this.server.on("checkExpectation", handler);
    this.server.on("upgrade", (request, socket, head) => {
      const original = this.handleForward(request, socket, head);
      this.handlers.add(original);
      const forget = () => this.handlers.delete(original);
      void original.then(forget, forget);
    });
    this.server.on("clientError", (_error, socket) => {
      if (socket.destroyed || !socket.writable) return;
      const body = errorBody("invalid_request");
      socket.end(
        `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${body.byteLength}\r\n\r\n${body.toString("utf8")}`,
      );
    });
    this.server.on("error", () => {
      this.cleanupErrors.push(new Error("Peer listener listener failed"));
      for (const owner of this.active) owner.controller.abort(new PeerFailure("internal_error"));
      for (const socket of this.sockets.keys()) socket.destroy();
    });
  }

  public listen(host: string, port: number): Promise<void> {
    if (this.closed || this.listening !== undefined)
      return Promise.reject(new Error(configurationError));
    this.listening = new Promise<void>((resolve, reject) => {
      const finish = () => {
        this.server.off("listening", onListening);
        this.server.off("error", onError);
      };
      const onListening = () => {
        finish();
        resolve();
      };
      const onError = () => {
        finish();
        reject(new Error("Peer listener listener failed"));
      };
      this.server.once("listening", onListening);
      this.server.once("error", onError);
      try {
        this.server.listen(port, host);
      } catch {
        onError();
      }
    });
    return this.listening;
  }

  public address(): AddressInfo | null {
    const address = this.server.address();
    return typeof address === "string" ? null : address;
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const receipt = Promise.withResolvers<void>();
    this.closePromise = receipt.promise;
    this.closed = true;
    if (this.forwardHttp !== undefined && this.server.listening)
      this.httpReceiptDeadline = performance.now() + 5000;
    for (const controller of this.forwards) controller.abort(new Error("Peer listener closing"));
    for (const owner of this.active)
      if (!owner.httpReceipt) owner.controller.abort(new PeerFailure("configuration_unavailable"));
    void this.stop().then(receipt.resolve, receipt.reject);
    return receipt.promise;
  }

  private async stop(): Promise<void> {
    // A close during listen must also join a late successful bind.
    try {
      await this.listening;
    } catch {
      /* listen reports its own fixed error */
    }
    // The public HTTP transport retires connections concurrently. Preserve the
    // same receipt window on this private ingress so original DELETEs can join
    // that cleanup; neither a listener close nor an abort is its acknowledgement.
    const remaining = this.httpReceiptDeadline - performance.now();
    if (remaining > 0)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        timer.unref();
      });
    const listenerClosed = new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((error) => {
        if (error !== undefined)
          this.cleanupErrors.push(new Error("Peer listener listener close failed"));
        resolve();
      });
    });
    this.server.closeIdleConnections();
    await this.drainHandlers();
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
    for (const socket of this.sockets.keys()) socket.destroy();
    await Promise.all([...this.sockets.values()].map((owner) => owner.closed));
    await listenerClosed;
    // No listener remains; drain any request delivered during its final close.
    await this.drainHandlers();
    if (this.cleanupErrors.length !== 0)
      throw new AggregateError(this.cleanupErrors, "Peer listener cleanup failed");
  }

  private async drainHandlers(): Promise<void> {
    while (this.handlers.size !== 0) await Promise.allSettled([...this.handlers]);
  }

  private ownSocket(socket: Socket): SocketOwner {
    const existing = this.sockets.get(socket);
    if (existing !== undefined) return existing;
    const receipt = Promise.withResolvers<void>();
    const deadline = performance.now() + this.timeoutMs;
    const owner = { closed: receipt.promise, deadline, transfer: () => clearTimeout(timer) };
    this.sockets.set(socket, owner);
    const interrupt = (code: FailureCode) => {
      for (const request of this.active)
        if (request.request.socket === socket) request.controller.abort(new PeerFailure(code));
    };
    const onError = () => interrupt("invalid_request");
    const timer = setTimeout(() => {
      interrupt("deadline_exceeded");
      socket.destroy();
    }, this.timeoutMs);
    timer.unref();
    socket.on("error", onError);
    socket.once("close", () => {
      clearTimeout(timer);
      interrupt("invalid_request");
      socket.off("error", onError);
      this.sockets.delete(socket);
      receipt.resolve();
    });
    return owner;
  }

  private async handleForward(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const controller = new AbortController();
    this.forwards.add(controller);
    const cancel = () => controller.abort(new Error("Peer socket closed"));
    socket.once("close", cancel);
    let prepared: Awaited<ReturnType<NonNullable<PeerServerOptions["forward"]>>> | undefined;
    const state = { upgraded: false };
    try {
      if (
        this.closed ||
        this.forward === undefined ||
        request.url !== OWNER_FORWARD_PATH ||
        request.method !== "GET"
      )
        throw new PeerFailure("route_not_found");
      const authenticated = this.authentication.authenticate(request);
      if (authenticated.code !== null)
        throw new PeerFailure(
          authenticated.code === "caller_not_allowed"
            ? "caller_not_allowed"
            : "service_unauthenticated",
        );
      const headers = fields(request).filter(
        (field) => field.name.toLowerCase() === OWNER_FORWARD_HEADER.toLowerCase(),
      );
      if (headers.length !== 1 || request.headers.expect !== undefined)
        throw new PeerFailure("invalid_request");
      const target = parseOwnerForward(headers[0]!.value);
      if (
        target.source.member_id !== authenticated.caller ||
        target.membership_sha256 !== this.authentication.membership.sha256 ||
        !isDeepStrictEqual(target.target, this.registration)
      )
        throw new PeerFailure("caller_not_allowed");
      const remaining = Date.parse(target.deadline_at) - Date.now();
      if (remaining <= 0 || remaining > 10000) throw new PeerFailure("deadline_exceeded");
      prepared = await this.forward(request, target, controller.signal);
      controller.signal.throwIfAborted();
      if (this.isClosed() || Date.now() >= Date.parse(target.deadline_at))
        throw new PeerFailure("deadline_exceeded");
      this.sockets.get(request.socket)?.transfer();
      // The owning server rewrites the URL only after validating the fixed private route.
      const accepted = Promise.withResolvers<void>();
      this.webSockets.handleUpgrade(request, socket, head, (wire) => {
        state.upgraded = true;
        void prepared!.accept(wire).then(accepted.resolve, accepted.reject);
      });
      if (!state.upgraded) throw new PeerFailure("invalid_request");
      await accepted.promise;
    } catch (error) {
      if (state.upgraded) {
        this.cleanupErrors.push(new Error("Forwarded peer cleanup failed", { cause: error }));
        socket.destroy();
      } else if (!socket.destroyed) {
        const status =
          error instanceof PeerFailure || error instanceof PeerDeadlineError
            ? failures[error.code].status
            : error instanceof DomainError && error.code === "access_denied"
              ? 403
              : 503;
        socket.end(
          `HTTP/1.1 ${status} Peer admission failed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      }
    } finally {
      prepared?.cancel();
      socket.off("close", cancel);
      this.forwards.delete(controller);
    }
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private receivingHttpReceipts(): boolean {
    return this.closed && performance.now() < this.httpReceiptDeadline;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const receipt = Promise.withResolvers<void>();
    this.handlers.add(receipt.promise);
    const requestClosed = Promise.withResolvers<void>();
    const responseClosed = Promise.withResolvers<void>();
    request.once("close", () => requestClosed.resolve());
    response.once("close", () => responseClosed.resolve());
    const owner: RequestOwner = {
      request,
      response,
      controller: new AbortController(),
      requestClosed: requestClosed.promise,
      responseClosed: responseClosed.promise,
      socket: this.ownSocket(request.socket),
      httpReceipt: false,
    };
    this.active.add(owner);
    const completed = () => {
      this.active.delete(owner);
      this.handlers.delete(receipt.promise);
      receipt.resolve();
    };
    void this.serve(owner).then(completed, () => {
      this.cleanupErrors.push(new Error("Peer listener request cleanup failed"));
      request.socket.destroy();
      request.destroy();
      response.destroy();
      void Promise.all([owner.socket.closed, owner.requestClosed, owner.responseClosed]).then(
        completed,
      );
    });
  }

  private async serve(owner: RequestOwner): Promise<void> {
    const { request, response, controller } = owner;
    const onDisconnect = () => controller.abort(new PeerFailure("invalid_request"));
    request.on("error", onDisconnect);
    response.on("error", onDisconnect);
    response.once("close", onDisconnect);
    const remaining = Math.max(0, owner.socket.deadline - performance.now());
    const reserve = Math.min(100, remaining / 10);
    const timer = setTimeout(
      () => controller.abort(new PeerFailure("deadline_exceeded")),
      Math.max(0, remaining - reserve),
    );
    timer.unref();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const authentication = this.authentication.authenticate(request);
      if (authentication.code !== null) {
        if (authentication.www_authenticate !== null)
          response.setHeader("WWW-Authenticate", authentication.www_authenticate);
        throw new PeerFailure(
          authentication.code === "caller_not_allowed"
            ? "caller_not_allowed"
            : "service_unauthenticated",
        );
      }
      if (request.url === OWNER_HTTP_PATH && this.forwardHttp !== undefined) {
        const receipt =
          request.method === "DELETE" &&
          fields(request).some((field) => field.name.toLowerCase() === "acp-connection-id");
        if (this.closed && !(receipt && this.receivingHttpReceipts()))
          throw new PeerFailure("configuration_unavailable");
        if (request.headers.expect !== undefined) throw new PeerFailure("invalid_request");
        if (!["POST", "GET", "DELETE"].includes(request.method ?? ""))
          throw new PeerFailure("method_not_allowed");
        if (authentication.caller === null) throw new PeerFailure("service_unauthenticated");
        owner.httpReceipt = receipt;
        // This listener owns one original request per socket and closes it in
        // finally. Advertise that before a client can pipeline its next SSE GET.
        response.shouldKeepAlive = false;
        response.setHeader("Connection", "close");
        await this.forwardHttp(request, response, authentication.caller, controller.signal, () => {
          clearTimeout(timer);
          owner.socket.transfer();
        });
        return;
      }
      if (
        this.forwardControl !== undefined &&
        (request.url === OWNER_CONTROL_PATHS["state-read"] ||
          request.url === OWNER_CONTROL_PATHS["state-watch"] ||
          request.url === OWNER_CONTROL_PATHS.settlement)
      ) {
        if (this.closed) throw new PeerFailure("configuration_unavailable");
        if (request.method !== "POST") throw new PeerFailure("method_not_allowed");
        if (request.headers.expect !== undefined) throw new PeerFailure("invalid_request");
        if (authentication.caller === null) throw new PeerFailure("service_unauthenticated");
        response.shouldKeepAlive = false;
        response.setHeader("Connection", "close");
        await this.forwardControl(
          request,
          response,
          authentication.caller,
          controller.signal,
          () => {
            clearTimeout(timer);
            owner.socket.transfer();
          },
        );
        return;
      }
      if (request.url !== identityPath && request.url !== publicationPath)
        throw new PeerFailure(
          [identityPath, publicationPath].some(
            (path) => request.url?.startsWith(`${path}?`) === true,
          )
            ? "invalid_request"
            : "route_not_found",
        );
      if (request.method !== "POST") throw new PeerFailure("method_not_allowed");
      if (this.closed) throw new PeerFailure("configuration_unavailable");
      if (
        request.headers.expect !== undefined ||
        fields(request).some((field) => field.name.toLowerCase() === "antnest-caller-context")
      )
        throw new PeerFailure("invalid_request");
      requireJson(request);
      const raw = await readBody(request, controller.signal);
      controller.signal.throwIfAborted();
      let value: Record<string, unknown>;
      try {
        value = strictObject(raw);
      } catch {
        throw new PeerFailure("invalid_request");
      }
      if (request.url === publicationPath && typeof value.hop === "number" && value.hop !== 1)
        throw new PeerFailure("acp_peer_hop_rejected");
      const input =
        request.url === identityPath
          ? parsePeerIdentityRequest(value)
          : parsePeerPublicationRequest(value);
      if (input.source.member_id !== authentication.caller)
        throw new PeerFailure("caller_not_allowed");
      if (input.membership_sha256 !== this.authentication.membership.sha256)
        throw new PeerFailure("acp_peer_membership_conflict");
      if (
        ("target" in input && !isDeepStrictEqual(input.target, this.registration)) ||
        ("target_member_id" in input && input.target_member_id !== this.registration.member_id)
      )
        throw new PeerFailure("acp_peer_incarnation_mismatch");
      const expiresAt = peerDeadline(input.deadline_at);
      const budget = expiresAt - Date.now();
      if (budget > 10000) throw new PeerFailure("invalid_request");
      if (budget <= 0) throw new PeerFailure("deadline_exceeded");
      deadlineTimer = setTimeout(
        () => controller.abort(new PeerFailure("deadline_exceeded")),
        budget,
      );
      deadlineTimer.unref();
      let output: unknown;
      if ("challenge" in input) {
        output = {
          request_id: input.request_id,
          membership_sha256: input.membership_sha256,
          challenge: input.challenge,
          registration: this.registration,
        };
      } else {
        let result: unknown;
        try {
          result = await this.apply(input, controller.signal);
        } catch (error) {
          if (controller.signal.aborted && error !== controller.signal.reason)
            this.cleanupErrors.push(
              new Error("Peer leaf failed after cancellation", { cause: error }),
            );
          throw error;
        }
        controller.signal.throwIfAborted();
        try {
          const receipt = parsePeerPublicationReceipt(result);
          if (
            receipt.request_id !== input.request_id ||
            receipt.membership_sha256 !== input.membership_sha256 ||
            !isDeepStrictEqual(receipt.registration, this.registration) ||
            !isDeepStrictEqual(receipt.publication, input.publication)
          )
            throw new Error();
          output = receipt;
        } catch {
          throw new PeerFailure("internal_error");
        }
      }
      controller.signal.throwIfAborted();
      if (Date.now() >= expiresAt) throw new PeerFailure("deadline_exceeded");
      await writeReply(
        response,
        200,
        Buffer.from(JSON.stringify(output)),
        request.url === identityPath ? 8192 : responseBytes,
      );
    } catch (error) {
      const code = failureCode(controller.signal.aborted ? controller.signal.reason : error);
      if (code === "method_not_allowed") response.setHeader("Allow", "POST");
      await writeReply(response, failures[code].status, errorBody(code));
    } finally {
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      request.pause();
      // Finish the response before closing an unread request. The socket's
      // original hard deadline remains active until its real close receipt.
      if (response.writableFinished && !request.socket.destroyed) request.socket.end();
      else request.socket.destroy();
      await owner.socket.closed;
      request.destroy();
      response.destroy();
      await Promise.all([owner.requestClosed, owner.responseClosed]);
      request.off("error", onDisconnect);
      response.off("error", onDisconnect);
      response.off("close", onDisconnect);
    }
  }
}

function failureCode(error: unknown): FailureCode {
  if (error instanceof PeerFailure) return error.code;
  if (error instanceof PeerDeadlineError) return error.code;
  if (error instanceof DomainError) {
    if (error.code === "invalid_request" || error.code === "configuration_unavailable")
      return error.code;
  }
  return "internal_error";
}

function errorBody(code: FailureCode): Buffer {
  return Buffer.from(
    JSON.stringify({
      code,
      message: "ACP peer request did not complete",
      retryable: failures[code].retryable,
    }),
  );
}

function requireJson(request: IncomingMessage): void {
  const headers = fields(request);
  const types = headers.filter((field) => field.name.toLowerCase() === "content-type");
  const encodings = headers.filter((field) => field.name.toLowerCase() === "content-encoding");
  if (
    types.length !== 1 ||
    !/^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?$/iu.test(
      types[0]!.value,
    ) ||
    encodings.length > 1 ||
    (encodings.length === 1 && encodings[0]!.value.toLowerCase() !== "identity")
  )
    throw new PeerFailure("unsupported_media_type");
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  if (Number(request.headers["content-length"]) > requestBytes)
    return Promise.reject(new PeerFailure("request_too_large"));
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      request.pause();
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onError);
      request.off("close", onError);
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve(Buffer.concat(chunks, bytes));
    };
    const onData = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) {
        finish(new PeerFailure("invalid_request"));
        return;
      }
      bytes += chunk.byteLength;
      if (bytes > requestBytes) {
        finish(new PeerFailure("request_too_large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new PeerFailure("invalid_request"));
    const onAbort = () => {
      const reason: unknown = signal.reason;
      finish(reason instanceof Error ? reason : new PeerFailure(failureCode(reason)));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onError);
    request.once("close", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (request.readableEnded) onEnd();
    else request.resume();
  });
}

function writeReply(
  response: ServerResponse,
  status: number,
  raw: Buffer,
  maximum = responseBytes,
): Promise<void> {
  if (raw.byteLength > maximum) {
    status = failures.internal_error.status;
    raw = errorBody("internal_error");
  }
  return new Promise<void>((resolve) => {
    if (response.destroyed) {
      resolve();
      return;
    }
    const finish = () => {
      response.off("finish", finish);
      response.off("close", finish);
      resolve();
    };
    response.once("finish", finish);
    response.once("close", finish);
    try {
      response.shouldKeepAlive = false;
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Content-Length": raw.byteLength,
        Connection: "close",
      });
      response.end(raw);
    } catch {
      response.destroy();
    }
  });
}
