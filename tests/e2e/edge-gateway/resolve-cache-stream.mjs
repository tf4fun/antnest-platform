import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import {
  initialBridgeStream,
  applyBridgeEvent,
} from "../../../services/agent-ui/web/src/lib/bridge-stream.ts";

// One real transport for the entire observation. A revision gap or bad scope
// fails instead of fetching a replacement snapshot that could hide an outage.
export async function observeWorkspaceStream(
  client,
  agentID,
  sessionID,
  signal,
  { credentialScope, requireTrace = true } = {},
) {
  signal?.throwIfAborted();
  const stop = new AbortController();
  const combined = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
  const closed = Promise.withResolvers();
  const cookie = client.cookie;
  const path = `/api/app/workspace/v1/agents/${encodeURIComponent(agentID)}/events?sessionId=${encodeURIComponent(sessionID)}`;
  const evidence = {
    started_at: performance.now(),
    started_at_ms: Date.now(),
    frames: [],
    events: [],
    path,
    ...(credentialScope ? { credential_scope: credentialScope(cookie) } : {}),
  };
  const records = [];
  let state = initialBridgeStream(agentID, sessionID);
  let response,
    reader,
    pump,
    closure,
    failure,
    revoked,
    cancellation,
    closing,
    readFailure,
    readFailed = false;
  const cleanupErrors = [];
  const cancelReader = () =>
    (cancellation ??= (async () => {
      try {
        await reader.cancel();
        evidence.reader_cleanup = { outcome: "cancelled" };
      } catch (error) {
        // Cancelling an already errored stream rethrows that same read failure.
        // Preserve it as a transport receipt; a new cancellation error is fatal.
        const alreadyEnded =
          readFailed &&
          error === readFailure &&
          (combined.aborted || closure?.kind === "transport-end");
        evidence.reader_cleanup = {
          outcome: alreadyEnded ? "already-terminated" : "failed",
          error: {
            name: error?.name ?? "Error",
            message: error?.message ?? String(error),
          },
        };
        if (!alreadyEnded) cleanupErrors.push(error);
      }
    })());
  const finish = (kind) => {
    if (closure) return;
    closure = Object.freeze({
      kind,
      at: performance.now(),
      observed_at_ms: Date.now(),
      trace_id: evidence.trace_id,
    });
    closed.resolve(closure);
  };
  const interrupted = () => finish("aborted");
  signal?.addEventListener("abort", interrupted, { once: true });
  const timer = setTimeout(
    () => stop.abort(new Error("Workspace SSE admission timed out")),
    10000,
  );
  try {
    response = await fetch(`${client.base}${path}`, {
      headers: { Cookie: cookie, Origin: gatewayOrigin(client.base) },
      signal: combined,
    });
    clearTimeout(timer);
    evidence.status = response.status;
    evidence.trace_id = response.headers.get("x-antnest-trace-id");
    evidence.headers_at = performance.now();
    evidence.server_date = response.headers.get("date");
    evidence.set_cookie_count = response.headers.getSetCookie().length;
    assert.equal(response.status, 200, "Workspace SSE admission failed");
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/event-stream\b/u,
    );
    if (requireTrace)
      assert.match(
        evidence.trace_id ?? "",
        /^[a-f0-9]{32}$/u,
        "actual Workspace Trace missing",
      );
    assert.equal(
      response.headers.getSetCookie().length,
      0,
      "Workspace SSE renewed a session",
    );
    reader = response.body.getReader();
    pump = (async () => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "",
        bytes = 0;
      try {
        for (;;) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (error) {
            readFailed = true;
            readFailure = error;
            if (!combined.aborted) finish("transport-end");
            return;
          }
          if (chunk.done) {
            if (!combined.aborted) {
              buffer += decoder.decode();
              assert(!buffer.trim(), "Workspace event ended mid-frame");
              finish("remote-end");
            }
            return;
          }
          bytes += chunk.value.byteLength;
          assert(
            bytes <= 8 * 1024 * 1024,
            "Workspace event archive capacity exceeded",
          );
          const raw = decoder.decode(chunk.value, { stream: true });
          evidence.frames.push({ at: performance.now(), raw });
          buffer = (buffer + raw).replace(/\r\n/gu, "\n");
          assert(
            buffer.length <= 256 * 1024,
            "Workspace event frame capacity exceeded",
          );
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = frame.split("\n");
            const dataLines = lines.filter(
              (line) => line === "data" || line.startsWith("data:"),
            );
            if (!dataLines.length) continue;
            const data = dataLines
              .map((line) => line.slice(5).replace(/^ /u, ""))
              .join("\n");
            const event = JSON.parse(data),
              at = performance.now();
            const names = lines
              .filter((line) => line.startsWith("event:"))
              .map((line) => line.slice(6).replace(/^ /u, ""));
            assert.equal(
              names.length,
              1,
              "Workspace event must have one named event field",
            );
            assert(
              ["snapshot", "reset", "delta", "access_revoked"].includes(
                names[0],
              ),
              "Workspace event name is unsupported",
            );
            assert.equal(
              names[0],
              event.type,
              "Workspace event name and payload type mismatch",
            );
            assert.equal(
              event.agentId,
              agentID,
              "Workspace event Agent scope mismatch",
            );
            const next = applyBridgeEvent(state, event);
            assert(
              next.action !== "refresh",
              "Workspace event requires a replacement snapshot",
            );
            assert(
              next.action !== "revoke" || event.type === "access_revoked",
              "Workspace event invalid revocation",
            );
            state = next.state;
            const record = { at, raw: event, action: next.action };
            evidence.events.push(record);
            assert(
              evidence.events.length <= 2048,
              "Workspace event count exceeded",
            );
            if (next.action === "revoke") revoked ??= record;
            if (next.action === "view") records.push({ at, view: state.view });
          }
        }
      } catch (error) {
        failure = new Error("Workspace event validation failed", {
          cause: error,
        });
        finish("invalid-event");
        stop.abort(failure);
      } finally {
        await cancelReader();
        try {
          reader.releaseLock();
        } catch (error) {
          cleanupErrors.push(error);
        }
        signal?.removeEventListener("abort", interrupted);
      }
    })();
  } catch (error) {
    const errors = [error];
    try {
      await response?.body?.cancel();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    stop.abort(error);
    signal?.removeEventListener("abort", interrupted);
    if (errors.length > 1)
      throw new AggregateError(
        errors,
        "Workspace admission and cleanup failed",
      );
    throw errors[0];
  } finally {
    clearTimeout(timer);
  }
  return {
    evidence,
    records,
    get view() {
      return state.view;
    },
    get closure() {
      return closure;
    },
    get revoked() {
      return revoked;
    },
    assertOpen() {
      if (failure) throw failure;
      signal?.throwIfAborted();
      assert(!revoked, "Workspace access revoked");
      assert(!closure && state.view, "Workspace stream is not live");
    },
    async wait(predicate, { after = 0, timeoutMS = 15000 } = {}) {
      const deadline = performance.now() + timeoutMS;
      do {
        if (failure) throw failure;
        signal?.throwIfAborted();
        const found = records
          .slice(after)
          .find((record) => predicate(record.view, record));
        if (found) return found;
        assert(
          !closure && !revoked,
          "Workspace stream ended before expected output",
        );
        await delay(10, undefined, { signal });
      } while (performance.now() < deadline);
      throw new Error("Workspace output observation timed out");
    },
    async waitClosed(timeoutMS = 30000) {
      let timeout;
      try {
        return await Promise.race([
          closed.promise,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Workspace remote close timed out")),
              timeoutMS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
    closeAndWait() {
      return (closing ??= (async () => {
        finish("local-close");
        const cancelled = cancelReader();
        stop.abort(new Error("Workspace observer closed"));
        await cancelled;
        await pump;
        const errors = [...(failure ? [failure] : []), ...cleanupErrors];
        if (errors.length > 1)
          throw new AggregateError(
            errors,
            "Workspace observation and cleanup failed",
          );
        if (errors.length) throw errors[0];
        evidence.joined = {
          at: performance.now(),
          observed_at_ms: Date.now(),
        };
        return closure;
      })());
    },
  };
}
