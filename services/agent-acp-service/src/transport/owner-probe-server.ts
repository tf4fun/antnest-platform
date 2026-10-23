import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import {
  OwnerIncarnationError,
  parseOwnerProbeRequest,
  type OwnerIncarnation,
  type OwnerProbeRequest,
} from "../application/owner-incarnation.js";
import { fields, type ServiceAuthentication } from "../adapters/service-authentication.js";
import { strictObject } from "../adapters/strict-json.js";

const probePath = "/internal/acp-owner/incarnation/probe";
const requestBytes = 4096;
const responseBytes = 8192;
const defaultTimeoutMs = 2000;
const configurationError = "Owner probe configuration is invalid";

const failures = {
  service_unauthenticated: { status: 401, retryable: false },
  caller_not_allowed: { status: 403, retryable: false },
  invalid_request: { status: 400, retryable: false },
  unsupported_media_type: { status: 415, retryable: false },
  request_too_large: { status: 413, retryable: false },
  acp_probe_intent_mismatch: { status: 409, retryable: false },
  deadline_exceeded: { status: 504, retryable: true },
  internal_error: { status: 500, retryable: true },
  route_not_found: { status: 404, retryable: false },
  method_not_allowed: { status: 405, retryable: false },
} as const;
type FailureCode = keyof typeof failures;

class ProbeFailure extends Error {
  public constructor(public readonly code: FailureCode) {
    super(code);
  }
}

export type OwnerProbeServerOptions = {
  incarnation: OwnerIncarnation;
  authentication: ServiceAuthentication;
  timeoutMs?: number;
};

type SocketOwner = {
  closed: Promise<void>;
  deadline: number;
};
type RequestOwner = {
  request: IncomingMessage;
  response: ServerResponse;
  controller: AbortController;
  requestClosed: Promise<void>;
  responseClosed: Promise<void>;
  socket: SocketOwner;
};

