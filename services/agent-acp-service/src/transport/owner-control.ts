import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { CALLER_CONTEXT_HEADER } from "../adapters/caller-context.js";
import { fields } from "../adapters/service-authentication.js";
import { strictObject } from "../adapters/strict-json.js";
import {
  agentSettlementResultSchema,
  parseAgentSettlement,
  type AgentSettlementRequest,
} from "../domain/agent-settlement.js";
import type { AgentSettlementPort } from "../ports/agent-settlement.js";
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
import { AGENT_SETTLEMENT_PATH, settleAgent, settlementError } from "./agent-settlement.js";

export const OWNER_CONTROL_PATHS = {
  "state-read": "/internal/acp-peer/control/state-read",
  "state-watch": "/internal/acp-peer/control/state-watch",
  settlement: "/internal/acp-peer/control/settlement",
  "source-inspect": "/internal/acp-peer/control/source-inspect",
  "source-artifact": "/internal/acp-peer/control/source-artifact",
} as const;

type Original = {
  identity: ExecutionIdentity | null;
  response: ServerResponse;
  cancellation: AbortController;
  watch: boolean;
  joined: PromiseWithResolvers<void>;
};
type StateContext = Extract<OwnerControlRequest, { operation: "state-read" | "state-watch" }>;
type SettlementContext = Extract<OwnerControlRequest, { operation: "settlement" }>;
const SETTLEMENT_COMPLETION_WINDOW_MS = 10_000;

/** Fixed service operations retain the original owner and cleanup receipts. */
export class OwnerControlTransport {
  private readonly originals = new Set<Original>();
  private readonly failures = new Map<ExecutionIdentity | null, unknown[]>();
  private closing: Promise<void> | undefined;

  public constructor(
    private readonly options: Omit<HttpOwnerForwardingOptions, "handles"> & {
      authentication: RequestAuthentication;
      state: AgentExecutionStatePort | undefined;
      settlement?: AgentSettlementPort | undefined;
      ready(): Promise<boolean>;
      maxBytes: number;
      deliveryTimeoutMs?: number;
      report(error: unknown): void;
    },
  ) {}

  public async revokeAccess(snapshot: ExecutionAccessSnapshot): Promise<void> {
    await this.interrupt(
      (identity) => identity !== null && isExecutionAccessRevoked(snapshot, identity),
      false,
    );
  }

  public close(): Promise<void> {
    return (this.closing ??= this.interrupt(() => true, true));
  }

