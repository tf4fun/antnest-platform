import { createServer, type Server, type ServerResponse } from "node:http";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { configureBoundaries } from "../../../../services/agent-acp-service/src/telemetry/diagnostics.js";
import {
  observeHttpRequest,
  tracedFetch,
} from "../../../../services/agent-acp-service/src/telemetry/http.js";
import {
  applyExecutionConfiguration,
  EXECUTION_CONFIGURATION_PATH,
} from "../../../../services/agent-acp-service/src/transport/execution-configuration.js";

const exporter = new tracing.InMemorySpanExporter();
let events: string[] = [];
const provider = new node.NodeTracerProvider({
  spanProcessors: [
    {
      onStart() {},
      onEnd(span) {
        if (span.kind === SpanKind.SERVER) events.push("server_span_ended");
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    new tracing.SimpleSpanProcessor(exporter),
  ],
});
let server: Server | undefined;
let release: (() => void) | undefined;
let abort: AbortController;
let pending: Promise<unknown>[] = [];

beforeAll(() =>
  provider.register({ propagator: new core.W3CTraceContextPropagator() }),
);
beforeEach(() => {
  exporter.reset();
  events = [];
  pending = [];
  abort = new AbortController();
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterEach(async () => {
  // Release test-only barriers even when an assertion fails, then join all work.
  release?.();
  abort.abort();
  await Promise.allSettled(pending);
  if (server !== undefined) {
    const closing = server;
    await new Promise<void>((resolve, reject) => {
      closing.close((error) => (error ? reject(error) : resolve()));
      closing.closeAllConnections();
    });
    server = undefined;
  }
  release = undefined;
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

it.each(["success", "failure"] as const)(
  "keeps the real HTTP SERVER open until configuration apply settles: %s",
  async (outcome) => {
    const entered = Promise.withResolvers<void>();
    const permit = Promise.withResolvers<void>();
    release = () => permit.resolve();
    let responseAtApply: ServerResponse | undefined;
    let received: unknown;
    let receivedHeaders = false;
    server = createServer((request, response) => {
      responseAtApply = response;
      response.once("finish", () => events.push("response_finish"));
      const operation = observeHttpRequest(
        request,
        response,
        () =>
          applyExecutionConfiguration(
            request,
            response,
            {
              async apply(input) {
                received = input;
                events.push("apply_enter");
                entered.resolve();
                await permit.promise;
                events.push("apply_settled");
                if (outcome === "failure")
                  throw new Error("controlled apply failure");
                return { organization_id: "org1", applied_revision: 7 };
              },
            },
            1024,
          ),
        "control",
      );
      pending.push(operation);
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No TCP address");
    const exchange = tracedFetch(fetch, "agent-acp-service")(
      `http://127.0.0.1:${address.port}${EXECUTION_CONFIGURATION_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organization_id: "org1", revision: 7 }),
        signal: abort.signal,
      },
    ).then(async (response) => {
      receivedHeaders = true;
      const body: unknown = await response.json();
      return { status: response.status, body };
    });
    pending.push(exchange);
    // Attach a rejection handler immediately; the awaited original still fails.
    void exchange.catch(() => {});

    await entered.promise;
    expect(received).toEqual({ organization_id: "org1", revision: 7 });
    expect(responseAtApply?.headersSent).toBe(false);
    expect(receivedHeaders).toBe(false);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    permit.resolve();
    const result = await exchange;
    expect(result.status).toBe(outcome === "success" ? 200 : 503);
    if (outcome === "success")
      expect(result.body).toEqual({
        organization_id: "org1",
        applied_revision: 7,
      });
    else
      expect(result.body).toMatchObject({ code: "configuration_unavailable" });
    await Promise.all(pending);
    await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(2));

    const spans = exporter.getFinishedSpans();
    const client = spans.find((span) => span.kind === SpanKind.CLIENT)!;
    const receivedSpan = spans.find((span) => span.kind === SpanKind.SERVER)!;
    expect(receivedSpan.parentSpanContext?.spanId).toBe(
      client.spanContext().spanId,
    );
    expect(receivedSpan.spanContext().traceId).toBe(
      client.spanContext().traceId,
    );
    expect(receivedSpan.attributes["http.route"]).toBe(
      EXECUTION_CONFIGURATION_PATH,
    );
    expect(receivedSpan.attributes["http.response.status_code"]).toBe(
      result.status,
    );
    expect(receivedSpan.status.code).toBe(
      outcome === "success" ? SpanStatusCode.UNSET : SpanStatusCode.ERROR,
    );
    if (outcome === "success")
      expect(receivedSpan.attributes["antnest.configuration.revision"]).toBe(7);
    expect(events).toEqual([
      "apply_enter",
      "apply_settled",
      "response_finish",
      "server_span_ended",
    ]);
  },
);