export class OwnerProbeServer {
  private readonly server: Server;
  private readonly incarnation: OwnerIncarnation;
  private readonly authentication: ServiceAuthentication;
  private readonly timeoutMs: number;
  private readonly sockets = new Map<Socket, SocketOwner>();
  private readonly active = new Set<RequestOwner>();
  private readonly handlers = new Set<Promise<void>>();
  private readonly cleanupErrors: Error[] = [];
  private closed = false;
  private listening: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  public constructor(options: OwnerProbeServerOptions) {
    const timeoutMs = options.timeoutMs === undefined ? defaultTimeoutMs : options.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultTimeoutMs)
      throw new Error(configurationError);
    // JavaScript callers must fail closed before any listener is allocated.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!options.incarnation || !options.authentication) throw new Error(configurationError);
    this.incarnation = options.incarnation;
    this.authentication = options.authentication;
    this.timeoutMs = timeoutMs;
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      this.handle(request, response);
    };
    this.server =
      this.authentication.serverTLS === undefined
        ? createServer(handler)
        : createSecureServer(
            { ...this.authentication.serverTLS, handshakeTimeout: timeoutMs },
            handler,
          );
    // The owned timers also cover incomplete headers and TLS connections.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.timeout = 0;
    this.server.on("connection", (socket: Socket) => {
      this.ownSocket(socket);
      if (this.closed) socket.destroy();
    });
    this.server.on("checkContinue", handler);
    this.server.on("checkExpectation", handler);
    this.server.on("clientError", (_error, socket) => {
      if (socket.destroyed || !socket.writable) return;
      const body = errorBody("invalid_request");
      socket.end(
        `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${body.byteLength}\r\n\r\n${body.toString("utf8")}`,
      );
    });
    this.server.on("error", () => {
      this.cleanupErrors.push(new Error("Owner probe listener failed"));
      for (const owner of this.active) owner.controller.abort(new ProbeFailure("internal_error"));
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
        reject(new Error("Owner probe listener failed"));
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
    this.incarnation.close();
    for (const owner of this.active)
      owner.controller.abort(new ProbeFailure("acp_probe_intent_mismatch"));
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
    const listenerClosed = new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((error) => {
        if (error !== undefined)
          this.cleanupErrors.push(new Error("Owner probe listener close failed"));
        resolve();
      });
    });
    this.server.closeIdleConnections();
    await this.drainHandlers();
    for (const socket of this.sockets.keys()) socket.destroy();
    await Promise.all([...this.sockets.values()].map((owner) => owner.closed));
    await listenerClosed;
    // No listener remains; drain any request delivered during its final close.
    await this.drainHandlers();
    if (this.cleanupErrors.length !== 0)
      throw new AggregateError(this.cleanupErrors, "Owner probe cleanup failed");
  }

  private async drainHandlers(): Promise<void> {
    while (this.handlers.size !== 0) await Promise.allSettled([...this.handlers]);
  }

  private ownSocket(socket: Socket): SocketOwner {
    const existing = this.sockets.get(socket);
    if (existing !== undefined) return existing;
    const receipt = Promise.withResolvers<void>();
    const deadline = performance.now() + this.timeoutMs;
    const owner = { closed: receipt.promise, deadline };
    this.sockets.set(socket, owner);
    const interrupt = (code: FailureCode) => {
      for (const request of this.active)
        if (request.request.socket === socket) request.controller.abort(new ProbeFailure(code));
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
    };
    this.active.add(owner);
    const completed = () => {
      this.active.delete(owner);
      this.handlers.delete(receipt.promise);
      receipt.resolve();
    };
    void this.serve(owner).then(completed, () => {
      this.cleanupErrors.push(new Error("Owner probe request cleanup failed"));
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
    const onDisconnect = () => controller.abort(new ProbeFailure("invalid_request"));
    request.on("error", onDisconnect);
    response.on("error", onDisconnect);
    response.once("close", onDisconnect);
    const remaining = Math.max(0, owner.socket.deadline - performance.now());
    const reserve = Math.min(100, remaining / 10);
    const timer = setTimeout(
      () => controller.abort(new ProbeFailure("deadline_exceeded")),
      Math.max(0, remaining - reserve),
    );
    timer.unref();
    try {
      const authentication = this.authentication.authenticate(request, ["runtime-controller"]);
      if (authentication.code !== null) {
        if (authentication.www_authenticate !== null)
          response.setHeader("WWW-Authenticate", authentication.www_authenticate);
        throw new ProbeFailure(
          authentication.code === "caller_not_allowed"
            ? "caller_not_allowed"
            : "service_unauthenticated",
        );
      }
      if (request.url !== probePath)
        throw new ProbeFailure(
          request.url?.startsWith(`${probePath}?`) === true ? "invalid_request" : "route_not_found",
        );
      if (request.method !== "POST") throw new ProbeFailure("method_not_allowed");
      if (this.closed) throw new ProbeFailure("acp_probe_intent_mismatch");
      if (request.headers.expect !== undefined) throw new ProbeFailure("invalid_request");
      requireJson(request);
      const raw = await readBody(request, controller.signal);
      controller.signal.throwIfAborted();
      let input: OwnerProbeRequest;
      try {
        input = parseOwnerProbeRequest(strictObject(raw));
      } catch {
        throw new ProbeFailure("invalid_request");
      }
      const result = this.incarnation.probe(input);
      let output: OwnerProbeRequest;
      try {
        output = parseOwnerProbeRequest(result);
      } catch {
        throw new ProbeFailure("internal_error");
      }
      if (
        Object.keys(input).some(
          (field) => output[field as keyof typeof output] !== input[field as keyof typeof input],
        )
      )
        throw new ProbeFailure("internal_error");
      controller.signal.throwIfAborted();
      await writeReply(response, 200, Buffer.from(JSON.stringify(output)));
    } catch (error) {
      const code = failureCode(controller.signal.aborted ? controller.signal.reason : error);
      if (code === "method_not_allowed") response.setHeader("Allow", "POST");
      await writeReply(response, failures[code].status, errorBody(code));
    } finally {
      clearTimeout(timer);
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
  if (error instanceof ProbeFailure) return error.code;
  if (error instanceof OwnerIncarnationError) {
    if (
      error.code === "invalid_request" ||
      error.code === "acp_probe_intent_mismatch" ||
      error.code === "deadline_exceeded"
    )
      return error.code;
  }
  return "internal_error";
}

function errorBody(code: FailureCode): Buffer {
  return Buffer.from(
    JSON.stringify({
      code,
      message: "ACP incarnation request did not complete",
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
    throw new ProbeFailure("unsupported_media_type");
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  if (Number(request.headers["content-length"]) > requestBytes)
    return Promise.reject(new ProbeFailure("request_too_large"));
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
        finish(new ProbeFailure("invalid_request"));
        return;
      }
      bytes += chunk.byteLength;
      if (bytes > requestBytes) {
        finish(new ProbeFailure("request_too_large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new ProbeFailure("invalid_request"));
    const onAbort = () => {
      const reason: unknown = signal.reason;
      finish(reason instanceof Error ? reason : new ProbeFailure(failureCode(reason)));
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

function writeReply(response: ServerResponse, status: number, raw: Buffer): Promise<void> {
  if (raw.byteLength > responseBytes) {
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
