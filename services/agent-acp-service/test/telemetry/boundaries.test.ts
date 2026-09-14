import { createServer, type Server } from "node:http";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { configureBoundaries, rpcContent } from "../../src/telemetry/diagnostics.js";
import { observeHttpRequest, tracedFetch } from "../../src/telemetry/http.js";
import { createAcpDispatcher } from "../../src/telemetry/acp-dispatch.js";
import { binding, snapshot } from "../support/fixtures.js";
import {
  InstrumentedModel,
  InstrumentedToolCatalog,
  InstrumentedRunExecutor,
} from "../../src/telemetry/instrumented-ports.js";
import { ServiceTelemetry } from "../../src/telemetry/telemetry.js";
import type { ExecuteRunResult } from "../../src/ports/acp-application.js";
import { ModelError } from "../../src/ports/model.js";
import { OpenAICompatibleModel } from "../../src/adapters/model/openai-compatible.js";

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer("acp-contract-test");
let server: Server | undefined;

beforeAll(() => provider.register({ propagator: new core.W3CTraceContextPropagator() }));
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
    const response = await context.with(trace.setSpan(context.active(), parent), () =>
      tracedFetch(fetch, "agent-acp-service")(`${url}/status`, {
        headers: { authorization: "header-canary", baggage: "secret=baggage-canary" },
      }),
    );
    expect(await response.json()).toEqual({ status: "ready" });
    parent.end();
    await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(3));
    const spans = exporter.getFinishedSpans();
    const client = spans.find((span) => span.kind === SpanKind.CLIENT)!;
    const received = spans.find((span) => span.kind === SpanKind.SERVER)!;
    expect(client.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(received.parentSpanContext?.spanId).toBe(client.spanContext().spanId);
    expect(received.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(received.name).toBe("HTTP GET /status");
    expect(received.attributes["http.route"]).toBe("/status");
    expect(received.events).toHaveLength(0);
    expect(client.events).toHaveLength(0);
    expect(Object.keys(received.attributes).some((key) => key.includes(".header."))).toBe(false);
    expect(serializedSpans()).not.toContain("canary");
  });

  it("does not pull or finish at headers, and preserves EOF and cancellation", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode("chunk"));
    });
    const cancel = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const response = await tracedFetch(() => Promise.resolve(new Response(body)), "model")(
      "https://model.test/v1?key=query-canary",
      {},
    );
    expect(pull).not.toHaveBeenCalled();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new TextEncoder().encode("chunk"));
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    await reader.cancel("cancel-canary");
    reader.releaseLock();
    expect(cancel).toHaveBeenCalledWith("cancel-canary");
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]!.attributes["http.response.body.size"]).toBe(5);
    expect(serializedSpans()).not.toContain("canary");
  });

  it("retains the original cause on send and read failures without inventing HTTP status", async () => {
    const cause = Object.assign(new Error("provider-secret-canary"), { code: "ECONNRESET" });
    const failure = new TypeError("url?token=error-canary", { cause });
    await expect(
      tracedFetch(() => Promise.reject(failure), "model")("https://model.test", {}),
    ).rejects.toBe(failure);
    const sent = exporter.getFinishedSpans()[0]!;
    expect(sent.status.code).toBe(SpanStatusCode.ERROR);
    expect(sent.attributes).not.toHaveProperty("http.response.status_code");
    expect(JSON.stringify(sent.events)).toContain("ECONNRESET");
    const response = await tracedFetch(
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream(
              {
                pull(controller) {
                  controller.error(failure);
                },
              },
              { highWaterMark: 0 },
            ),
          ),
        ),
      "model",
    )("https://model.test", {});
    await expect(response.text()).rejects.toBe(failure);
    expect(exporter.getFinishedSpans()).toHaveLength(2);
    expect(serializedSpans()).not.toContain("canary");
  });

  it("leaves business output and body identity unchanged when disabled", async () => {
    configureBoundaries({ captureRpcContent: true, disabled: true });
    const response = new Response("unchanged");
    expect(
      await tracedFetch(() => Promise.resolve(response), "model")("https://model.test", {}),
    ).toBe(response);
    expect(await response.text()).toBe("unchanged");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
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
          headers: { authorization: "provider-canary", baggage: "secret=baggage-canary" },
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

describe("ACP dispatcher contract", () => {
  it.each(["v1", "v2"] as const)(
    "keeps concurrent %s parents and complete actual RPC values",
    async (version) => {
      const dispatch = createAcpDispatcher(version, binding());
      const parents = [tracer.startSpan("first"), tracer.startSpan("second")];
      await Promise.all(
        parents.map((parent, index) => {
          const carrier: Record<string, string> = {};
          propagation.inject(trace.setSpan(context.active(), parent), carrier);
          return dispatch(
            "session/set_config_option",
            {
              sessionId: `session-${index}`,
              configId: "model",
              value: `profile:model-${index}`,
              _meta: { ...carrier, secret: { token: "nested-canary" } },
              prompt: [{ text: "prompt-canary" }],
            },
            index,
            async () => {
              await Promise.resolve();
              expect(trace.getSpan(context.active())?.spanContext().traceId).toBe(
                parent.spanContext().traceId,
              );
              return { sessionId: `session-${index}` };
            },
          );
        }),
      );
      for (const [index, parent] of parents.entries()) {
        const span = exporter
          .getFinishedSpans()
          .find((item) => item.attributes["antnest.request.id"] === String(index))!;
        expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
        expect(JSON.stringify(span.events)).toContain(`profile:model-${index}`);
        expect(JSON.stringify(span.events)).toContain(`session-${index}`);
        parent.end();
      }
      expect(serializedSpans()).toContain("nested-canary");
      expect(serializedSpans()).toContain("prompt-canary");
    },
  );

  it("accepts null JSON-RPC IDs without inventing a request identifier", async () => {
    const dispatch = createAcpDispatcher("v1", binding());
    await expect(
      dispatch("session/new", {}, null, () => ({ sessionId: "session-null-id" })),
    ).resolves.toEqual({ sessionId: "session-null-id" });
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.attributes["antnest.request.id"]).toBeUndefined();
  });

  it("records complete protocol errors without changing their identity", async () => {
    const dispatch = createAcpDispatcher("v1", binding());
    const error = Object.assign(new Error("error-canary"), {
      code: -32602,
      data: { token: "data-canary" },
    });
    await expect(
      dispatch("session/new", { cwd: "/workspace" }, 42, () => Promise.reject(error)),
    ).rejects.toBe(error);
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes["rpc.response.status_code"]).toBe(-32602);
    expect(span.attributes["antnest.error.code"]).toBe("-32602");
    expect(span.events.find((event) => event.name === "antnest.error")?.attributes).toMatchObject({
      "antnest.error.stage": "acp.dispatch",
      "antnest.error.type": "Error",
      "antnest.error.code": "-32602",
      "antnest.error.cause_types": [],
    });
    expect(span.attributes["antnest.outcome"]).toBe("rejected");
    expect(JSON.stringify(span.events)).toContain("data-canary");
  });
});

