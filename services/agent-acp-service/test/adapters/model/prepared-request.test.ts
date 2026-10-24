import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModel } from "../../../src/adapters/model/openai-compatible.js";
import { ModelError, type ModelRequest } from "../../../src/ports/model.js";
import type { ProviderTokenLimits } from "../../../src/domain/provider-token-limits.js";
import { snapshot } from "../../support/fixtures.js";
import { syntheticProviderDestination } from "../../support/model-network.js";

function request(): ModelRequest {
  const captured = snapshot();
  captured.executionSpec.model.maxOutputTokens = 64;
  captured.executionSpec.model.supportsImages = true;
  return {
    snapshot: captured,
    messages: [{ role: "user", content: [{ type: "text", text: "original" }] }],
    tools: [],
    signal: new AbortController().signal,
  };
}

function limits(input: ModelRequest): ProviderTokenLimits {
  return {
    source: "models",
    source_revision: 1,
    binding: {
      organization_id: input.snapshot.organizationId,
      connection_id: input.snapshot.providerConnectionId,
      provider_key: "deepseek",
      request_protocol: "openai_chat_completions",
      base_url: input.snapshot.executionSpec.model.baseUrl,
      model: input.snapshot.executionSpec.model.model,
      credential_revision: "credential-1",
    },
    context_tokens: 8192,
    max_output_tokens: 64,
    output_includes_reasoning: true,
  };
}

