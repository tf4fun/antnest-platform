import { describe, expect, it, vi } from "vitest";

import { OpenAICompatibleModel } from "../../../src/adapters/model/openai-compatible.js";
import {
  ModelTransportCleanupError,
  type AuthenticatedModelRequest,
} from "../../../src/ports/model.js";
import { snapshot } from "../../support/fixtures.js";
import { syntheticProviderDestination } from "../../support/model-network.js";

function request(): AuthenticatedModelRequest {
  return {
    snapshot: snapshot(),
    credential: "synthetic",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  };
}

function event(delta: unknown, finishReason: string | null = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function adapter(body: BodyInit) {
  return new OpenAICompatibleModel({
    destination: syntheticProviderDestination,
    fetchFn: () =>
      Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
  });
}

function causes(error: unknown): unknown[] {
  return [
    error,
    ...(error instanceof AggregateError ? error.errors.flatMap(causes) : []),
    ...(error instanceof Error && Object.hasOwn(error, "cause") ? causes(error.cause) : []),
  ];
}

describe("model attempt output and original cleanup boundaries", () => {
  it.each([
    { content: "text" },
    { content: " " },
    { reasoning_content: "thought" },
    { refusal: "no" },
    { tool_calls: [{ index: 0, id: "call" }] },
    { tool_calls: [{ index: 0, function: { name: "read" } }] },
    { tool_calls: [{ index: 0, function: { arguments: "{" } }] },
  ])("retains the first nonempty output boundary on a failed stream: %j", async (delta) => {
    const model = adapter(event(delta));
    await expect(model.complete(request())).rejects.toMatchObject({
      code: "model_invalid_response",
      outputStarted: true,
    });
  });

  it.each([
    {},
    { role: "assistant" },
    { content: "", reasoning_content: null },
    { tool_calls: [{ index: 0, type: "function", id: "", function: { name: "", arguments: "" } }] },
  ])("does not mistake empty control chunks for output: %j", async (delta) => {
    await expect(adapter(event(delta)).complete(request())).rejects.toMatchObject({
      code: "model_invalid_response",
      outputStarted: false,
    });
  });

  it("retains usage-only failure without opening the output boundary", async () => {
    const body = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`;
    await expect(adapter(body).complete(request())).rejects.toMatchObject({
      outputStarted: false,
      usage: { inputTokens: 7, outputTokens: 2 },
    });
  });

  it("joins the original body cancellation after DONE before returning success", async () => {
    const gate = Promise.withResolvers<void>();
    let cancelling = false;
    let settled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(event({ content: "done" }, "stop") + "data: [DONE]\n\n"),
        );
      },
      cancel() {
        cancelling = true;
        return gate.promise;
      },
    });
    const completed = adapter(body)
      .complete(request())
      .finally(() => {
        settled = true;
      });
    const observed = completed.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(cancelling).toBe(true));
      expect(settled).toBe(false);
      gate.resolve();
      await expect(completed).resolves.toMatchObject({ kind: "message", stopReason: "end_turn" });
    } finally {
      gate.resolve();
      await observed;
    }
  });

  it.each([new Error("body cancellation failed"), undefined])(
    "does not turn a failed original body cancellation into successful output: %s",
    async (cleanupError) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              event({ content: "done" }, "stop") +
                `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n` +
                "data: [DONE]\n\n",
            ),
          );
        },
        cancel: vi.fn<() => Promise<void>>().mockRejectedValue(cleanupError),
      });
      const error: unknown = await adapter(body)
        .complete(request())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelTransportCleanupError);
      expect(error).toMatchObject({
        retryable: false,
        outputStarted: true,
        usage: { inputTokens: 7, outputTokens: 2 },
      });
      expect(causes(error)).toContain(cleanupError);
    },
  );

  it("does not return DONE success when the Run aborts while original body cancellation is held", async () => {
    const gate = Promise.withResolvers<void>();
    const controller = new AbortController();
    const abortError = new Error("Run cancelled during body cleanup");
    let cancelling = false;
    const body = new ReadableStream<Uint8Array>({
      start(source) {
        source.enqueue(
          new TextEncoder().encode(event({ content: "done" }, "stop") + "data: [DONE]\n\n"),
        );
      },
      cancel() {
        cancelling = true;
        return gate.promise;
      },
    });
    const completed = adapter(body).complete({ ...request(), signal: controller.signal });
    const observed = completed.catch((caught: unknown) => caught);
    try {
      await vi.waitFor(() => expect(cancelling).toBe(true));
      controller.abort(abortError);
      gate.resolve();
      const error: unknown = await observed;
      expect(error).toMatchObject({ code: "model_unavailable", outputStarted: true });
      expect(causes(error)).toContain(abortError);
    } finally {
      gate.resolve();
      await observed;
    }
  });

  it("preserves an independent cancellation failure beside the original output callback failure", async () => {
    const operationError = new Error("output observer failed");
    const cleanupError = new Error("original source cancel failed");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event({ content: "visible" })));
      },
      cancel() {
        return Promise.reject(cleanupError);
      },
    });
    const error: unknown = await adapter(body)
      .complete({
        ...request(),
        onDelta: () => Promise.reject(operationError),
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelTransportCleanupError);
    expect(causes(error)).toContain(operationError);
    expect(causes(error)).toContain(cleanupError);
  });

  it("joins original body cancellation after abort without classifying normal propagation as cleanup failure", async () => {
    const gate = Promise.withResolvers<void>();
    const controller = new AbortController();
    let cancelling = false;
    let settled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelling = true;
        return gate.promise;
      },
    });
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    const model = new OpenAICompatibleModel({ destination: syntheticProviderDestination, fetchFn });
    const completed = model.complete({ ...request(), signal: controller.signal }).finally(() => {
      settled = true;
    });
    const observed = completed.catch((caught: unknown) => caught);
    try {
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
      controller.abort(new Error("Run cancelled"));
      await vi.waitFor(() => expect(cancelling).toBe(true));
      expect(settled).toBe(false);
      gate.resolve();
      const error: unknown = await observed;
      expect(error).not.toBeInstanceOf(ModelTransportCleanupError);
      expect(error).toMatchObject({ code: "model_unavailable", outputStarted: false });
    } finally {
      gate.resolve();
      await observed;
    }
  });

  it.each([new Error("abort cleanup failed"), undefined])(
    "retains independent original cancellation failure during abort: %s",
    async (cleanupError) => {
      const gate = Promise.withResolvers<void>();
      const controller = new AbortController();
      const abortError = new Error("original Run abort");
      let cancelling = false;
      let settled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelling = true;
          return gate.promise;
        },
      });
      const fetchFn = vi.fn(() =>
        Promise.resolve(
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      );
      const model = new OpenAICompatibleModel({
        destination: syntheticProviderDestination,
        fetchFn,
      });
      const completed = model.complete({ ...request(), signal: controller.signal }).finally(() => {
        settled = true;
      });
      const observed = completed.catch((caught: unknown) => caught);
      try {
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
        controller.abort(abortError);
        await vi.waitFor(() => expect(cancelling).toBe(true));
        expect(settled).toBe(false);
        gate.reject(cleanupError);
        const error: unknown = await observed;
        expect(error).toBeInstanceOf(ModelTransportCleanupError);
        expect(error).toMatchObject({ retryable: false, outputStarted: false });
        expect(causes(error)).toContain(abortError);
        expect(causes(error)).toContain(cleanupError);
      } finally {
        gate.resolve();
        await observed;
      }
    },
  );
});