describe("RPC capture switch", () => {
  it("retains new nested fields and large values without custom budgets", () => {
    const span = tracer.startSpan("rpc");
    const value = { newField: { secret: "x".repeat(24_000) }, extra: ["raw"] };
    rpcContent(span, "request", value);
    rpcContent(span, "response", value);
    span.end();
    const events = exporter.getFinishedSpans()[0]!.events;
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(JSON.parse(String(event.attributes?.["antnest.payload.json"]))).toEqual(value);
  });

  it("does not serialize when capture or telemetry is disabled", () => {
    const toJSON = vi.fn(() => ({ secret: "canary" }));
    const span = tracer.startSpan("off");
    configureBoundaries({ captureRpcContent: false, disabled: false });
    rpcContent(span, "request", { toJSON });
    configureBoundaries({ captureRpcContent: true, disabled: true });
    rpcContent(span, "response", { toJSON });
    span.end();
    expect(toJSON).not.toHaveBeenCalled();
    expect(exporter.getFinishedSpans()[0]!.events).toHaveLength(0);
  });

  it("reports serialization failures without changing execution", () => {
    const span = tracer.startSpan("encoding-error");
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => rpcContent(span, "request", value)).not.toThrow();
    span.end();
    expect(exporter.getFinishedSpans()[0]!.events[0]!.name).toBe("antnest.capture.error");
  });

  it("keeps notifications metadata-only even when RPC capture is enabled", async () => {
    const dispatch = createAcpDispatcher("v1", binding());
    const operation = vi.fn(() => undefined);
    await dispatch(
      "session/cancel",
      { sessionId: "session-1", text: "notification-canary" },
      undefined,
      operation,
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(exporter.getFinishedSpans()[0]!.events).toHaveLength(0);
    expect(serializedSpans()).not.toContain("notification-canary");
  });
});

