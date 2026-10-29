import { describe, expect, it, vi } from "vitest";
import {
  ProviderClients,
  type ProviderClientHandle,
} from "../../src/application/provider-clients.js";
import { RunModelClient } from "../../src/application/run-model-client.js";
import { parseExecutionConfiguration } from "../../src/domain/execution-configuration.js";
import type { ModelCandidate, RunExecutionSnapshot } from "../../src/domain/types.js";
import {
  ModelError,
  ModelTransportCleanupError,
  type AuthenticatedModelRequest,
  type AuthenticatedModelTransport,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
} from "../../src/ports/model.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { snapshot } from "../support/fixtures.js";

const knownUsage: ModelUsage = {
  inputTokens: 17,
  outputTokens: 3,
  cost: { amount: 0.000031, currency: "USD", source: "provider_reported" },
};

function result(): ModelResult {
  return {
    kind: "message",
    content: [{ type: "text", text: "completed" }],
    usage: structuredClone(knownUsage),
    stopReason: "end_turn",
  };
}

function errorChain(value: unknown): unknown[] {
  const seen = new Set<unknown>();
  const visit = (current: unknown): void => {
    if (seen.has(current)) return;
    seen.add(current);
    if (current instanceof AggregateError)
      for (const item of current.errors as unknown[]) visit(item);
    if (current instanceof Error && current.cause !== undefined) visit(current.cause);
  };
  visit(value);
  return [...seen];
}

function setup() {
  const primary: ModelCandidate = {
    modelProfileId: "model-1",
    providerConnectionId: "provider-1",
    model: {
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      contextWindow: 64_000,
      maxOutputTokens: 4096,
      temperature: 0.7,
      thinking: { protocol: "deepseek", effort: "low" },
      supportsImages: true,
      supportsAudio: false,
      supportsPdf: false,
      supportsTools: true,
      pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 },
    },
  };
  const fallback: ModelCandidate = {
    modelProfileId: "model-2",
    providerConnectionId: "provider-2",
    model: {
      ...structuredClone(primary.model),
      baseUrl: "https://provider-b.example.test/v1",
      model: "deepseek-v4-pro",
      contextWindow: 32_000,
      maxOutputTokens: 128,
      temperature: 0.3,
      thinking: { protocol: "deepseek", effort: "high" },
      pricing: { currency: "USD", inputPerMillion: 5, outputPerMillion: 9 },
    },
  };
  const original = snapshot();
  original.deadlineAt = new Date(Date.now() + 60_000);
  original.modelProfileId = primary.modelProfileId;
  original.providerConnectionId = primary.providerConnectionId;
  original.executionSpec.model = structuredClone(primary.model);
  original.executionSpec.modelFailover = "before_output";
  original.executionSpec.fallbackModels = [structuredClone(fallback)];

  const seed = executionConfiguration();
  const provider = seed.providers[0];
  const model = seed.models[0];
  if (provider === undefined || model === undefined) throw new Error("Missing catalog fixture");
  const configuration = parseExecutionConfiguration({
    ...seed,
    providers: [
      { ...provider, credential: { method: "api_key", secret: "synthetic-provider-a-key" } },
      {
        ...provider,
        connection_id: fallback.providerConnectionId,
        base_url: fallback.model.baseUrl,
        credential: { method: "api_key", secret: "synthetic-provider-b-key" },
      },
    ],
    models: [primary, fallback].map((candidate) => ({
      ...model,
      model_profile_id: candidate.modelProfileId,
      connection_id: candidate.providerConnectionId,
      model: candidate.model.model,
      context_window: candidate.model.contextWindow,
      max_output_tokens: candidate.model.maxOutputTokens,
      temperature: candidate.model.temperature,
      pricing: {
        currency: "USD",
        input_per_million: candidate.model.pricing?.inputPerMillion,
        output_per_million: candidate.model.pricing?.outputPerMillion,
      },
    })),
  });
  const calls = vi.fn<AuthenticatedModelTransport["complete"]>().mockResolvedValue(result());
  const providers = new ProviderClients({ complete: calls });
  providers.apply(configuration);
  const lifetimes: { connectionId: string; releases: number }[] = [];
  const acquire = vi.fn<ProviderClients["acquire"]>((organizationId, connectionId) => {
    const actual = providers.acquire(organizationId, connectionId);
    const lifetime = { connectionId, releases: 0 };
    lifetimes.push(lifetime);
    const handle: ProviderClientHandle = {
      signal: actual.signal,
      complete: (request) => actual.complete(request),
      release: () => {
        lifetime.releases += 1;
        actual.release();
      },
    };
    return handle;
  });
  const client = new RunModelClient({ providers: { acquire }, snapshot: original });
  return {
    client,
    providers,
    calls,
    acquire,
    lifetimes,
    original,
    primary,
    fallback,
    configuration,
  };
}

