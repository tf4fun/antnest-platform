import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { CALLER_CONTEXT_HEADER } from "../adapters/caller-context.js";
import { fields } from "../adapters/service-authentication.js";
import {
  controlBodyDigest,
  encodeOwnerControl,
  parseOwnerControl,
  type OwnerControlRequest,
} from "../application/owner-control-forwarding.js";
import { OWNER_FORWARD_HEADER } from "../application/owner-forwarding.js";
import { DomainError } from "../domain/errors.js";
import {
  isExecutionAccessRevoked,
  type ExecutionAccessSnapshot,
  type ExecutionIdentity,
} from "../domain/execution-configuration.js";
import type { AgentExecutionStatePort } from "../ports/agent-execution-state.js";
import { PeerDeadlineError } from "../ports/agent-peers.js";
import {
  AGENT_EXECUTION_STATE_PATH,
  AGENT_EXECUTION_WATCH_PATH,
  finishResponse,
  serveAgentExecutionState,
  writeStateChunk,
} from "./agent-execution-state.js";
import type { HttpOwnerForwardingOptions } from "./owner-http.js";
import { httpFailure } from "./public-error.js";
import type { RequestAuthentication } from "./request-authentication.js";
import { trustedIdentity } from "./trusted-identity.js";

export const OWNER_CONTROL_PATHS = {
  "state-read": "/internal/acp-peer/control/state-read",
  "state-watch": "/internal/acp-peer/control/state-watch",
  settlement: "/internal/acp-peer/control/settlement",
  "source-inspect": "/internal/acp-peer/control/source-inspect",
  "source-artifact": "/internal/acp-peer/control/source-artifact",
} as const;

type Original = {
  identity: ExecutionIdentity;
  response: ServerResponse;
  cancellation: AbortController;
  watch: boolean;
  joined: PromiseWithResolvers<void>;
};
type StateContext = Extract<OwnerControlRequest, { operation: "state-read" | "state-watch" }>;

/** Fixed service operations retain the original owner and cleanup receipts. */
export class OwnerControlTransport {
  private readonly originals = new Set<Original>();
  private readonly failures = new Map<ExecutionIdentity, unknown>();
  private closing: Promise<void> | undefined;

  public constructor(
    private readonly options: Omit<HttpOwnerForwardingOptions, "handles"> & {
      authentication: RequestAuthentication;
      state: AgentExecutionStatePort | undefined;
      ready(): Promise<boolean>;
      maxBytes: number;
      deliveryTimeoutMs?: number;
      report(error: unknown): void;
    },
  ) {}

  public async revokeAccess(snapshot: ExecutionAccessSnapshot): Promise<void> {
    await this.interrupt((identity) => isExecutionAccessRevoked(snapshot, identity), false);
  }

  public close(): Promise<void> {
    return (this.closing ??= this.interrupt(() => true, true));
  }

  private async interrupt(matches: (identity: ExecutionIdentity) => boolean, closing: boolean) {
    const originals = [...this.originals].filter((original) => matches(original.identity));
    for (const original of originals) {
      // The owner sends the final denied state. Publication joins that original
      // stream instead of cutting it off before its terminal frame and EOF.
      if (closing || !original.watch) {
        original.cancellation.abort();
        original.response.destroy();
      }
    }
    await Promise.all(originals.map((original) => original.joined.promise));
    const failures = [...this.failures]
      .filter(([identity]) => matches(identity))
      .map(([, error]) => error);
    if (failures.length) throw new AggregateError(failures, "Owner control cleanup failed");
  }

  /** Called after the public route has authenticated and validated its empty body. */
  public forwardState(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ExecutionIdentity,
    signal: AbortSignal,
    onWatchStarted: () => void,
  ): Promise<boolean> {
    const operation = request.url === AGENT_EXECUTION_WATCH_PATH ? "state-watch" : "state-read";
    return this.own(request, response, identity, signal, async (original, lifetime) => {
      const resolved = await this.options.resolver.resolve(identity, "v1", lifetime);
      lifetime.throwIfAborted();
      if (resolved === null) return false;
      const { protocol: _protocol, ...authority } = resolved;
      void _protocol;
      const target: StateContext = { ...authority, operation, body_sha256: controlBodyDigest({}) };
      await this.relayState(request, response, target, lifetime, () => {
        original.watch = true;
        onWatchStarted();
      });
      return true;
    });
  }

