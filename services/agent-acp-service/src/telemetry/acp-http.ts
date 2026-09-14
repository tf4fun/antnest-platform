import { isSpanContextValid, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { activeHttpSpan } from "./http.js";
import { boundaryConfig } from "./diagnostics.js";

// The SDK queues messages across HTTP requests. Carry the receiving span through
// standard ACP metadata instead of relying on the queue's async-local context.
export class TracedAcpHttpServer extends AcpServer {
  public override async handleRequest(
    request: Request,
    options?: Parameters<AcpServer["handleRequest"]>[1],
  ): Promise<Response> {
    const span = activeHttpSpan();
    if (
      span === undefined ||
      !isSpanContextValid(span.spanContext()) ||
      boundaryConfig().disabled ||
      request.method !== "POST"
    )
      return super.handleRequest(request, options);

    let message: unknown;
    try {
      message = await request.clone().json();
    } catch {
      // Invalid protocol input remains the SDK's responsibility.
      return super.handleRequest(request, options);
    }
    if (
      !object(message) ||
      typeof message.method !== "string" ||
      !object(message.params) ||
      (message.params._meta != null && !object(message.params._meta))
    )
      return super.handleRequest(request, options);

    const carrier: Record<string, string> = {};
    propagation.inject(trace.setSpan(ROOT_CONTEXT, span), carrier);
    const metadata = { ...message.params._meta };
    delete metadata.traceparent;
    delete metadata.tracestate;
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const body = JSON.stringify({
      ...message,
      params: { ...message.params, _meta: { ...metadata, ...carrier } },
    });
    return super.handleRequest(new Request(request, { headers, body }), options);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
