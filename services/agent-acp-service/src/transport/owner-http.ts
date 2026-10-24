import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { isDeepStrictEqual } from "node:util";
import { CALLER_CONTEXT_HEADER } from "../adapters/caller-context.js";
import type { PeerAuthentication } from "../adapters/peer-authentication.js";
import { fields } from "../adapters/service-authentication.js";
import type { HttpOwnerHandles } from "../application/http-owner-handle.js";
import type { ConnectionCapacity } from "../application/connection-capacity.js";
import type { OwnerRegistration } from "../application/owner-incarnation.js";
import {
  encodeOwnerForward,
  OWNER_FORWARD_HEADER,
  parseOwnerForward,
  type OwnerForwarding,
  type OwnerForwardRequest,
} from "../application/owner-forwarding.js";
import type { AgentOwnershipFence } from "../domain/agent-ownership.js";
import {
  isExecutionAccessRevoked,
  type ExecutionAccessSnapshot,
  type ExecutionIdentity,
} from "../domain/execution-configuration.js";
import { DomainError } from "../domain/errors.js";
import { PeerDeadlineError } from "../ports/agent-peers.js";
import type { AcpHttpTransport, HttpOwnerAdmission } from "./acp/http-transport.js";
import { httpFailure } from "./public-error.js";
import type { RequestAuthentication } from "./request-authentication.js";
import { trustedIdentity } from "./trusted-identity.js";

export const OWNER_HTTP_PATH = "/internal/acp-peer/forward/http";
const connectionHeader = "acp-connection-id";
const requestHeaders = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "acp-session-id",
  connectionHeader,
]);
const responseHeaders = new Set([
  "content-type",
  "cache-control",
  "retry-after",
  "www-authenticate",
  connectionHeader,
]);

export type HttpOwnerForwardingOptions = {
  registration: OwnerRegistration;
  handles: HttpOwnerHandles;
  resolver: Pick<OwnerForwarding, "resolve">;
  peers: Pick<PeerAuthentication, "fetchFor" | "membership">;
  admit(
    request: OwnerForwardRequest,
    signal: AbortSignal,
  ): Promise<{
    fence: AgentOwnershipFence;
    signal: AbortSignal;
    assertCurrent(): void;
  }>;
};

type Original = {
  identity: ExecutionIdentity;
  response: ServerResponse;
  cancellation: AbortController;
  joined: PromiseWithResolvers<void>;
};

type RelayCapacity = {
  key: string;
  references: number;
  failed: boolean;
  lease: { release(): void };
};

/** Own local HTTP pumps; the target's transport owns its SDK connection. */
export class OwnerHttpTransport {
  private readonly originals = new Set<Original>();
  private readonly cleanupFailures = new Map<ExecutionIdentity, unknown>();
  private readonly relayCapacity = new Map<string, RelayCapacity>();
  private stopped = false;
  private closing: Promise<void> | undefined;

  public constructor(
    private readonly options: HttpOwnerForwardingOptions & {
      transport: AcpHttpTransport;
      capacity: ConnectionCapacity;
      authentication: RequestAuthentication;
      report(error: unknown): void;
    },
  ) {}

  public async revokeAccess(snapshot: ExecutionAccessSnapshot): Promise<void> {
    await this.interrupt((identity) => isExecutionAccessRevoked(snapshot, identity));
  }

  public close(): Promise<void> {
    return (this.closing ??= this.drain());
  }