function requestFor(
  fixture: { original: RunExecutionSnapshot; primary: ModelCandidate },
  candidate = fixture.primary,
): ModelRequest {
  const selected = structuredClone(fixture.original);
  selected.modelProfileId = candidate.modelProfileId;
  selected.providerConnectionId = candidate.providerConnectionId;
  selected.executionSpec.model = structuredClone(candidate.model);
  return {
    snapshot: selected,
    messages: [{ role: "user", content: [{ type: "text", text: "original prompt" }] }],
    tools: [],
    signal: new AbortController().signal,
  };
}

function observe(task: Promise<ModelResult>) {
  return task.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

describe("Run model candidate clients", () => {
  it("lazily acquires each selected candidate and keeps its credential and frozen Run fields separate", async () => {
    const f = setup();
    const original = structuredClone(f.original);
    expect(f.acquire).not.toHaveBeenCalled();
    for (const candidate of [f.primary, f.fallback]) {
      const request = requestFor(f, candidate);
      expect(await f.client.complete(request)).toEqual(result());
      expect(request).not.toHaveProperty("credential");
    }
    expect(f.acquire.mock.calls).toEqual([
      [original.organizationId, f.primary.providerConnectionId],
      [original.organizationId, f.fallback.providerConnectionId],
    ]);
    expect(f.calls.mock.calls.map(([call]) => call.credential)).toEqual([
      "synthetic-provider-a-key",
      "synthetic-provider-b-key",
    ]);
    for (const [index, candidate] of [f.primary, f.fallback].entries()) {
      expect(f.calls.mock.calls[index]?.[0].snapshot).toEqual({
        ...original,
        modelProfileId: candidate.modelProfileId,
        providerConnectionId: candidate.providerConnectionId,
        executionSpec: { ...original.executionSpec, model: candidate.model },
      });
    }
    expect(f.original).toEqual(original);
    expect(f.lifetimes).toEqual([
      { connectionId: "provider-1", releases: 1 },
      { connectionId: "provider-2", releases: 1 },
    ]);
  });

  it("uses a rotated fallback credential without following newer catalog model parameters or prices", async () => {
    const f = setup();
    const frozen = structuredClone(f.fallback.model);
    await f.client.complete(requestFor(f, f.fallback));
    const changed = structuredClone(f.configuration);
    changed.revision += 1;
    changed.providers = changed.providers.map((provider) =>
      provider.connection_id === f.fallback.providerConnectionId && provider.enabled
        ? {
            ...provider,
            credential_revision: "credential-b-2",
            credential: { method: "api_key" as const, secret: "synthetic-rotated-provider-b-key" },
          }
        : provider,
    );
    changed.models = changed.models.map((model) =>
      model.model_profile_id === f.fallback.modelProfileId
        ? {
            ...model,
            model: "new-catalog-model",
            context_window: 128_000,
            max_output_tokens: 8192,
            temperature: 1.5,
            pricing: { currency: "USD", input_per_million: 50, output_per_million: 90 },
          }
        : model,
    );
    f.providers.apply(changed);
    await f.client.complete(requestFor(f, f.fallback));
    expect(f.calls.mock.calls.map(([call]) => call.credential)).toEqual([
      "synthetic-provider-b-key",
      "synthetic-rotated-provider-b-key",
    ]);
    expect(f.calls.mock.calls.map(([call]) => call.snapshot.executionSpec.model)).toEqual([
      frozen,
      frozen,
    ]);
    expect(f.original.executionSpec.fallbackModels?.[0]?.model).toEqual(frozen);
    expect(f.lifetimes.map((lifetime) => lifetime.releases)).toEqual([1, 1]);
  });

  it("rejects an old frozen fallback before dispatch after its Provider id is recreated at another endpoint", async () => {
    const f = setup();
    const original = structuredClone(f.original);
    const removed = structuredClone(f.configuration);
    removed.revision += 1;
    removed.providers = removed.providers.filter(
      (provider) => provider.connection_id !== f.fallback.providerConnectionId,
    );
    removed.models = removed.models.filter(
      (model) => model.connection_id !== f.fallback.providerConnectionId,
    );
    f.providers.apply(parseExecutionConfiguration(removed));
    expect(() =>
      f.providers.acquire(original.organizationId, f.fallback.providerConnectionId),
    ).toThrow("unavailable");

    const restored = structuredClone(f.configuration);
    restored.revision = removed.revision + 1;
    const newEndpoint = "https://replacement-provider-b.example.test/v1";
    const newSecret = "synthetic-recreated-provider-b-key";
    restored.providers = restored.providers.map((provider) =>
      provider.connection_id === f.fallback.providerConnectionId
        ? {
            ...provider,
            enabled: true,
            base_url: newEndpoint,
            credential_revision: "credential-recreated-b",
            credential: { method: "api_key", secret: newSecret },
          }
        : provider,
    ) as typeof restored.providers;
    f.providers.apply(parseExecutionConfiguration(restored));
    const request = requestFor(f, f.fallback);
    expect(request.snapshot.executionSpec.model.baseUrl).toBe(f.fallback.model.baseUrl);
    expect(request.snapshot.executionSpec.model.baseUrl).not.toBe(newEndpoint);
    await expect(f.client.complete(request)).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: false,
    });
    expect(f.calls).not.toHaveBeenCalled();
    expect(JSON.stringify(f.calls.mock.calls)).not.toContain(newSecret);
    expect(f.lifetimes.every((lifetime) => lifetime.releases === 1)).toBe(true);
    expect(f.original).toEqual(original);
  });

  it.each(["resolve", "reject"] as const)(
    "releases an attempt handle only after its original transport task settles (%s)",
    async (outcome) => {
      const f = setup();
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<ModelResult>();
      const sentinel = new Error("original-provider-failure");
      f.calls.mockImplementation(() => {
        entered.resolve();
        return held.promise;
      });
      const running = f.client.complete(requestFor(f, f.fallback));
      const observed = observe(running);
      try {
        await entered.promise;
        expect(f.lifetimes).toEqual([{ connectionId: "provider-2", releases: 0 }]);
        if (outcome === "resolve") held.resolve(result());
        else held.reject(sentinel);
        const completed = await observed;
        if (outcome === "resolve") expect(completed.value).toEqual(result());
        else expect(completed.error).toBe(sentinel);
        expect(f.lifetimes).toEqual([{ connectionId: "provider-2", releases: 1 }]);
      } finally {
        held.resolve(result());
        await Promise.allSettled([held.promise, running]);
      }
    },
  );

  it.each([undefined, "never"] as const)(
    "rejects a fallback candidate when the original failover policy is %s",
    async (policy) => {
      const f = setup();
      if (policy === undefined) delete f.original.executionSpec.modelFailover;
      else f.original.executionSpec.modelFailover = policy;
      const client = new RunModelClient({
        providers: { acquire: f.acquire },
        snapshot: f.original,
      });
      await expect(client.complete(requestFor(f, f.fallback))).rejects.toThrow();
      expect(f.calls).not.toHaveBeenCalled();
      expect(f.lifetimes.every((lifetime) => lifetime.releases === 1)).toBe(true);
    },
  );

  const invalid: { name: string; change: (request: ModelRequest) => void }[] = [
    {
      name: "organization",
      change: (r) => {
        r.snapshot.organizationId = "organization-2";
      },
    },
    {
      name: "unknown profile",
      change: (r) => {
        r.snapshot.modelProfileId = "unknown-model";
      },
    },
    {
      name: "provider/profile pair",
      change: (r) => {
        r.snapshot.providerConnectionId = "provider-1";
      },
    },
    {
      name: "model name",
      change: (r) => {
        r.snapshot.executionSpec.model.model = "other-model";
      },
    },
    {
      name: "base URL",
      change: (r) => {
        r.snapshot.executionSpec.model.baseUrl = "https://untrusted.example.test";
      },
    },
    {
      name: "context window",
      change: (r) => {
        r.snapshot.executionSpec.model.contextWindow += 1;
      },
    },
    {
      name: "output cap",
      change: (r) => {
        r.snapshot.executionSpec.model.maxOutputTokens += 1;
      },
    },
    {
      name: "temperature",
      change: (r) => {
        r.snapshot.executionSpec.model.temperature = 0;
      },
    },
    {
      name: "thinking",
      change: (r) => {
        r.snapshot.executionSpec.model.thinking = { protocol: "deepseek", effort: "off" };
      },
    },
    {
      name: "capabilities",
      change: (r) => {
        r.snapshot.executionSpec.model.supportsTools = false;
      },
    },
    {
      name: "pricing",
      change: (r) => {
        r.snapshot.executionSpec.model.pricing = {
          currency: "USD",
          inputPerMillion: 0,
          outputPerMillion: 0,
        };
      },
    },
    {
      name: "deadline",
      change: (r) => {
        r.snapshot.deadlineAt = new Date(r.snapshot.deadlineAt.getTime() + 1);
      },
    },
    {
      name: "access revision",
      change: (r) => {
        r.snapshot.accessRevision = "other-access";
      },
    },
    {
      name: "runtime target",
      change: (r) => {
        r.snapshot.runtime.connectionId = "rci_22222222222222222222222222222222";
      },
    },
    {
      name: "request budget",
      change: (r) => {
        r.snapshot.executionSpec.maxModelRequests += 1;
      },
    },
    {
      name: "system prompt",
      change: (r) => {
        r.snapshot.executionSpec.systemPrompt = "other system";
      },
    },
    {
      name: "candidate plan",
      change: (r) => {
        r.snapshot.executionSpec.fallbackModels = [];
      },
    },
  ];

  it.each(invalid)("does not dispatch a candidate with a changed $name", async ({ change }) => {
    const f = setup();
    f.providers.apply({ ...f.configuration, organization_id: "organization-2" });
    const request = requestFor(f, f.fallback);
    change(request);
    await expect(f.client.complete(request)).rejects.toThrow();
    expect(f.calls).not.toHaveBeenCalled();
    expect(f.lifetimes.every((lifetime) => lifetime.releases === 1)).toBe(true);
  });

  it.each(["primary", "fallback"] as const)(
    "permits only the bounded permission-judge model adjustment for %s",
    async (which) => {
      const f = setup();
      const candidate = which === "primary" ? f.primary : f.fallback;
      const request = requestFor(f, candidate);
      request.purpose = "permission_judge";
      request.snapshot.executionSpec.model.maxOutputTokens = Math.min(
        256,
        candidate.model.maxOutputTokens,
      );
      request.snapshot.executionSpec.model.temperature = 0;
      await f.client.complete(request);
      expect(f.calls).toHaveBeenCalledTimes(1);
      expect(f.calls.mock.calls[0]?.[0].snapshot.executionSpec.model).toEqual({
        ...candidate.model,
        maxOutputTokens: Math.min(256, candidate.model.maxOutputTokens),
        temperature: 0,
      });
      expect(f.calls.mock.calls[0]?.[0].credential).toBe(
        which === "primary" ? "synthetic-provider-a-key" : "synthetic-provider-b-key",
      );
      expect(f.lifetimes[0]?.releases).toBe(1);
    },
  );

  it.each([
    {
      name: "larger cap",
      change: (r: ModelRequest) => {
        r.snapshot.executionSpec.model.maxOutputTokens = 257;
      },
    },
    {
      name: "different bounded cap",
      change: (r: ModelRequest) => {
        r.snapshot.executionSpec.model.maxOutputTokens = 255;
      },
    },
    {
      name: "temperature",
      change: (r: ModelRequest) => {
        r.snapshot.executionSpec.model.temperature = 0.1;
      },
    },
    {
      name: "model identity",
      change: (r: ModelRequest) => {
        r.snapshot.executionSpec.model.model = "judge-only-model";
      },
    },
  ])("rejects an unauthorized permission-judge $name", async ({ change }) => {
    const f = setup();
    const request = requestFor(f);
    request.purpose = "permission_judge";
    request.snapshot.executionSpec.model.maxOutputTokens = 256;
    request.snapshot.executionSpec.model.temperature = 0;
    change(request);
    await expect(f.client.complete(request)).rejects.toThrow();
    expect(f.calls).not.toHaveBeenCalled();
    expect(f.lifetimes.every((lifetime) => lifetime.releases === 1)).toBe(true);
  });

  it("does not abort an active fallback when its now-inactive primary provider is revoked", async () => {
    const f = setup();
    await f.client.complete(requestFor(f));
    const entered = Promise.withResolvers<AuthenticatedModelRequest>();
    const held = Promise.withResolvers<ModelResult>();
    f.calls.mockImplementation((request) => {
      entered.resolve(request);
      return held.promise;
    });
    const running = f.client.complete(requestFor(f, f.fallback));
    const observed = observe(running);
    try {
      const active = await entered.promise;
      f.providers.apply({
        ...f.configuration,
        revision: 2,
        providers: f.configuration.providers.map((provider) =>
          provider.connection_id === f.primary.providerConnectionId
            ? { ...provider, enabled: false }
            : provider,
        ),
      });
      expect(active.signal.aborted).toBe(false);
      expect(f.lifetimes).toEqual([
        { connectionId: "provider-1", releases: 1 },
        { connectionId: "provider-2", releases: 0 },
      ]);
      held.resolve(result());
      expect((await observed).value).toEqual(result());
      expect(f.calls).toHaveBeenCalledTimes(2);
      expect(f.lifetimes[1]?.releases).toBe(1);
    } finally {
      held.resolve(result());
      await Promise.allSettled([held.promise, running]);
    }
  });

  it.each(["late success", "model error", "cleanup error"] as const)(
    "joins the revoked active candidate and preserves usage, output and independent failure (%s)",
    async (outcome) => {
      const f = setup();
      const entered = Promise.withResolvers<AuthenticatedModelRequest>();
      const aborted = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const cleanupSentinel = new Error("independent-provider-cleanup-private-canary");
      const cleanup = new ModelTransportCleanupError(cleanupSentinel, knownUsage, true);
      let originalSettled = false;
      let original: Promise<ModelResult> | undefined;
      f.calls.mockImplementation((request) => {
        request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        original = release.promise
          .then(() => {
            if (outcome === "cleanup error") throw cleanup;
            if (outcome === "model error") {
              const failure = new ModelError(
                "model_unavailable",
                "Interrupted provider",
                true,
                undefined,
                {
                  cause: request.signal.reason,
                },
              );
              failure.usage = structuredClone(knownUsage);
              failure.outputStarted = true;
              throw failure;
            }
            return result();
          })
          .finally(() => {
            originalSettled = true;
          });
        entered.resolve(request);
        return original;
      });
      let settled = false;
      const running = f.client.complete(requestFor(f, f.fallback));
      const observed = observe(running).then((completion) => {
        settled = true;
        return completion;
      });
      try {
        const active = await entered.promise;
        f.providers.apply({
          ...f.configuration,
          revision: 2,
          providers: f.configuration.providers.map((provider) =>
            provider.connection_id === f.fallback.providerConnectionId
              ? { ...provider, enabled: false }
              : provider,
          ),
        });
        await aborted.promise;
        await Promise.resolve();
        expect(active.signal.aborted).toBe(true);
        expect(originalSettled).toBe(false);
        expect(settled).toBe(false);
        expect(f.lifetimes).toEqual([{ connectionId: "provider-2", releases: 0 }]);
        release.resolve();
        const completed = await observed;
        expect(completed.error).toBeInstanceOf(ModelError);
        expect(completed.error).toMatchObject({
          code: "provider_unavailable",
          retryable: false,
          usage: knownUsage,
          outputStarted: true,
        });
        if (outcome === "cleanup error") {
          expect(completed.error).toBeInstanceOf(ModelTransportCleanupError);
          expect(errorChain(completed.error)).toContain(cleanup);
          expect(errorChain(completed.error)).toContain(cleanupSentinel);
        }
        expect(originalSettled).toBe(true);
        expect(f.lifetimes).toEqual([{ connectionId: "provider-2", releases: 1 }]);
        expect(f.calls).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await Promise.allSettled([running, ...(original === undefined ? [] : [original])]);
      }
    },
  );
});
