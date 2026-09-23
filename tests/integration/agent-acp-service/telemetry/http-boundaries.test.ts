import { createServer, type Server } from "node:http";
import { context, propagation, SpanKind, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { configureBoundaries } from "../../../../services/agent-acp-service/src/telemetry/diagnostics.js";
import {
  observeHttpRequest,
  tracedFetch,
} from "../../../../services/agent-acp-service/src/telemetry/http.js";

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer("acp-contract-test");
let server: Server | undefined;

beforeAll(() =>
  provider.register({ propagator: new core.W3CTraceContextPropagator() }),
);
beforeEach(() => {
  exporter.reset();
  configureBoundaries({ captureRpcContent: true, disabled: false });
});
afterEach(async () => {
  configureBoundaries({ captureRpcContent: false, disabled: false });
  if (server !== undefined) {
    const closing = server;
    await new Promise<void>((resolve, reject) => {
      closing.close((error) => (error ? reject(error) : resolve()));
      closing.closeAllConnections();
    });
    server = undefined;
  }
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("HTTP boundary contract", () => {
  it("injects the actual CLIENT and retains a successful health SERVER parent", async () => {
    server = createServer((request, response) => {
      void observeHttpRequest(request, response, () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ready"}');
        return Promise.resolve();
      });
    });
    const url = await listen(server);
    const parent = tracer.startSpan("caller");
    const response = await context.with(
      trace.setSpan(context.active(), parent),
      () =>
        tracedFetch(fetch, "agent-acp-service")(`${url}/status`, {
          headers: {
            authorization: "header-canary",
            baggage: "secret=baggage-canary",
          },
        }),
    );
    expect(await response.json()).toEqual({ status: "ready" });
    parent.end();
    await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(3));
    const spans = exporter.getFinishedSpans();
    const client = spans.find((span) => span.kind === SpanKind.CLIENT)!;
    const received = spans.find((span) => span.kind === SpanKind.SERVER)!;
    expect(client.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(received.parentSpanContext?.spanId).toBe(
      client.spanContext().spanId,
    );
    expect(received.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(received.name).toBe("HTTP GET /status");
    expect(received.attributes["http.route"]).toBe("/status");
    expect(received.events).toHaveLength(0);
    expect(client.events).toHaveLength(0);
    expect(
      Object.keys(received.attributes).some((key) => key.includes(".header.")),
    ).toBe(false);
    expect(serializedSpans()).not.toContain("canary");
  });

  it("preserves incoming context without exporting or leaking baggage when disabled", async () => {
    configureBoundaries({ captureRpcContent: false, disabled: true });
    const incoming = "00-11111111111111111111111111111111-2222222222222222-01";
    let forwarded: Headers | undefined;
    server = createServer((request, response) => {
      void observeHttpRequest(request, response, async () => {
        await tracedFetch((_input, init) => {
          forwarded = new Headers(init.headers);
          return Promise.resolve(new Response(null, { status: 204 }));
        }, "model")("https://model.test", {
          headers: {
            authorization: "provider-canary",
            baggage: "secret=baggage-canary",
          },
        });
        response.end("unchanged");
      });
    });
    const response = await fetch(`${await listen(server)}/status`, {
      headers: { traceparent: incoming, tracestate: "test=value" },
    });
    expect(await response.text()).toBe("unchanged");
    expect(forwarded?.get("traceparent")).toBe(incoming);
    expect(forwarded?.get("tracestate")).toBe("test=value");
    expect(forwarded?.get("authorization")).toBe("provider-canary");
    expect(forwarded?.has("baggage")).toBe(false);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function serializedSpans(): string {
  return JSON.stringify(
    exporter.getFinishedSpans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
      context: span.spanContext(),
      parent: span.parentSpanContext,
      links: span.links,
      resource: span.resource.attributes,
    })),
  );
}
