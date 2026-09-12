import { describe, expect, it } from "vitest";
import { OpenAICompatibleModel } from "../../../src/adapters/model/openai-compatible.js";
import type { ModelRequest } from "../../../src/ports/model.js";
import { snapshot } from "../../support/fixtures.js";

const pricing = {
  currency: "USD" as const,
  inputPerMillion: 2,
  outputPerMillion: 8,
  cacheReadPerMillion: 0.5,
  cacheWritePerMillion: 3,
};
function response(usage: unknown, streaming: boolean) {
  const payload = {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "reply" } }],
    ...(usage === undefined ? {} : { usage }),
  };
  if (!streaming) return Response.json(payload);
  const chunks = [
    { choices: [{ index: 0, delta: { content: "reply" }, finish_reason: "stop" }] },
    ...(usage === undefined ? [] : [{ choices: [], usage }]),
  ];
  return new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function complete(usage: unknown, streaming: boolean, withPrice = true) {
  const request: ModelRequest = {
    snapshot: snapshot(),
    credential: "test",
    messages: [],
    tools: [],
    signal: AbortSignal.timeout(5000),
  };
  if (withPrice) request.snapshot.executionSpec.model.pricing = pricing;
  return new OpenAICompatibleModel({
    fetchFn: () => Promise.resolve(response(usage, streaming)),
  }).complete(request);
}
describe.each([false, true])("model costs streaming=%s", (streaming) => {
  it("retains reported fees but does not estimate from an invalid cache container", async () => {
    for (const prompt_tokens_details of ["bad", [], 300]) {
      const raw = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details };
      const result = await complete({ ...raw, cost: 0.01 }, streaming);
      expect(result.content).toEqual([{ type: "text", text: "reply" }]);
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 2,
        cost: { amount: 0.01, currency: "USD", source: "provider_reported" },
      });
      expect((await complete(raw, streaming)).usage.cost).toBeUndefined();
    }
  });
  it("keeps valid reported money and the answer independently of malformed token counts", async () => {
    for (const prompt_tokens of [-1, "unknown", null]) {
      const result = await complete({ prompt_tokens, completion_tokens: 2, cost: 0.01 }, streaming);
      expect(result.content).toEqual([{ type: "text", text: "reply" }]);
      expect(result.usage).toEqual({
        outputTokens: 2,
        cost: { amount: 0.01, currency: "USD", source: "provider_reported" },
      });
    }
  });
  it("retains known usage when the completion fails validation", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 2, cost: 0.01 };
    const body = streaming
      ? new Response(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : Response.json({ choices: [], usage });
    const model = new OpenAICompatibleModel({ fetchFn: () => Promise.resolve(body) });
    await expect(
      model.complete({
        snapshot: snapshot(),
        credential: "test",
        messages: [],
        tools: [],
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toMatchObject({
      code: "model_invalid_response",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cost: { amount: 0.01, currency: "USD", source: "provider_reported" },
      },
    });
  });
  it("retains reported USD including zero rather than adding an estimate", async () => {
    for (const amount of [0, 0.012]) {
      const result = await complete(
        { prompt_tokens: 1000, completion_tokens: 100, cost: amount },
        streaming,
      );
      expect(result.usage.cost).toEqual({ amount, currency: "USD", source: "provider_reported" });
    }
  });
  it("preserves cache counts and frozen rates for a native estimate", async () => {
    const result = await complete(
      {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 300 },
        cache_creation_input_tokens: 200,
      },
      streaming,
    );
    expect(result.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 300,
      cacheWriteTokens: 200,
      cost: { source: "estimated", pricing },
    });
    expect(result.usage.cost?.amount).toBeCloseTo(0.00255, 12);
    const deepseek = await complete(
      { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 300 },
      streaming,
    );
    expect(deepseek.usage.cacheReadTokens).toBe(300);
  });
  it("omits unknown usage and unpriced cost instead of inventing a free call", async () => {
    expect((await complete(undefined, streaming)).usage).toEqual({});
    expect(
      (await complete({ prompt_tokens: 10, completion_tokens: 2 }, streaming, false)).usage.cost,
    ).toBeUndefined();
    expect((await complete({ prompt_tokens: 10 }, streaming)).usage).toEqual({ inputTokens: 10 });
  });
  it("does not label foreign/invalid Provider amounts as reported USD", async () => {
    for (const cost of [
      { cost: 1, cost_currency: "EUR" },
      { cost: 1, currency: "CNY" },
      { cost: -3 },
      { cost: "unknown" },
    ]) {
      const usage = { prompt_tokens: 10, completion_tokens: 2, ...cost };
      expect((await complete(usage, streaming, false)).usage.cost).toBeUndefined();
      expect((await complete(usage, streaming)).usage.cost?.source).toBe("estimated");
    }
  });
  it("does not price impossible cache data or silently change the completion", async () => {
    for (const cached of [1001, -1, "bad"]) {
      const result = await complete(
        {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: cached },
        },
        streaming,
      );
      expect(result.content).toEqual([{ type: "text", text: "reply" }]);
      expect(result.usage.cost).toBeUndefined();
    }
  });
});

describe("stream usage snapshots", () => {
  it("retains valid usage from the same chunk whose completion is invalid", async () => {
    const body = new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 123 } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.01 } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    const model = new OpenAICompatibleModel({ fetchFn: () => Promise.resolve(body) });
    await expect(
      model.complete({
        snapshot: snapshot(),
        credential: "test",
        messages: [],
        tools: [],
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toMatchObject({
      code: "model_invalid_response",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cost: { amount: 0.01, source: "provider_reported" },
      },
    });
  });
  it.each([{}, { cost: 0.01 }, { prompt_tokens: 1000, completion_tokens: 100 }])(
    "merges partial %j without summing repeated counters or erasing cache data",
    async (tail) => {
      const chunks = [
        { choices: [{ index: 0, delta: { content: "reply" }, finish_reason: "stop" }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            prompt_tokens_details: { cached_tokens: 300 },
          },
        },
        { choices: [], usage: tail },
      ];
      const body = new Response(
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
      const request: ModelRequest = {
        snapshot: snapshot(),
        credential: "test",
        messages: [],
        tools: [],
        signal: AbortSignal.timeout(5000),
      };
      request.snapshot.executionSpec.model.pricing = pricing;
      const result = await new OpenAICompatibleModel({
        fetchFn: () => Promise.resolve(body),
      }).complete(request);
      expect(result.usage).toMatchObject({
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 300,
      });
      expect(result.usage.cost?.amount).toBeCloseTo("cost" in tail ? 0.01 : 0.00235, 12);
    },
  );

  it.each([false, true])(
    "retains received usage after stream interruption (cancel=%s)",
    async (cancel) => {
      const abort = new AbortController();
      const usage = { prompt_tokens: 100, completion_tokens: 10, cost: 0.02 };
      const body = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      const model = new OpenAICompatibleModel({ fetchFn: () => Promise.resolve(body) });
      await expect(
        model.complete({
          snapshot: snapshot(),
          credential: "test",
          messages: [],
          tools: [],
          signal: abort.signal,
          onDelta: () => {
            if (cancel) abort.abort();
            return Promise.resolve();
          },
        }),
      ).rejects.toMatchObject({
        usage: { inputTokens: 100, outputTokens: 10, cost: { amount: 0.02 } },
      });
    },
  );
});
