import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { configureBoundaries, rpcContent } from "../../src/telemetry/diagnostics.js";
import { tracedFetch } from "../../src/telemetry/http.js";
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
import { RunSupervisor } from "../../src/application/run-supervisor.js";

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer("acp-contract-test");

beforeAll(() => provider.register({ propagator: new core.W3CTraceContextPropagator() }));
beforeEach(() => {
  exporter.reset();
  configureBoundaries({ captureRpcContent: true, disabled: false });
});
afterEach(() => {
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("HTTP boundary contract", () => {
  it.each(["AbortError", "TimeoutError"] as const)(
    "classifies %s without hiding a failed HTTP response",
    async (name) => {
      const signal = new AbortController();
      const response = await tracedFetch(
        () => Promise.resolve(new Response(new ReadableStream(), { status: 200 })),
        "antnest-runtime",
      )("http://runtime.test/mcp", { signal: signal.signal });
      signal.abort(new DOMException("private-canary", name));
      await response.body!.cancel();
      const span = exporter.getFinishedSpans()[0]!;
      expect(exporter.getFinishedSpans()).toHaveLength(1);
      expect(span.events.map((event) => event.name)).toEqual([
        name === "AbortError" ? "antnest.cancelled" : "antnest.error",
      ]);
      expect(span.status.code).toBe(
        name === "AbortError" ? SpanStatusCode.UNSET : SpanStatusCode.ERROR,
      );
      expect(serializedSpans()).not.toContain("private-canary");
      exporter.reset();
      const rejected = await tracedFetch(
        () => Promise.resolve(new Response(new ReadableStream(), { status: 503 })),
        "antnest-runtime",
      )("http://runtime.test/mcp", {});
      await rejected.body!.cancel();
      expect(exporter.getFinishedSpans()[0]!.status.code).toBe(SpanStatusCode.ERROR);
    },
  );
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
});

describe("ACP dispatcher contract", () => {
  it.each(["v1", "v2"] as const)(
    "preserves %s message ancestry through asynchronous Run and outgoing HTTP",
    async (version) => {
      configureBoundaries({ captureRpcContent: false, disabled: false });
      const upstream = tracer.startSpan("Gateway forward", { kind: SpanKind.CLIENT });
      const metadata: Record<string, string> = {};
      propagation.inject(trace.setSpan(context.active(), upstream), metadata);
      upstream.end();
      const supervisor = new RunSupervisor(
        new InstrumentedRunExecutor(
          {
            execute: async () => {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              for (const peer of ["model", "antnest-runtime"]) {
                const response = await tracedFetch((_url, init) => {
                  const headers = new Headers(init.headers);
                  const parent = propagation.extract(context.active(), Object.fromEntries(headers));
                  const received = tracer.startSpan(peer, { kind: SpanKind.SERVER }, parent);
                  received.end();
                  return Promise.resolve(new Response("ok"));
                }, peer)(`http://${peer}.test`, { method: "POST" });
                await response.text();
              }
              return {
                terminalClass: "completed",
                executorState: "quiescent",
                toolEffectState: "none",
                stopReason: "end_turn",
              };
            },
          },
          new ServiceTelemetry("agent-acp-service"),
        ),
      );
      const dispatch = createAcpDispatcher(version, binding());
      await dispatch("session/prompt", { sessionId: "s", _meta: metadata }, 1, async () => {
        const accepted = await supervisor.submit(
          { binding: binding(), sessionId: "s", outputChanged: vi.fn() },
          () =>
            Promise.resolve({
              runId: "r",
              sessionId: "s",
              requestId: "q",
              userMessageId: "m",
              outputSequence: 0,
              snapshot: snapshot(),
            }),
        );
        await accepted.completion;
      });
      const spans = exporter.getFinishedSpans();
      const prompt = spans.find((span) => span.name === "acp session/prompt")!;
      const run = spans.find((span) => span.name === "agent.run")!;
      expect(prompt.parentSpanContext?.spanId).toBe(upstream.spanContext().spanId);
      expect(run.parentSpanContext?.spanId).toBe(prompt.spanContext().spanId);
      expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(
        new Set([upstream.spanContext().traceId]),
      );
      for (const peer of ["model", "antnest-runtime"]) {
        const client = spans.find((span) => span.name === `HTTP POST ${peer}`)!;
        const received = spans.find((span) => span.name === peer)!;
        expect(client.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
        expect(received.parentSpanContext?.spanId).toBe(client.spanContext().spanId);
      }
      expect(spans.flatMap((span) => span.events)).toEqual([]);
    },
  );
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
    "keeps Run under its submitting request and retains %s terminal results",
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
      expect(run.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(run.spanContext().traceId).toBe(parent.spanContext().traceId);
      expect(run.links).toHaveLength(0);
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
