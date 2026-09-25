import { ReplayCapacityError } from "../bridge/replay-load-gate.ts";
import { AgentAccessRevokedError } from "../adapters/acp-http.ts";
import { OperationReconciliationTimeoutError } from "../bridge/operations.ts";
import { encodedStreamFrame, StreamCapacityError, type StreamEvent } from "../bridge/stream-journal.ts";
import type { BridgeScope } from "../bridge/registry.ts";
import { bridgeCapacityResponse, error, missingSessionResponse, trustedScope } from "./command-routes.ts";

const prefix = "/api/app/workspace/v1/agents/";
const heartbeatMs = 15_000;
const encoder = new TextEncoder();

type Subscription = {
  events: AsyncIterableIterator<StreamEvent<unknown>>;
  release(): void;
};

export function createEventHandler(dependencies: {
  subscribe(
    scope: BridgeScope,
    sessionId: string | null,
    cursor: string | null,
  ): Promise<Subscription>;
}): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix)) return null;
    const suffix = url.pathname.slice(prefix.length).split("/");
    if (suffix.length !== 2 || suffix[1] !== "events") return null;
    let agentId: string;
    try {
      agentId = decodeURIComponent(suffix[0]!);
    } catch {
      return error(422, "invalid_request", "Agent ID is invalid", "none");
    }
    if (
      request.method !== "GET" ||
      agentId.length < 1 ||
      agentId.length > 200 ||
      /[/\\\x00-\x1f]/u.test(agentId)
    )
      return error(422, "invalid_request", "Event request is invalid", "none");
    const scope = trustedScope(request);
    if (scope === null)
      return error(
        401,
        "unauthenticated",
        "Trusted identity is missing",
        "login",
      );
    if (scope.agentId !== agentId)
      return error(403, "access_denied", "Agent access denied", "none");
    const sessions = url.searchParams.getAll("sessionId");
    const queryCursors = url.searchParams.getAll("cursor");
    const sessionId = sessions[0] ?? null;
    const cursor =
      request.headers.get("last-event-id") ?? queryCursors[0] ?? null;
    if (
      sessions.length > 1 ||
      (sessionId !== null && (
        sessionId.length < 1 ||
        sessionId.length > 200 ||
        /[/\\\x00-\x1f]/u.test(sessionId)
      )) ||
      queryCursors.length > 1 ||
      (cursor !== null && (cursor.length < 1 || cursor.length > 4096))
    )
      return error(422, "invalid_request", "Event request is invalid", "none");
    let subscription: Subscription;
    try {
      subscription = await dependencies.subscribe(scope, sessionId, cursor);
    } catch (cause) {
      const capacity = bridgeCapacityResponse(cause);
      if (capacity !== null) return capacity;
      const missing = missingSessionResponse(cause);
      if (missing !== null) return missing;
      if (cause instanceof OperationReconciliationTimeoutError)
        return error(504, "workspace_deadline_exceeded", "Operation reconciliation timed out", "retry_read");
      if (cause instanceof AgentAccessRevokedError)
        return error(403, "access_denied", "Agent access denied", "none");
      if (cause instanceof ReplayCapacityError)
        return error(
          429,
          "replay_capacity_exceeded",
          "Concurrent replay queue is full",
          "retry_read",
        );
      if (cause instanceof StreamCapacityError)
        return error(429, "stream_capacity_exceeded", "Workspace stream exceeds Bridge capacity", "retry_read");
      return error(
        503,
        "history_unavailable",
        "Session events are unavailable",
        "retry_read",
      );
    }
    const { events, release } = subscription;
    let closed = false;
    let pending = events.next();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      request.signal.removeEventListener("abort", abort);
      void events.return?.();
      release();
    };
    const abort = () => {
      close();
      try {
        controller?.close();
      } catch {
        // The stream may already have been cancelled by the HTTP adapter.
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      },
      async pull(value) {
        if (closed) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          pending.then((event) => ({ type: "event" as const, event })),
          new Promise<{ type: "heartbeat" }>((resolve) => {
            timer = setTimeout(
              () => resolve({ type: "heartbeat" }),
              heartbeatMs,
            );
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (closed) return;
        if (result.type === "heartbeat") {
          value.enqueue(encoder.encode(": heartbeat\n\n"));
          return;
        }
        if (result.event.done) {
          close();
          value.close();
          return;
        }
        pending = events.next();
        const event = result.event.value;
        value.enqueue(encodedStreamFrame(event));
      },
      cancel() {
        close();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  };
}