function response(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("prepared Provider request", () => {
  it("sends the fixed encoded request used for reservation and leaves editable context out of its bound", async () => {
    const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(response()));
    const resolve = vi.fn(syntheticProviderDestination.resolve);
    const transport = new OpenAICompatibleModel({ fetchFn, destination: { resolve } });
    const input = request();
    input.snapshot.executionSpec.model.contextWindow = 1024;
    input.tools = [
      {
        source: "runtime",
        sourceId: "runtime",
        name: "read",
        modelName: "read",
        description: "original tool",
        inputSchema: { type: "object" },
      },
    ];
    const observed = limits(input);
    const prepared = transport.prepare(input, observed);
    expect(prepared.dispatchState).toBe("not_dispatched");
    expect(prepared.reservation).toEqual({ inputTokens: 8192, outputTokens: 64 });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    input.snapshot.executionSpec.model.maxOutputTokens = 1;
    input.messages = [{ role: "user", content: [{ type: "text", text: "changed" }] }];
    input.tools[0]!.description = "changed tool";
    observed.context_tokens = 1;
    observed.max_output_tokens = 1;
    await prepared.complete(() => "current-secret");
    expect(prepared.dispatchState).toBe("possibly_dispatched");
    const sent = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(sent.body as string)).toMatchObject({
      max_tokens: 64,
      messages: [{ role: "user", content: "original" }],
      tools: [{ function: { description: "original tool" } }],
    });
    expect(new Headers(sent.headers).get("authorization")).toBe("Bearer current-secret");
    expect(prepared.reservation).toEqual({ inputTokens: 8192, outputTokens: 64 });
    await expect(prepared.complete(() => "second-secret")).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("keeps unknown dimensions unknown instead of using editable profile limits", () => {
    const input = request();
    const transport = new OpenAICompatibleModel({ destination: syntheticProviderDestination });
    expect(transport.prepare(input).reservation).toEqual({});
    expect(
      transport.prepare(input, { ...limits(input), max_output_tokens: undefined }).reservation,
    ).toEqual({ inputTokens: 8192 });
    expect(
      transport.prepare(input, { ...limits(input), context_tokens: undefined }).reservation,
    ).toEqual({ outputTokens: 64 });
  });

  it("preserves unknown media and reasoning coverage independently", () => {
    const input = request();
    input.messages = [
      { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
    ];
    input.snapshot.executionSpec.model.thinking = { protocol: "deepseek", effort: "high" };
    const observed = limits(input);
    delete observed.context_includes_media;
    delete observed.output_includes_reasoning;
    const transport = new OpenAICompatibleModel({ destination: syntheticProviderDestination });
    expect(transport.prepare(input, observed).reservation).toEqual({});
    expect(
      transport.prepare(input, { ...observed, context_includes_media: true }).reservation,
    ).toEqual({ inputTokens: 8192 });
    expect(
      transport.prepare(input, { ...observed, output_includes_reasoning: true }).reservation,
    ).toEqual({ outputTokens: 64 });
    expect(
      transport.prepare(input, {
        ...observed,
        context_includes_media: true,
        output_includes_reasoning: true,
      }).reservation,
    ).toEqual({ inputTokens: 8192, outputTokens: 64 });
  });

  it("checks current credential authority after the original asynchronous endpoint preparation", async () => {
    const entered = Promise.withResolvers<void>();
    const addresses = Promise.withResolvers<string[]>();
    const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(response()));
    const transport = new OpenAICompatibleModel({
      fetchFn,
      destination: {
        resolve: () => {
          entered.resolve();
          return addresses.promise;
        },
      },
    });
    const input = request();
    const prepared = transport.prepare(input, limits(input));
    const sentinel = new Error("credential authority changed");
    const credential = vi.fn((): string => {
      throw sentinel;
    });
    const sending = prepared.complete(credential);
    void sending.catch(() => undefined);
    try {
      await Promise.race([entered.promise, sending]);
      expect(prepared.dispatchState).toBe("not_dispatched");
      expect(credential).not.toHaveBeenCalled();
      addresses.resolve(["8.8.8.8"]);
      await expect(sending).rejects.toBe(sentinel);
      expect(prepared.dispatchState).toBe("not_dispatched");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(credential).toHaveBeenCalledOnce();
    } finally {
      addresses.resolve(["8.8.8.8"]);
      await sending.catch(() => undefined);
    }
  });

  it.each([
    { name: "omitted", effort: undefined, covered: false, knownOutput: false },
    { name: "explicitly off", effort: "off", covered: false, knownOutput: true },
    { name: "covered reasoning", effort: "high", covered: true, knownOutput: true },
  ] as const)("keeps output coverage honest when thinking is $name", async (scenario) => {
    const input = request();
    if (scenario.effort !== undefined)
      input.snapshot.executionSpec.model.thinking = {
        protocol: "deepseek",
        effort: scenario.effort,
      };
    const observed = limits(input);
    if (!scenario.covered) delete observed.output_includes_reasoning;
    const fetchFn = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockImplementation(() => Promise.resolve(response()));
    const resolve = vi.fn(syntheticProviderDestination.resolve);
    const transport = new OpenAICompatibleModel({ fetchFn, destination: { resolve } });
    const prepared = transport.prepare(input, observed);
    expect(prepared.reservation).toEqual({
      inputTokens: 8192,
      ...(scenario.knownOutput ? { outputTokens: 64 } : {}),
    });
    expect(prepared.dispatchState).toBe("not_dispatched");
    expect(resolve).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    await prepared.complete(() => "current-secret");
    const body = fetchFn.mock.calls[0]![1].body;
    if (typeof body !== "string") throw new Error("Expected the frozen encoded request");
    const payload: unknown = JSON.parse(body);
    expect(payload).toMatchObject({ max_tokens: 64 });
    if (scenario.effort === "off")
      expect(payload).toMatchObject({ thinking: { type: "disabled" } });
    if (scenario.effort === undefined) expect(payload).not.toHaveProperty("thinking");
    if (scenario.effort === "high")
      expect(payload).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(prepared.dispatchState).toBe("possibly_dispatched");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects a frozen output cap above the observed limit synchronously without changing the snapshot or dispatching", () => {
    const input = request();
    input.snapshot.executionSpec.model.maxOutputTokens = 256;
    const original = structuredClone(input.snapshot);
    const fetchFn = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockImplementation(() => Promise.resolve(response()));
    const resolve = vi.fn(syntheticProviderDestination.resolve);
    const transport = new OpenAICompatibleModel({ fetchFn, destination: { resolve } });
    let failure: unknown;
    try {
      transport.prepare(input, limits(input));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelError);
    expect(failure).toMatchObject({ code: "model_unsupported_content", retryable: false });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(input.snapshot).toEqual(original);
  });

  it("retains not_dispatched when the original DNS lookup fails before credential access or fetch", async () => {
    const resolve = vi
      .fn(syntheticProviderDestination.resolve)
      .mockRejectedValueOnce(new Error("original DNS failure"));
    const fetchFn = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockImplementation(() => Promise.resolve(response()));
    const transport = new OpenAICompatibleModel({ fetchFn, destination: { resolve } });
    const input = request();
    const prepared = transport.prepare(input, limits(input));
    const credential = vi.fn(() => "current-secret");
    expect(prepared.dispatchState).toBe("not_dispatched");
    await expect(prepared.complete(credential)).rejects.toMatchObject({
      code: "provider_endpoint_unavailable",
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
    expect(prepared.dispatchState).toBe("not_dispatched");
  });

  it("marks a real fetch invocation as possibly_dispatched even when it rejects with a network error", async () => {
    const fetchFn = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
    const transport = new OpenAICompatibleModel({
      fetchFn,
      destination: syntheticProviderDestination,
    });
    const input = request();
    const prepared = transport.prepare(input, limits(input));
    const statesAtFetch: unknown[] = [];
    fetchFn.mockImplementationOnce(() => {
      statesAtFetch.push(prepared.dispatchState);
      return Promise.reject(new TypeError("synthetic network failure after invocation"));
    });
    expect(prepared.dispatchState).toBe("not_dispatched");
    await expect(prepared.complete(() => "current-secret")).rejects.toMatchObject({
      code: "model_unavailable",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(statesAtFetch).toEqual(["possibly_dispatched"]);
    expect(prepared.dispatchState).toBe("possibly_dispatched");
  });
});