describe("existing adapter and runner metadata", () => {
  const telemetry = new ServiceTelemetry("agent-acp-service", () => undefined);
  it("exports actual model limits/context counts/usage but not prompts or nested provider secrets", async () => {
    const result = {
      kind: "message" as const,
      stopReason: "end_turn" as const,
      content: [{ type: "text", text: "completion-canary" }],
      usage: { inputTokens: 23, outputTokens: 7 },
    };
    const model = new InstrumentedModel({ complete: () => Promise.resolve(result) }, telemetry);
    const snap = snapshot();
    snap.executionSpec.model.model = "model-visible";
    snap.executionSpec.model.maxOutputTokens = 2048;
    expect(
      await model.complete({
        snapshot: snap,
        credential: "credential-canary",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "prompt-canary", nested: { password: "nested-canary" } },
            ],
          },
        ],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).toBe(result);
    const span = exporter.getFinishedSpans().find((item) => item.name === "model.complete")!;
    const events = JSON.stringify(span.events);
    expect(span.attributes["model.name"]).toBe("model-visible");
    expect(span.attributes["antnest.model.max_output_tokens"]).toBe(2048);
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(23);
    expect(span.events).toHaveLength(0);
    expect(span.attributes["antnest.context.message_count"]).toBe(1);
    expect(events).not.toContain("canary");
  });

  it("marks MCP isError as protocol failure while preserving safe Tool arguments and result identity", async () => {
    const result = {
      content: [{ type: "text", text: "result-canary" }],
      isError: true,
      toolEffectState: "settled" as const,
    };
    const catalog = new InstrumentedToolCatalog(
      { list: () => Promise.resolve([]), call: () => Promise.resolve(result) },
      telemetry,
    );
    expect(
      await catalog.call({
        runId: "run-visible",
        snapshot: snapshot(),
        tool: {
          source: "runtime",
          sourceId: "runtime",
          name: "read",
          modelName: "read",
          description: "description-canary",
        },
        arguments: {
          path: "/workspace/visible.txt",
          offset: 12,
          token: "token-canary",
          nested: [{ password: "nested-canary" }],
        },
        signal: new AbortController().signal,
      }),
    ).toBe(result);
    const span = exporter.getFinishedSpans().find((item) => item.name === "mcp.tools.call")!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["antnest.outcome"]).toBe("tool_error");
    expect(span.events).toHaveLength(0);
    expect(JSON.stringify(span.events)).not.toContain("canary");
  });

  it("records model protocol errors after HTTP200 at the adapter without losing their cause", async () => {
    const cause = new SyntaxError("raw-provider-canary");
    const failure = new ModelError(
      "model_invalid_response",
      "completion-canary",
      false,
      undefined,
      { cause },
    );
    const model = new InstrumentedModel({ complete: () => Promise.reject(failure) }, telemetry);
    await expect(
      model.complete({
        snapshot: snapshot(),
        credential: "secret",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(span.events)).toContain("completion protocol");
    expect(JSON.stringify(span.events)).toContain("SyntaxError");
    expect(JSON.stringify(span.events)).not.toContain("canary");
  });

  it("does not let HTTP200 hide an invalid completion from the real model adapter", async () => {
    const model = new InstrumentedModel(
      new OpenAICompatibleModel({
        fetchFn: () =>
          Promise.resolve(
            Response.json({
              error: { message: "provider-canary", nested: { token: "nested-canary" } },
            }),
          ),
      }),
      telemetry,
    );
    await expect(
      model.complete({
        snapshot: snapshot(),
        credential: "credential-canary",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError &&
        error.code === "model_invalid_response" &&
        error.cause instanceof Error,
    );
    const spans = exporter.getFinishedSpans();
    const client = spans.find((item) => item.kind === SpanKind.CLIENT)!;
    const adapter = spans.find((item) => item.name === "model.complete")!;
    expect(client.attributes["http.response.status_code"]).toBe(200);
    expect(client.parentSpanContext?.spanId).toBe(adapter.spanContext().spanId);
    expect(adapter.status.code).toBe(SpanStatusCode.ERROR);
    expect(adapter.attributes["antnest.error.code"]).toBe("model_invalid_response");
    expect(serializedSpans()).not.toContain("canary");
  });

  it.each(["failed", "unresolved"] as const)(
    "uses a bounded Run root with an exact source Link and keeps %s terminal results",
    async (terminalClass) => {
      const parent = tracer.startSpan("acp accepted");
      const result: ExecuteRunResult =
        terminalClass === "failed"
          ? {
              terminalClass,
              executorState: "quiescent",
              toolEffectState: "none",
              errorClass: "model_invalid_response",
            }
          : {
              terminalClass,
              executorState: "quiescent",
              toolEffectState: "unknown",
              unknownEffectSource: "runtime_mcp",
              errorClass: "tool_effect_unknown",
            };
      const application = new InstrumentedRunExecutor(
        { execute: () => Promise.resolve(result) },
        telemetry,
      );
      await context.with(trace.setSpan(context.active(), parent), () =>
        application.execute({
          accepted: {
            runId: "run-1",
            requestId: "request-1",
            sessionId: "session-1",
            userMessageId: "message-1",
            outputSequence: 0,
            snapshot: snapshot(),
          },
          publish: () => Promise.resolve(),
          signal: new AbortController().signal,
        }),
      );
      const run = exporter.getFinishedSpans().find((item) => item.name === "agent.run")!;
      expect(run.parentSpanContext).toBeUndefined();
      expect(run.links[0]?.context.spanId).toBe(parent.spanContext().spanId);
      expect(run.links[0]?.context.traceId).toBe(parent.spanContext().traceId);
      expect(run.status.code).toBe(SpanStatusCode.ERROR);
      expect(run.attributes["antnest.run.id"]).toBe("run-1");
      expect(run.attributes).toMatchObject({
        "run.terminal_class": terminalClass,
        "run.executor_state": "quiescent",
        "run.tool_effect_state": result.toolEffectState,
      });
      expect(run.attributes["run.unknown_effect_source"]).toBe(result.unknownEffectSource);
      expect(JSON.stringify(run.attributes)).not.toMatch(/admission|credential/);
      parent.end();
    },
  );
});

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (address === null || typeof address === "string") throw new Error("Missing TCP address");
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
