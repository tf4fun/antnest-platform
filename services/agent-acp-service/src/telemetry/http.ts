import type { IncomingMessage, ServerResponse } from "node:http";
import {
  context,
  createContextKey,
  INVALID_SPAN_CONTEXT,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { boundaryConfig, recordBoundaryError } from "./diagnostics.js";

const HTTP_BOUNDARY = createContextKey("antnest.acp.http-boundary");
type HttpScope = { span: Span; active: boolean };
export function activeHttpSpan(): Span | undefined {
  const scope = context.active().getValue(HTTP_BOUNDARY) as HttpScope | undefined;
  return scope?.active === true ? scope.span : undefined;
}

export function extractedContext(headers: Record<string, unknown>): Context {
  return propagation.extract(ROOT_CONTEXT, headers, {
    keys: () => ["traceparent", "tracestate"],
    get: (carrier, key) => {
      if (key !== "traceparent" && key !== "tracestate") return undefined;
      const value = carrier[key];
      return typeof value === "string" && value.length <= 512 ? value : undefined;
    },
  });
}

export function startHttpBoundary(request: IncomingMessage): {
  span: Span;
  context: Context;
  finish: (status?: number, error?: unknown) => void;
} {
  const route = [
    "/status",
    "/v1/acp",
    "/v2/acp",
    "/rpc/agent-acp/apply-execution-snapshot",
    "/rpc/agent-acp/settle-agent",
    "/rpc/agent-acp/get-agent-execution-state",
    "/rpc/agent-acp/watch-agent-execution-state",
    "/rpc/agent-acp/list-execution-audits",
    "/rpc/agent-acp/get-execution-audit",
    "/rpc/agent-acp/list-execution-events",
  ].includes(request.url ?? "")
    ? request.url!
    : "unmatched";
  const method = request.method ?? "GET";
  const parent = extractedContext(request.headers);
  const span = boundaryConfig().disabled
    ? trace.wrapSpanContext(trace.getSpanContext(parent) ?? INVALID_SPAN_CONTEXT)
    : trace.getTracer("agent-acp-service").startSpan(
        `HTTP ${method} ${route}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            "http.request.method": method,
            "http.route": route,
          },
        },
        parent,
      );
  const scope = { span, active: true };
  return {
    span,
    context: trace.setSpan(parent, span).setValue(HTTP_BOUNDARY, scope),
    finish: (status, error) => {
      if (!scope.active) return;
      scope.active = false;
      if (status !== undefined) {
        span.setAttribute("http.response.status_code", status);
        if (status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute("antnest.outcome", "error");
        } else if (status >= 400) span.setAttribute("antnest.outcome", "rejected");
      }
      if (error !== undefined) recordBoundaryError(span, error, "http.receive");
      span.end();
    },
  };
}

export function observeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  operation: () => Promise<void>,
): Promise<void> {
  const boundary = startHttpBoundary(request);
  const completed = () => {
    boundary.finish(response.headersSent ? response.statusCode : undefined);
  };
  response.once("finish", completed);
  response.once("close", () => {
    if (response.writableFinished) return;
    boundary.span.setAttributes({
      "antnest.outcome": "disconnected",
      "error.type": "stream_interrupted",
    });
    boundary.span.setStatus({ code: SpanStatusCode.ERROR });
    boundary.finish(response.headersSent ? response.statusCode : undefined);
  });
  response.once("error", (error) =>
    boundary.finish(response.headersSent ? response.statusCode : undefined, error),
  );
  return context.with(boundary.context, async () => {
    try {
      await operation();
    } catch (error) {
      boundary.finish(response.headersSent ? response.statusCode : undefined, error);
      response.destroy(error instanceof Error ? error : undefined);
    }
  });
}

export function tracedFetch<Input extends string | URL | Request, Init extends RequestInit>(
  send: (input: Input, init: Init) => Promise<Response>,
  peer: string,
): (input: Input, init: Init) => Promise<Response> {
  return async (input, init) => {
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.delete("baggage");
    if (boundaryConfig().disabled) {
      injectHeaders(headers, context.active());
      return send(input, { ...init, headers });
    }
    const span = trace.getTracer("agent-acp-service").startSpan(`HTTP ${method} ${peer}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "peer.service": peer,
      },
    });
    try {
      const target = new URL(input instanceof Request ? input.url : input);
      span.setAttributes({
        "server.address": target.hostname,
        "server.port":
          target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port),
      });
    } catch {
      // The actual fetch remains responsible for invalid target errors.
    }
    const clientContext = trace.setSpan(propagation.deleteBaggage(context.active()), span);
    injectHeaders(headers, clientContext);
    let ended = false;
    let observed = 0;
    const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    const onAbort = () => {
      span.setAttribute("http.response.body.size", observed);
      finish(signal?.reason, "cancelled");
    };
    const finish = (error?: unknown, outcome?: string) => {
      if (ended) return;
      ended = true;
      signal?.removeEventListener("abort", onAbort);
      if (outcome !== undefined) span.setAttribute("antnest.outcome", outcome);
      if (error !== undefined) recordBoundaryError(span, error, "http.send_or_read");
      span.end();
    };
    let response: Response;
    try {
      response = await context.with(clientContext, () => send(input, { ...init, headers }));
    } catch (error) {
      finish(error);
      throw error;
    }
    span.setAttributes({
      "http.response.status_code": response.status,
    });
    if (response.status >= 400) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute("antnest.outcome", "http_error");
    }
    if (response.body === null) {
      finish();
      return response;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const chunk = await context.with(clientContext, () => reader.read());
            if (chunk.done) {
              span.setAttribute("http.response.body.size", observed);
              reader.releaseLock();
              finish();
              controller.close();
            } else {
              observed += chunk.value.byteLength;
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            span.setAttribute("http.response.body.size", observed);
            reader.releaseLock();
            finish(error);
            controller.error(error);
          }
        },
        cancel: async (reason: unknown) => {
          try {
            await reader.cancel(reason);
          } catch (error) {
            finish(error);
            throw error;
          } finally {
            reader.releaseLock();
            span.setAttribute("http.response.body.size", observed);
            finish(undefined, "body_closed");
          }
        },
      },
      { highWaterMark: 0 },
    );
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return wrapped;
  };
}

function injectHeaders(headers: Headers, parent: Context): void {
  const carrier: Record<string, string> = {};
  propagation.inject(propagation.deleteBaggage(parent), carrier);
  for (const key of ["traceparent", "tracestate"]) {
    headers.delete(key);
    const value = carrier[key];
    if (value !== undefined) headers.set(key, value);
  }
}
