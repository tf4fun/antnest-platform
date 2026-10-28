import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModel } from "../../src/adapters/model/openai-compatible.js";
import type { ProviderResolver } from "../../src/adapters/model/destination-policy.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { RunModelClient } from "../../src/application/run-model-client.js";
import { parseExecutionConfiguration } from "../../src/domain/execution-configuration.js";
import { runSnapshot } from "../../src/domain/run-snapshot.js";
import type { ModelRequest, ModelResult } from "../../src/ports/model.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

const originalSecret = "synthetic-prepared-provider-key";
const rotatedSecret = "synthetic-rotated-prepared-provider-key";

function setup(bindingPatch: Record<string, unknown> = {}) {
  const seed = executionConfiguration();
  const provider = seed.providers[0]!;
  const model = seed.models[0]!;
  const configuration = parseExecutionConfiguration({
    ...seed,
    providers: [
      {
        ...provider,
        credential: { method: "api_key", secret: originalSecret },
      },
    ],
    models: [
      {
        ...model,
        context_window: 64_000,
        max_output_tokens: 64,
        temperature: 0.7,
        pricing: { currency: "USD", input_per_million: 1, output_per_million: 2 },
        provider_token_limits: {
          source: "models",
          source_revision: 1,
          binding: {
            organization_id: seed.organization_id,
            connection_id: provider.connection_id,
            provider_key: provider.provider_key,
            request_protocol: provider.request_protocol,
            base_url: provider.base_url,
            model: model.model,
            credential_revision: provider.credential_revision,
          },
          context_tokens: 8192,
          max_output_tokens: 64,
          output_includes_reasoning: true,
        },
      },
    ],
  });
  const observation = configuration.models[0]!.provider_token_limits;
  if (observation === undefined) throw new Error("Missing observed Provider limits");
  // Deliberately corrupt only the observation after the valid publication was
  // parsed. Even a wrong protocol must exercise consumer matching, not stop at
  // publication parsing. runSnapshot still computes this exact frozen digest.
  Object.assign(observation.binding, bindingPatch);
  const original = runSnapshot({
    configuration,
    identity: executionIdentity(),
    overrides: {},
    accessRevision: configuration.agents[0]!.access_revision,
    clientMcpRevisionId: "client-mcp-1",
    deadlineAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  const resolve = vi.fn<ProviderResolver>().mockResolvedValue(["8.8.8.8"]);
  const fetchFn = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(
      Response.json({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "completed" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    ),
  );
  const transport = new OpenAICompatibleModel({
    destination: { resolve },
    fetchFn,
  });
  const providers = new ProviderClients(transport);
  providers.apply(configuration);
  const onForegroundProvider = vi.fn<(signal: AbortSignal) => void>();
  const client = new RunModelClient({ providers, snapshot: original, onForegroundProvider });
  const request: ModelRequest = {
    snapshot: structuredClone(original),
    messages: [{ role: "user", content: [{ type: "text", text: "original prompt" }] }],
    tools: [],
    signal: new AbortController().signal,
  };
  return {
    client,
    request,
    original,
    configuration,
    providers,
    resolve,
    fetchFn,
    onForegroundProvider,
  };
}

function rotate(f: ReturnType<typeof setup>, changeCatalog = false): void {
  const changed = structuredClone(f.configuration);
  changed.revision += 1;
  changed.providers = changed.providers.map((provider) =>
    provider.enabled
      ? {
          ...provider,
          credential_revision: "credential-2",
          credential: { method: "api_key", secret: rotatedSecret },
        }
      : provider,
  );
  if (changeCatalog) {
    changed.models = changed.models.map((model) => ({
      ...model,
      model: "new-editable-model",
      context_window: 128_000,
      max_output_tokens: 4096,
      temperature: 1.5,
      pricing: { currency: "USD", input_per_million: 50, output_per_million: 90 },
    }));
  }
  f.providers.apply(parseExecutionConfiguration(changed));
}

function sentBody(init: RequestInit): unknown {
  if (typeof init.body !== "string") throw new Error("Expected the encoded model request");
  return JSON.parse(init.body) as unknown;
}

describe("Provider prepared request binding", () => {
  it("uses matched observed bounds without DNS, dispatch or foreground adoption until complete", async () => {
    const f = setup();
    const original = structuredClone(f.original);
    const prepared = f.client.prepare(f.request);
    try {
      expect(prepared.reservation).toEqual({ inputTokens: 8192, outputTokens: 64 });
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.fetchFn).not.toHaveBeenCalled();
      expect(f.onForegroundProvider).not.toHaveBeenCalled();
      await expect(prepared.complete()).resolves.toMatchObject({
        kind: "message",
        content: [{ type: "text", text: "completed" }],
      });
      expect(f.resolve).toHaveBeenCalledOnce();
      expect(f.fetchFn).toHaveBeenCalledOnce();
      expect(f.onForegroundProvider).toHaveBeenCalledOnce();
      expect(new Headers(f.fetchFn.mock.calls[0]![1].headers).get("authorization")).toBe(
        "Bearer " + originalSecret,
      );
      expect(sentBody(f.fetchFn.mock.calls[0]![1])).toMatchObject({
        model: original.executionSpec.model.model,
        max_tokens: 64,
        temperature: 0.7,
      });
      expect(f.original).toEqual(original);
    } finally {
      prepared.release();
    }
  });

  it("treats every mismatched observation binding as unknown instead of using editable model context", () => {
    const mismatches: [string, unknown][] = [
      ["organization_id", "organization-other"],
      ["connection_id", "provider-other"],
      ["provider_key", "openrouter"],
      ["request_protocol", "unsupported_protocol"],
      ["base_url", "https://other-provider.example.test/v1"],
      ["model", "other-api-model"],
      ["credential_revision", "credential-other"],
    ];
    for (const [field, value] of mismatches) {
      const f = setup({ [field]: value });
      const prepared = f.client.prepare(f.request);
      try {
        expect(f.original.executionSpec.model.contextWindow).toBe(64_000);
        expect(f.original.executionSpec.model.maxOutputTokens).toBe(64);
        expect(prepared.reservation, field).toEqual({});
        expect(f.resolve).not.toHaveBeenCalled();
        expect(f.fetchFn).not.toHaveBeenCalled();
        expect(f.onForegroundProvider).not.toHaveBeenCalled();
      } finally {
        prepared.release();
      }
    }
  });

  it("rejects a known prepared bound after credential rotation during the original DNS lookup without sending", async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const addresses = Promise.withResolvers<string[]>();
    f.resolve.mockImplementationOnce(() => {
      entered.resolve();
      return addresses.promise;
    });
    const prepared = f.client.prepare(f.request);
    let original: Promise<ModelResult> | undefined;
    try {
      expect(prepared.reservation).toEqual({ inputTokens: 8192, outputTokens: 64 });
      original = prepared.complete();
      void original.catch(() => undefined);
      await Promise.race([entered.promise, original]);
      expect(f.fetchFn).not.toHaveBeenCalled();
      rotate(f);
      addresses.resolve(["8.8.8.8"]);
      await expect(original).rejects.toMatchObject({
        code: "provider_unavailable",
        retryable: false,
      });
      expect(f.resolve).toHaveBeenCalledOnce();
      expect(f.fetchFn).not.toHaveBeenCalled();
    } finally {
      addresses.resolve(["8.8.8.8"]);
      await Promise.allSettled([addresses.promise, ...(original === undefined ? [] : [original])]);
      prepared.release();
    }
  });

  it("uses the current secret with unknown stale observation bounds and preserves frozen parameters and pricing", async () => {
    const f = setup();
    const frozen = structuredClone(f.original);
    rotate(f, true);
    const prepared = f.client.prepare(f.request);
    try {
      expect(prepared.reservation).toEqual({});
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.fetchFn).not.toHaveBeenCalled();
      expect(f.onForegroundProvider).not.toHaveBeenCalled();
      await expect(prepared.complete()).resolves.toMatchObject({
        kind: "message",
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          cost: {
            amount: 0.000004,
            currency: "USD",
            source: "estimated",
            pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 },
          },
        },
      });
      expect(f.fetchFn).toHaveBeenCalledOnce();
      expect(new Headers(f.fetchFn.mock.calls[0]![1].headers).get("authorization")).toBe(
        "Bearer " + rotatedSecret,
      );
      expect(sentBody(f.fetchFn.mock.calls[0]![1])).toMatchObject({
        model: frozen.executionSpec.model.model,
        max_tokens: 64,
        temperature: 0.7,
      });
      expect(f.original).toEqual(frozen);
      expect(f.request.snapshot).toEqual(frozen);
    } finally {
      prepared.release();
    }
  });

  it("cannot dispatch after release and keeps a judge from replacing an adopted foreground Provider", async () => {
    const f = setup();
    const released = f.client.prepare(f.request);
    released.release();
    try {
      await expect(released.complete()).rejects.toThrow();
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.fetchFn).not.toHaveBeenCalled();
      expect(f.onForegroundProvider).not.toHaveBeenCalled();
    } finally {
      released.release();
    }

    const foreground = f.client.prepare(f.request);
    try {
      await foreground.complete();
      expect(f.onForegroundProvider).toHaveBeenCalledOnce();
      const foregroundSignal = f.onForegroundProvider.mock.calls[0]![0];
      const request = {
        ...f.request,
        snapshot: structuredClone(f.original),
        purpose: "permission_judge" as const,
      };
      request.snapshot.executionSpec.model.maxOutputTokens = Math.min(
        256,
        request.snapshot.executionSpec.model.maxOutputTokens,
      );
      request.snapshot.executionSpec.model.temperature = 0;
      const judge = f.client.prepare(request);
      try {
        expect(judge.reservation).toEqual({ inputTokens: 8192, outputTokens: 64 });
        expect(f.onForegroundProvider).toHaveBeenCalledOnce();
        await judge.complete();
        expect(f.onForegroundProvider).toHaveBeenCalledExactlyOnceWith(foregroundSignal);
        expect(f.fetchFn).toHaveBeenCalledTimes(2);
        expect(sentBody(f.fetchFn.mock.calls[1]![1])).toMatchObject({
          model: f.original.executionSpec.model.model,
          max_tokens: 64,
          temperature: 0,
        });
      } finally {
        judge.release();
      }
    } finally {
      foreground.release();
    }
  });
});
