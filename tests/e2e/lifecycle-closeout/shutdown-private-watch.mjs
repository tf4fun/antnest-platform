import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import schema from "../../../contracts/agent-acp/agent-execution-state.schema.json" with { type: "json" };
import { until } from "../workspace-closeout/state.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const { createParser } = require("eventsource-parser");
const validateState = new Ajv2020({ strict: false }).compile(schema);
const path = "/rpc/agent-acp/watch-agent-execution-state";
const terminal = {
  code: "execution_state_unavailable",
  message: "Agent execution state is unavailable",
  retryable: true,
};

function failure(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) return unique[0];
  if (unique.length)
    return new AggregateError(
      unique,
      "Shutdown private watch, evidence or cleanup failed",
    );
}

export async function openShutdownPrivateWatch(agentId, browser, options) {
  const {
    principal: incomingPrincipal,
    service,
    telemetry,
    endpoint,
    signal,
    secrets,
    preserve,
    fetchImpl = fetch,
  } = options;
  const principal = structuredClone(incomingPrincipal);
  signal?.throwIfAborted();
  assert.equal(typeof preserve, "function", "private watch archive required");
  assert(Array.isArray(secrets));
  assert(typeof agentId === "string" && agentId.length > 0);
  const target = new URL(endpoint);
  assert(
    ["http:", "https:"].includes(target.protocol) &&
      target.pathname === path &&
      !target.username &&
      !target.password &&
      !target.search &&
      !target.hash,
    "invalid private state watch endpoint",
  );
  for (const field of ["organization_id", "user_id"])
    assert(
      typeof principal?.[field] === "string" && principal[field].length > 0,
      "original Principal required",
    );
  const accessToken = browser.accessToken;
  assert(
    typeof accessToken === "string" && accessToken.length > 0,
    "original browser Session required",
  );
  secrets.push(accessToken);
  const issued = await service.workspaceContext(accessToken, agentId, {
    signal,
  });
  secrets.push(issued.context);
  signal?.throwIfAborted();
  for (const field of ["organization_id", "user_id"])
    assert.equal(
      issued.principal[field],
      principal[field],
      "workspace authority changed",
    );
  const headers = service.authorization("agent-ui-acp");
  const grant = headers["Antnest-Service-Authorization"];
  assert(
    typeof grant === "string" && grant.startsWith("Bearer "),
    "private workload grant required",
  );
  secrets.push(grant, grant.slice(7));
  const operation = telemetry.startHTTP("POST");
  const ownAbort = new AbortController();
  const bounded = signal
    ? AbortSignal.any([signal, ownAbort.signal])
    : ownAbort.signal;
  const localReason = new Error("Shutdown state watch closed locally");
  const first = Promise.withResolvers();
  void first.promise.catch(() => {});
  const events = [],
    terminalEvents = [],
    chunks = [],
    errors = [];
  let response,
    reader,
    closure,
    bytes = 0,
    joined = false,
    settled = false,
    bodyOutcome = "failed",
    originalFailure;
  const observe = (kind) => {
    closure ??= Object.freeze({
      kind,
      traceID: operation.traceID,
      clientSpanID: operation.clientSpanID,
      observedAt: Date.now(),
      receivedEvents: events.length,
    });
    return closure;
  };
  const snapshot = () =>
    structuredClone({
      agentId,
      principal,
      session_digest: createHash("sha256").update(accessToken).digest("hex"),
      method: "POST",
      path,
      request_body: {},
      traceID: operation.traceID,
      clientSpanID: operation.clientSpanID,
      status: response?.status,
      content_type: response?.headers.get("content-type"),
      response_trace_id: response?.headers.get("x-antnest-trace-id"),
      events,
      terminal_events: terminalEvents,
      closure,
      body_outcome: bodyOutcome,
      body_bytes: bytes,
      raw_body_base64: Buffer.concat(chunks).toString("base64"),
      joined,
      errors: [...new Set(errors)].map((error) => inspect(error, { depth: 8 })),
    });
  const close = () => {
    if (settled || closure) return;
    observe("local-close");
    ownAbort.abort(localReason);
  };
  const abort = () => {
    errors.push(signal.reason);
    observe("global-abort");
    ownAbort.abort(signal.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const localAbortError = (error) =>
    closure?.kind === "local-close" && error === localReason;
  const parser = createParser({
    onEvent(event) {
      assert.equal(
        event.id,
        undefined,
        "private state watch must not add replay cursors",
      );
      assert.equal(
        terminalEvents.length,
        0,
        "private state watch continued after its terminal event",
      );
      const value = JSON.parse(event.data);
      if (event.event === "workspace_state") {
        assert(
          validateState(value),
          "invalid complete private execution state schema",
        );
        assert.equal(
          value.agent_id,
          agentId,
          "foreign private execution state Agent",
        );
        events.push(value);
        assert(events.length < 100, "unbounded private state watch events");
        first.resolve(value);
      } else {
        assert.equal(
          event.event,
          "workspace_error",
          "unknown private execution state event",
        );
        assert(
          events.length > 0,
          "private state watch failed before its initial state",
        );
        assert.deepEqual(
          value,
          terminal,
          "invalid private state terminal event",
        );
        terminalEvents.push(value);
      }
    },
    onError(error) {
      throw error;
    },
    onRetry() {
      throw new Error("private state watch must not request reconnection");
    },
  });
  const completed = (async () => {
    try {
      response = await fetchImpl(target.href, {
        method: "POST",
        redirect: "manual",
        body: "{}",
        signal: bounded,
        headers: {
          ...headers,
          "Antnest-Caller-Context": issued.context,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          traceparent: operation.traceparent,
        },
      });
      const validResponse =
        response.status === 200 &&
        /^text\/event-stream(?:\s*;|$)/iu.test(
          response.headers.get("content-type") ?? "",
        );
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "";
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        chunks.push(chunk);
        bytes += chunk.length;
        assert(
          bytes <= 1024 * 1024,
          "private state watch response exceeds its evidence bound",
        );
        if (validResponse) {
          const decoded = decoder.decode(chunk, { stream: true });
          text += decoded;
          try {
            parser.feed(decoded);
          } catch (error) {
            observe("invalid-event");
            throw error;
          }
        }
      }
      bounded.throwIfAborted();
      if (!validResponse) {
        observe("invalid-response");
        throw new Error("invalid private state watch HTTP response");
      }
      text += decoder.decode();
      assert(
        text.endsWith("\n\n") || text.endsWith("\r\n\r\n"),
        "incomplete private state watch frame",
      );
      assert(
        events.length > 0,
        "private state watch ended without an initial state",
      );
      bodyOutcome = "eof";
      observe("transport-end");
    } catch (error) {
      if (localAbortError(error)) bodyOutcome = "cancelled";
      else {
        errors.push(error);
        if (signal?.aborted) {
          errors.push(signal.reason);
          observe("global-abort");
          bodyOutcome = "cancelled";
        } else observe("transport-error");
      }
    } finally {
      if (reader) {
        try {
          await reader.cancel();
        } catch (error) {
          if (!localAbortError(error)) errors.push(error);
        }
        try {
          reader.releaseLock();
        } catch (error) {
          errors.push(error);
        }
      }
      if (signal?.aborted) errors.push(signal.reason);
      signal?.removeEventListener("abort", abort);
      try {
        operation.end(response?.status, bodyOutcome, bytes);
      } catch (error) {
        errors.push(error);
      }
      joined = true;
      try {
        await preserve(snapshot());
      } catch (error) {
        errors.push(error);
      }
      settled = true;
      originalFailure = failure(errors);
      if (events.length === 0)
        first.reject(
          originalFailure ??
            new Error("private state watch closed before initial delivery"),
        );
    }
  })();
  return {
    get traceID() {
      return operation.traceID;
    },
    get clientSpanID() {
      return operation.clientSpanID;
    },
    get events() {
      return structuredClone(events);
    },
    get closure() {
      return closure;
    },
    snapshot,
    ready: async () => structuredClone(await first.promise),
    assertOpen() {
      if (originalFailure) throw originalFailure;
      assert(!closure && events.length > 0, "private state watch is not live");
    },
    async waitClosed() {
      await until(() => settled, "private state watch closure", undefined);
      await completed;
      if (originalFailure) throw originalFailure;
      assert.equal(
        closure?.kind,
        "transport-end",
        "private state watch was closed by the test",
      );
      return closure;
    },
    close,
    async closeAndWait() {
      close();
      await completed;
      if (originalFailure) throw originalFailure;
      return snapshot();
    },
  };
}
