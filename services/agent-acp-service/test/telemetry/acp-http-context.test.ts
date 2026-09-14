import { createServer } from "node:http";
import { once } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import type { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { TracedAcpHttpServer } from "../../src/telemetry/acp-http.js";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { context, propagation, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import { expect, it } from "vitest";
import { createAcpDispatcher } from "../../src/telemetry/acp-dispatch.js";
import { observeHttpRequest, tracedFetch } from "../../src/telemetry/http.js";
import { configureBoundaries } from "../../src/telemetry/diagnostics.js";
import { binding } from "../support/fixtures.js";

it.each([
  undefined,
  null,
  {
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    tracestate: "stale=value",
    custom: "preserved",
  },
])(
  "official HTTP SDK retains the current POST trace through its connection queue with _meta %j",
  async (_meta) => {
    const exporter = new tracing.InMemorySpanExporter();
    const provider = new node.NodeTracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
    });
    provider.register({ propagator: new core.W3CTraceContextPropagator() });
    configureBoundaries({ captureRpcContent: false, disabled: false });
    const tracer = provider.getTracer("test-client");
    const requestTraces = new Map<string, string>();
    let transport: AcpServer | undefined;
    let handler: ReturnType<typeof createNodeHttpHandler>;
    const server = createServer((request, response) => {
      void observeHttpRequest(request, response, () => {
        if (transport === undefined) {
          const dispatch = createAcpDispatcher("v1", binding());
          transport = new TracedAcpHttpServer({
            agent: acp
              .agent()
              .onRequest(acp.methods.agent.initialize, ({ params, requestId }) =>
                dispatch("initialize", params, requestId, () => ({ protocolVersion: 1 })),
              )
              .onRequest(acp.methods.agent.session.new, ({ params, requestId }) =>
                dispatch("session/new", params, requestId, () => ({ sessionId: "session" })),
              )
              .onRequest(acp.methods.agent.session.prompt, ({ params, requestId }) =>
                dispatch("session/prompt", params, requestId, () => ({
                  stopReason: "end_turn" as const,
                })),
              ),
          });
          handler = createNodeHttpHandler(transport);
        }
        return Promise.resolve(handler(request, response));
      });
    });
    let connection: acp.ClientConnection | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing address");
      const send: typeof fetch = async (input, init) => {
        const message =
          init?.method === "POST" && typeof init.body === "string"
            ? (JSON.parse(init.body) as { method?: string })
            : undefined;
        const parent = tracer.startSpan(message?.method ?? "transport");
        if (message?.method !== undefined)
          requestTraces.set(message.method, parent.spanContext().traceId);
        try {
          return await context.with(trace.setSpan(context.active(), parent), () =>
            tracedFetch(fetch, "agent-acp-service")(input as string, init ?? {}),
          );
        } finally {
          parent.end();
        }
      };
      connection = acp
        .client()
        .connect(createHttpStream(`http://127.0.0.1:${address.port}/v1/acp`, { fetch: send }));
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      await connection.agent.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
        ...(_meta === undefined ? {} : { _meta }),
      });
      await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: "session",
        prompt: [{ type: "text", text: "test" }],
        ...(_meta === undefined ? {} : { _meta }),
      });
      for (const method of ["initialize", "session/new", "session/prompt"]) {
        const spans = exporter
          .getFinishedSpans()
          .filter((span) => span.attributes["rpc.method"] === method);
        expect(spans, method).toHaveLength(1);
        expect(spans[0]!.spanContext().traceId, method).toBe(requestTraces.get(method));
        expect(spans[0]!.spanContext().traceState?.get("stale"), method).toBeUndefined();
      }
    } finally {
      connection?.close();
      await connection?.closed;
      await transport?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    }
  },
);