  private async drain(): Promise<void> {
    const hadActiveRequests = this.originals.size !== 0;
    this.stopped = true;
    const receiptWindow = hadActiveRequests
      ? new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          timer.unref();
        })
      : Promise.resolve();
    const results = await Promise.allSettled([this.interrupt(() => true), receiptWindow]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length) throw new AggregateError(failures, "HTTP ingress drain failed");
  }

  private async interrupt(matches: (identity: ExecutionIdentity) => boolean): Promise<void> {
    const pending = [...this.originals].filter((original) => matches(original.identity));
    for (const original of pending) {
      // An admitted DELETE owns the original owner's actual cleanup receipt.
      // It is joined rather than converted into a transport cancellation.
      if (original.response.req.method !== "DELETE") {
        original.cancellation.abort(new Error("HTTP ingress retired"));
        original.response.destroy();
      }
    }
    await Promise.all(pending.map((original) => original.joined.promise));
    const failures = [...this.cleanupFailures]
      .filter(([identity]) => matches(identity))
      .map(([, error]) => error);
    if (failures.length) throw new AggregateError(failures, "HTTP relay cleanup failed");
  }

  public async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const identity = trustedIdentity(request.headers);
    if (identity === null)
      return this.fail(response, new DomainError("access_denied", "Missing identity"));
    await this.own(request, response, identity, async (signal) => {
      const handle = this.connection(request);
      if (handle !== undefined) {
        const bound = this.options.handles.open(handle);
        if (!isDeepStrictEqual(bound.identity, identity)) throw denied();
        if (bound.owner.member_id === this.options.registration.member_id) {
          if (!isDeepStrictEqual(bound.owner, this.options.registration)) throw unavailable();
          await this.options.transport.handle(request, response);
        } else await this.relay(request, response, bound.owner.member_id, signal);
        return;
      }
      if (request.method !== "POST") throw new DomainError("invalid_request", "Missing connection");
      const target = await this.options.resolver.resolve(identity, "v1", signal, true);
      signal.throwIfAborted();
      if (target === null) throw unavailable();
      if (target.target.member_id === this.options.registration.member_id)
        await this.local(request, response, target, signal, () => undefined);
      else await this.relay(request, response, target.target.member_id, signal, target);
    });
  }

  /** The independent listener has authenticated the directional source member. */
  public async handlePeer(
    request: IncomingMessage,
    response: ServerResponse,
    member: string,
    parent: AbortSignal,
    admitted: () => void,
  ): Promise<void> {
    try {
      if (
        request.url !== OWNER_HTTP_PATH ||
        !["POST", "GET", "DELETE"].includes(request.method ?? "")
      )
        throw new DomainError("invalid_request", "Invalid peer HTTP route");
      const handle = this.connection(request);
      const contexts = fields(request).filter(
        (field) => field.name.toLowerCase() === OWNER_FORWARD_HEADER.toLowerCase(),
      );
      let target: OwnerForwardRequest | undefined;
      let identity: ExecutionIdentity;
      if (handle === undefined) {
        if (request.method !== "POST" || contexts.length !== 1) throw denied();
        target = parseOwnerForward(contexts[0]!.value);
        if (
          target.protocol !== "v1" ||
          target.source.member_id !== member ||
          target.membership_sha256 !== this.options.peers.membership.sha256 ||
          !isDeepStrictEqual(target.target, this.options.registration)
        )
          throw denied();
        identity = target.identity;
      } else {
        if (contexts.length !== 0) throw denied();
        const bound = this.options.handles.open(handle);
        if (!isDeepStrictEqual(bound.owner, this.options.registration)) throw unavailable();
        identity = bound.identity;
      }
      await this.own(
        request,
        response,
        identity,
        async (signal) => {
          request.url = "/v1/acp";
          const authentication = await this.options.authentication.admitPeer(request, "agent-ui");
          signal.throwIfAborted();
          if ("status" in authentication) {
            const failure = httpFailure(authentication.code);
            if (authentication.challenge !== undefined)
              response.setHeader("WWW-Authenticate", authentication.challenge);
            response.writeHead(failure.status, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            response.end(JSON.stringify(failure.body));
            return;
          }
          if (!isDeepStrictEqual(trustedIdentity(request.headers), identity)) throw denied();
          if (target === undefined) {
            admitted();
            await this.options.transport.handle(request, response);
          } else await this.local(request, response, target, signal, admitted);
        },
        parent,
      );
    } catch (error) {
      this.options.report(error);
      this.fail(response, error);
    }
  }

  private async local(
    request: IncomingMessage,
    response: ServerResponse,
    target: OwnerForwardRequest,
    signal: AbortSignal,
    admitted: () => void,
  ): Promise<void> {
    if (!isDeepStrictEqual(target.target, this.options.registration)) throw unavailable();
    const budget = Date.parse(target.deadline_at) - Date.now();
    if (budget <= 0 || budget > 10000) throw new PeerDeadlineError("HTTP admission expired");
    const deadline = new AbortController();
    const admission = AbortSignal.any([signal, deadline.signal]);
    const interrupt = () => response.destroy();
    admission.addEventListener("abort", interrupt, { once: true });
    const timer = setTimeout(
      () => deadline.abort(new PeerDeadlineError("HTTP admission expired")),
      budget,
    );
    timer.unref();
    try {
      admission.throwIfAborted();
      const authority = await this.options.admit(target, admission);
      admission.throwIfAborted();
      const owner: HttpOwnerAdmission = {
        ...authority,
        assertCurrent: () => {
          admission.throwIfAborted();
          authority.assertCurrent();
        },
        admitted: () => {
          clearTimeout(timer);
          admitted();
        },
        encodeConnectionId: (connectionId) =>
          this.options.handles.seal({
            owner: target.target,
            epoch: target.epoch,
            connectionId,
            identity: target.identity,
          }),
      };
      await this.options.transport.handle(request, response, owner);
    } finally {
      clearTimeout(timer);
      admission.removeEventListener("abort", interrupt);
    }
  }

  private async own(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ExecutionIdentity,
    operation: (signal: AbortSignal) => Promise<void>,
    parent?: AbortSignal,
  ): Promise<void> {
    const original: Original = {
      identity,
      response,
      cancellation: new AbortController(),
      joined: Promise.withResolvers<void>(),
    };
    this.originals.add(original);
    const signal =
      parent === undefined
        ? original.cancellation.signal
        : AbortSignal.any([parent, original.cancellation.signal]);
    const cancel = () => {
      if (!response.writableFinished)
        original.cancellation.abort(new Error("HTTP ingress disconnected"));
    };
    const interrupt = () => response.destroy();
    request.once("aborted", cancel);
    response.once("close", cancel);
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      signal.throwIfAborted();
      if ((this.stopped && request.method !== "DELETE") || response.destroyed) throw unavailable();
      await operation(signal);
    } catch (error) {
      this.options.report(error);
      if (error instanceof HttpRelayCleanupError) this.cleanupFailures.set(identity, error);
      this.fail(response, error);
    } finally {
      signal.removeEventListener("abort", interrupt);
      request.off("aborted", cancel);
      response.off("close", cancel);
      this.originals.delete(original);
      original.joined.resolve();
    }
  }

  private async relay(
    request: IncomingMessage,
    response: ServerResponse,
    memberId: string,
    parent: AbortSignal,
    target?: OwnerForwardRequest,
  ): Promise<void> {
    const member = this.options.peers.membership.members.find(
      (candidate) => candidate.member_id === memberId,
    );
    if (member === undefined) throw unavailable();
    const contexts = fields(request).filter(
      (field) => field.name.toLowerCase() === CALLER_CONTEXT_HEADER.toLowerCase(),
    );
    if (contexts.length !== 1) throw denied();
    const identity = trustedIdentity(request.headers);
    if (identity === null) throw denied();
    const headers = new Headers();
    for (const field of fields(request))
      if (requestHeaders.has(field.name.toLowerCase())) headers.append(field.name, field.value);
    headers.set(CALLER_CONTEXT_HEADER, contexts[0]!.value);
    if (target !== undefined) headers.set(OWNER_FORWARD_HEADER, encodeOwnerForward(target));
    const cancellation = new AbortController();
    const signal = AbortSignal.any([parent, cancellation.signal]);
    const originals: Promise<unknown>[] = [];
    let upstream: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let primary: unknown;
    let failures: unknown[];
    const key = target === undefined ? this.connection(request) : `new:${target.request_id}`;
    if (key === undefined) throw denied();
    const capacity = this.relayCapacity.get(key) ?? {
      key,
      references: 0,
      failed: false,
      lease: this.options.capacity.reserve(identity),
    };
    this.relayCapacity.set(key, capacity);
    capacity.references += 1;
    try {
      if (target !== undefined) {
        const budget = Date.parse(target.deadline_at) - Date.now();
        if (budget <= 0 || budget > 10000) throw new PeerDeadlineError("HTTP admission expired");
        timer = setTimeout(
          () => cancellation.abort(new PeerDeadlineError("HTTP admission expired")),
          budget,
        );
        timer.unref();
      }
      const body =
        request.method === "POST" || request.method === "DELETE" ? new PassThrough() : undefined;
      if (body !== undefined) {
        const upload = pipeline(request, body, { signal });
        void upload.catch(() => undefined);
        originals.push(upload);
      } else {
        const input = finished(request, { cleanup: true });
        void input.catch(() => undefined);
        originals.push(input);
        request.resume();
      }
      const pending = this.options.peers.fetchFor(memberId)(
        new URL(OWNER_HTTP_PATH, member.origin),
        {
          method: request.method ?? "GET",
          headers,
          signal,
          ...(body === undefined
            ? {}
            : { body: Readable.toWeb(body) as ReadableStream<Uint8Array>, duplex: "half" }),
        } as RequestInit,
      );
      originals.push(pending);
      upstream = await pending;
      clearTimeout(timer);
      const handle = upstream.headers.get(connectionHeader);
      if (handle !== null) {
        const bound = this.options.handles.open(handle);
        if (
          !isDeepStrictEqual(bound.identity, trustedIdentity(request.headers)) ||
          bound.owner.member_id !== memberId ||
          (target !== undefined &&
            (!isDeepStrictEqual(bound.owner, target.target) || bound.epoch !== target.epoch))
        )
          throw denied();
        if (target !== undefined) {
          this.relayCapacity.delete(capacity.key);
          capacity.key = handle;
          this.relayCapacity.set(handle, capacity);
        }
      }
      for (const [name, value] of upstream.headers)
        if (responseHeaders.has(name)) response.setHeader(name, value);
      if (response.destroyed) throw new DOMException("HTTP ingress disconnected", "AbortError");
      response.writeHead(upstream.status);
      response.flushHeaders();
      if (upstream.body !== null) {
        const download = pipeline(
          Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>),
          response,
          { signal },
        );
        originals.push(download);
        await download;
      } else {
        const sent = finished(response, { cleanup: true });
        originals.push(sent);
        response.end();
        await sent;
      }
    } catch (error) {
      primary = error;
    } finally {
      clearTimeout(timer);
      cancellation.abort();
      if (upstream?.body !== null && upstream?.body !== undefined && !upstream.body.locked)
        originals.push(upstream.body.cancel());
      // A closed public response is not the completion of its upload or reader.
      const settled = await Promise.allSettled(originals);
      failures = settled.flatMap((result) =>
        result.status === "rejected" && result.reason !== primary && !cancelledPump(result.reason)
          ? [result.reason as unknown]
          : [],
      );
      capacity.references -= 1;
      capacity.failed ||= failures.length !== 0;
      if (capacity.references === 0 && !capacity.failed) {
        this.relayCapacity.delete(capacity.key);
        capacity.lease.release();
      }
    }
    if (failures.length)
      throw new HttpRelayCleanupError(primary === undefined ? failures : [primary, ...failures]);
    if (primary !== undefined)
      throw primary instanceof Error
        ? primary
        : new Error("HTTP forwarding failed", { cause: primary });
  }

  private connection(request: IncomingMessage): string | undefined {
    const values = fields(request).filter((field) => field.name.toLowerCase() === connectionHeader);
    if (values.length > 1)
      throw new DomainError("invalid_request", "Duplicate connection identifier");
    return values[0]?.value;
  }

  private fail(response: ServerResponse, error: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const failure = httpFailure(error instanceof DomainError ? error.code : "acp_http_unavailable");
    if (error instanceof DomainError && error.code === "connection_quota_exceeded")
      response.setHeader("Retry-After", "1");
    response.writeHead(failure.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(failure.body));
  }
}

function denied(): DomainError {
  return new DomainError("access_denied", "Forwarded HTTP identity rejected");
}
function unavailable(): DomainError {
  return new DomainError("agent_unavailable", "Original HTTP owner is unavailable");
}
class HttpRelayCleanupError extends AggregateError {
  public constructor(errors: unknown[]) {
    super(errors, "Original HTTP relay cleanup failed");
  }
}
function cancelledPump(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      ("code" in error && ["ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE"].includes(String(error.code))))
  );
}