  public async handlePeer(
    request: IncomingMessage,
    response: ServerResponse,
    member: string,
    signal: AbortSignal,
    admitted: () => void,
  ): Promise<void> {
    try {
      const values = fields(request).filter(
        (field) => field.name.toLowerCase() === OWNER_FORWARD_HEADER.toLowerCase(),
      );
      if (values.length !== 1) throw denied();
      const target = parseOwnerControl(values[0]!.value);
      if (
        request.method !== "POST" ||
        request.url !== OWNER_CONTROL_PATHS[target.operation] ||
        target.source.member_id !== member ||
        target.membership_sha256 !== this.options.peers.membership.sha256 ||
        !isDeepStrictEqual(target.target, this.options.registration)
      )
        throw denied();
      if (target.operation !== "state-read" && target.operation !== "state-watch")
        throw new DomainError("invalid_request", "Owner operation is unavailable");
      if (target.body_sha256 !== controlBodyDigest({})) throw denied();
      await this.own(request, response, target.identity, signal, async (original, lifetime) => {
        request.url =
          target.operation === "state-watch"
            ? AGENT_EXECUTION_WATCH_PATH
            : AGENT_EXECUTION_STATE_PATH;
        const authentication = await this.options.authentication.admitPeer(
          request,
          target.caller,
          false,
        );
        lifetime.throwIfAborted();
        if ("status" in authentication) {
          const failure = httpFailure(authentication.code);
          if (authentication.challenge !== undefined)
            response.setHeader("WWW-Authenticate", authentication.challenge);
          this.sendFailure(response, failure);
          return true;
        }
        if (!isDeepStrictEqual(trustedIdentity(request.headers), target.identity)) throw denied();
        const dispatch = async (
          operation: "read" | "watch",
          identity: ExecutionIdentity,
          send: Parameters<AgentExecutionStatePort["read"]>[1],
          caller: AbortSignal,
        ) => {
          const remaining = Date.parse(target.deadline_at) - Date.now();
          if (remaining <= 0 || remaining > 10000)
            throw new PeerDeadlineError("State admission expired");
          const timeout = new AbortController();
          const bounded = AbortSignal.any([lifetime, caller, timeout.signal]);
          const timer = setTimeout(
            () => timeout.abort(new PeerDeadlineError("State admission expired")),
            remaining,
          );
          timer.unref();
          try {
            const authority = await this.options.admit({ ...target, protocol: "v1" }, bounded);
            bounded.throwIfAborted();
            authority.assertCurrent();
            if (this.options.state === undefined) throw unavailable();
            const fixed = { ...identity, ownerFence: authority.fence };
            original.watch = operation === "watch";
            clearTimeout(timer);
            admitted();
            await this.options.state[operation](fixed, send, caller);
          } finally {
            clearTimeout(timer);
          }
        };
        await serveAgentExecutionState(
          request,
          response,
          {
            read: (identity, send, caller) => dispatch("read", identity, send, caller),
            watch: (identity, send, caller) => dispatch("watch", identity, send, caller),
          },
          this.options.maxBytes,
          () => this.options.ready(),
          this.options.deliveryTimeoutMs,
        );
        return true;
      });
    } catch (error) {
      this.options.report(error);
      this.fail(response, error);
    }
  }

  private async own(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ExecutionIdentity,
    parent: AbortSignal,
    operation: (original: Original, signal: AbortSignal) => Promise<boolean>,
  ): Promise<boolean> {
    const original: Original = {
      identity,
      response,
      cancellation: new AbortController(),
      watch: false,
      joined: Promise.withResolvers<void>(),
    };
    this.originals.add(original);
    const signal = AbortSignal.any([parent, original.cancellation.signal]);
    const disconnected = () => {
      if (!response.writableFinished) original.cancellation.abort();
    };
    const interrupt = () => response.destroy();
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    signal.addEventListener("abort", interrupt, { once: true });
    let handled = true;
    try {
      signal.throwIfAborted();
      if (this.closing !== undefined) throw unavailable();
      handled = await operation(original, signal);
      return handled;
    } catch (error) {
      this.options.report(error);
      if (error instanceof ControlCleanupError) this.failures.set(identity, error);
      this.fail(response, error);
      return true;
    } finally {
      if (handled) {
        if (!response.writableEnded && !response.destroyed) response.destroy();
        const sent = await Promise.allSettled([finished(response, { cleanup: true })]);
        if (!request.readableEnded) request.destroy();
        const received = await Promise.allSettled([finished(request, { cleanup: true })]);
        const failures = [...sent, ...received].flatMap((result) =>
          result.status === "rejected" && !cancelled(result.reason)
            ? [result.reason as unknown]
            : [],
        );
        if (failures.length) this.failures.set(identity, new ControlCleanupError(failures));
      }
      signal.removeEventListener("abort", interrupt);
      request.off("aborted", disconnected);
      response.off("close", disconnected);
      this.originals.delete(original);
      original.joined.resolve();
    }
  }