  private async interrupt(
    matches: (identity: ExecutionIdentity | null) => boolean,
    closing: boolean,
  ) {
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
      .flatMap(([, errors]) => errors);
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

  /** Lifecycle requests have no user identity and survive user revocation. */
  public forwardSettlement(
    request: IncomingMessage,
    response: ServerResponse,
    input: AgentSettlementRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.own(request, response, null, signal, async (_original, lifetime) => {
      const resolve = this.options.resolver.resolveSettlement;
      if (resolve === undefined) return false;
      const target = await resolve.call(this.options.resolver, input, lifetime);
      lifetime.throwIfAborted();
      if (target === null) return false;
      await this.relaySettlement(response, target, input, lifetime);
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
    let settlement = false;
    try {
      const values = fields(request).filter(
        (field) => field.name.toLowerCase() === OWNER_FORWARD_HEADER.toLowerCase(),
      );
      if (values.length !== 1) throw denied();
      const target = parseOwnerControl(values[0]!.value);
      settlement = target.operation === "settlement";
      if (
        request.method !== "POST" ||
        request.url !== OWNER_CONTROL_PATHS[target.operation] ||
        target.source.member_id !== member ||
        target.membership_sha256 !== this.options.peers.membership.sha256 ||
        !isDeepStrictEqual(target.target, this.options.registration)
      )
        throw denied();
      if (target.operation === "settlement") {
        await this.servePeerSettlement(request, response, target, signal, admitted);
        return;
      }
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
      this.fail(response, error, settlement);
    }
  }

  private servePeerSettlement(
    request: IncomingMessage,
    response: ServerResponse,
    target: SettlementContext,
    parent: AbortSignal,
    admitted: () => void,
  ): Promise<boolean> {
    return this.own(request, response, null, parent, async (_original, lifetime) => {
      request.url = AGENT_SETTLEMENT_PATH;
      const authentication = await this.options.authentication.admitPeer(
        request,
        target.caller,
        false,
      );
      lifetime.throwIfAborted();
      if ("status" in authentication) {
        this.sendFailure(response, httpFailure(authentication.code));
        return true;
      }
      await settleAgent(
        request,
        response,
        {
          settle: async (raw, caller) => {
            const input = parseAgentSettlement(raw);
            if (
              target.body_sha256 !== controlBodyDigest(input) ||
              input.organization_id !== target.scope.organizationId ||
              input.agent_id !== target.scope.agentId ||
              input.deadline_at !== target.deadline_at ||
              input.minimum_revision > target.publication.revision
            )
              throw denied();
            if (this.options.settlement === undefined) throw new Error("Settlement is unavailable");
            const signal = AbortSignal.any([lifetime, ...(caller === undefined ? [] : [caller])]);
            admitted();
            // The owning service enforces the original business deadline and
            // joins cleanup before returning not_settled, including expired input.
            // It validates publication under its actual generation, including the
            // protected no-live-lease control path.
            return await this.options.settlement.settle(input, signal, {
              owner: target.target,
              publication: target.publication,
            });
          },
        },
        this.options.maxBytes,
        () => this.options.ready(),
      );
      return true;
    });
  }

  private async own(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ExecutionIdentity | null,
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
      if (error instanceof ControlCleanupError) this.rememberFailure(identity, error);
      this.fail(response, error, identity === null);
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
        if (failures.length) this.rememberFailure(identity, new ControlCleanupError(failures));
      }
      signal.removeEventListener("abort", interrupt);
      request.off("aborted", disconnected);
      response.off("close", disconnected);
      this.originals.delete(original);
      original.joined.resolve();
    }
  }

  private rememberFailure(identity: ExecutionIdentity | null, error: unknown): void {
    const failures = this.failures.get(identity) ?? [];
    failures.push(error);
    // Retain the failure's scope, not the completed HTTP request and body.
    this.failures.set(identity, failures);
  }

  private async relaySettlement(
    response: ServerResponse,
    target: SettlementContext,
    input: AgentSettlementRequest,
    parent: AbortSignal,
  ): Promise<void> {
    const member = this.options.peers.membership.members.find(
      (entry) => entry.member_id === target.target.member_id,
    );
    if (member === undefined) throw new Error("Settlement owner is unavailable");
    // Business work retains its original deadline at the owner. A bounded,
    // absolute completion window lets its joined cleanup outcome reach ingress.
    const deadline = Date.parse(input.deadline_at) + SETTLEMENT_COMPLETION_WINDOW_MS;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PeerDeadlineError("Settlement completion deadline expired");
    const cancellation = new AbortController();
    const signal = AbortSignal.any([parent, cancellation.signal]);
    const timer = setTimeout(
      () => cancellation.abort(new PeerDeadlineError("Settlement completion deadline expired")),
      Math.min(remaining, 2_147_483_647),
    );
    timer.unref();
    let upstream: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    let closed: Promise<void> | undefined;
    let cancelling: Promise<void> | undefined;
    let raw: Buffer | undefined;
    let primary: unknown;
    let failed = false;
    let cleanupFailures: unknown[];
    const cancel = () => {
      if (reader === undefined) return;
      cancelling ??= Promise.resolve().then(() => reader!.cancel());
      void cancelling.catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      upstream = await this.options.peers.fetchFor(member.member_id)(
        new URL(OWNER_CONTROL_PATHS.settlement, member.origin),
        {
          method: "POST",
          signal,
          redirect: "error",
          headers: {
            "content-type": "application/json",
            [OWNER_FORWARD_HEADER]: encodeOwnerControl(target),
          },
          body: JSON.stringify(input),
        },
      );
      if (upstream.body !== null) {
        reader = upstream.body.getReader();
        closed = reader.closed;
        void closed.catch(() => undefined);
      }
      signal.throwIfAborted();
      if (
        reader === undefined ||
        !/^application\/json(?:\s*;|$)/iu.test(upstream.headers.get("content-type") ?? "") ||
        (upstream.status !== 200 && (upstream.status < 400 || upstream.status > 599))
      )
        throw new Error("Invalid settlement response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        reading = reader.read();
        const next = await reading;
        reading = undefined;
        signal.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65536) throw new Error("Settlement response exceeds its limit");
        chunks.push(next.value);
      }
      raw = Buffer.concat(chunks);
      const parsed = strictObject(raw);
      if (
        upstream.status === 200 &&
        agentSettlementResultSchema.parse(parsed).applied_revision < input.minimum_revision
      )
        throw new Error("Settlement response is stale");
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      cancel();
      const joined = await Promise.allSettled([reading, closed, cancelling]);
      signal.removeEventListener("abort", cancel);
      cleanupFailures = joined.flatMap((result) =>
        result.status === "rejected" &&
        !(failed && result.reason === primary) &&
        !cancelled(result.reason)
          ? [result.reason as unknown]
          : [],
      );
      try {
        reader?.releaseLock();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      if (cleanupFailures.length)
        throw new ControlCleanupError(failed ? [primary, ...cleanupFailures] : cleanupFailures);
      if (failed) throw primary;
      signal.throwIfAborted();
      if (Date.now() >= deadline)
        throw new PeerDeadlineError("Settlement completion deadline expired");
      if (upstream === undefined || raw === undefined)
        throw new Error("Settlement response is unavailable");
      for (const name of ["content-type", "cache-control", "retry-after", "www-authenticate"]) {
        const value = upstream.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      response.writeHead(upstream.status);
      await writeStateChunk(response, raw, signal, this.options.deliveryTimeoutMs);
      await finishResponse(response, signal, this.options.deliveryTimeoutMs);
    } finally {
      clearTimeout(timer);
      cancellation.abort();
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

  private fail(response: ServerResponse, error: unknown, settlement = false) {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (settlement) {
      this.sendFailure(response, settlementError(error));
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