  private async relayState(
    request: IncomingMessage,
    response: ServerResponse,
    target: StateContext,
    parent: AbortSignal,
    onWatchStarted: () => void,
  ): Promise<void> {
    const member = this.options.peers.membership.members.find(
      (entry) => entry.member_id === target.target.member_id,
    );
    if (member === undefined) throw unavailable();
    const contexts = fields(request).filter(
      (field) => field.name.toLowerCase() === CALLER_CONTEXT_HEADER.toLowerCase(),
    );
    if (contexts.length !== 1) throw denied();
    const remaining = Date.parse(target.deadline_at) - Date.now();
    if (remaining <= 0 || remaining > 10000) throw new PeerDeadlineError("State admission expired");
    const cancellation = new AbortController();
    const signal = AbortSignal.any([parent, cancellation.signal]);
    const timer = setTimeout(
      () => cancellation.abort(new PeerDeadlineError("State admission expired")),
      remaining,
    );
    timer.unref();
    const originals: Promise<unknown>[] = [];
    let upstream: Response | undefined;
    let primary: unknown;
    let failed = false;
    let failures: unknown[];
    try {
      const pending = this.options.peers.fetchFor(member.member_id)(
        new URL(OWNER_CONTROL_PATHS[target.operation], member.origin),
        {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            [CALLER_CONTEXT_HEADER]: contexts[0]!.value,
            [OWNER_FORWARD_HEADER]: encodeOwnerControl(target),
          },
          body: "{}",
        },
      );
      originals.push(pending);
      upstream = await pending;
      signal.throwIfAborted();
      if (Date.now() >= Date.parse(target.deadline_at))
        throw new PeerDeadlineError("State admission expired");
      clearTimeout(timer);
      if (
        target.operation === "state-watch" &&
        upstream.status === 200 &&
        /^text\/event-stream(?:\s*;|$)/iu.test(upstream.headers.get("content-type") ?? "")
      )
        onWatchStarted();
      for (const name of [
        "content-type",
        "cache-control",
        "retry-after",
        "www-authenticate",
        "x-accel-buffering",
      ]) {
        const value = upstream.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      response.writeHead(upstream.status);
      response.flushHeaders();
      if (upstream.body !== null) {
        const sent = this.sendStateBody(upstream.body, response, signal);
        originals.push(sent);
        await sent;
      } else {
        const sent = finishResponse(response, signal, this.options.deliveryTimeoutMs);
        originals.push(sent);
        await sent;
      }
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      clearTimeout(timer);
      cancellation.abort();
      if (upstream?.body !== null && upstream?.body !== undefined && !upstream.body.locked)
        originals.push(Promise.resolve().then(() => upstream!.body!.cancel()));
      const results = await Promise.allSettled(originals);
      failures = results.flatMap((result) =>
        result.status === "rejected" &&
        !(failed && result.reason === primary) &&
        !cancelled(result.reason)
          ? [result.reason as unknown]
          : [],
      );
    }
    if (failures.length) throw new ControlCleanupError(failed ? [primary, ...failures] : failures);
    if (failed) throw primary;
  }

  private async sendStateBody(
    body: ReadableStream<Uint8Array>,
    response: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const closed = reader.closed;
    void closed.catch(() => undefined);
    let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    let cancelling: Promise<void> | undefined;
    let primary: unknown;
    let failed = false;
    const cancel = () => {
      cancelling ??= Promise.resolve().then(() => reader.cancel());
      void cancelling.catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    let failures: unknown[];
    try {
      for (;;) {
        signal.throwIfAborted();
        reading = reader.read();
        const chunk = await reading;
        reading = undefined;
        signal.throwIfAborted();
        if (chunk.done) break;
        // Idle watches have no duration limit; each actual write is bounded.
        await writeStateChunk(response, chunk.value, signal, this.options.deliveryTimeoutMs);
      }
      await finishResponse(response, signal, this.options.deliveryTimeoutMs);
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      cancel();
      const results = await Promise.allSettled([reading, closed, cancelling]);
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
      failures = results.flatMap((result) =>
        result.status === "rejected" &&
        !(failed && result.reason === primary) &&
        !cancelled(result.reason)
          ? [result.reason as unknown]
          : [],
      );
    }
    if (failures.length) throw new ControlCleanupError(failed ? [primary, ...failures] : failures);
    if (failed) throw primary;
  }

  private fail(response: ServerResponse, error: unknown) {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    this.sendFailure(
      response,
      httpFailure(
        error instanceof DomainError && error.code === "access_denied"
          ? error.code
          : "execution_state_unavailable",
      ),
    );
  }
  private sendFailure(response: ServerResponse, failure: ReturnType<typeof httpFailure>) {
    response.writeHead(failure.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(failure.body));
  }
}

class ControlCleanupError extends AggregateError {
  public constructor(errors: unknown[]) {
    super(errors, "Owner control original cleanup failed");
  }
}
function cancelled(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      ("code" in error && ["ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE"].includes(String(error.code))))
  );
}
function denied() {
  return new DomainError("access_denied", "Owner control identity rejected");
}
function unavailable() {
  return new DomainError("execution_state_unavailable", "Owner state is unavailable");
}
