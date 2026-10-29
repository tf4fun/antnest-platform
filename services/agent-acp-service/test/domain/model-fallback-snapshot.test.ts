import { describe, expect, it } from "vitest";
import {
  parseExecutionConfiguration,
  parsePublicExecutionConfiguration,
  publicExecutionConfiguration,
  resolveExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { runSnapshot } from "../../src/domain/run-snapshot.js";
import type { SessionConfiguration } from "../../src/domain/session-configuration.js";
import { parseStoredRunSnapshot } from "../../src/domain/stored-run-snapshot.js";
import type { ModelSpec } from "../../src/domain/types.js";
import {
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../fixtures/execution-configuration.js";
import { snapshot as legacySnapshot } from "../support/fixtures.js";

type Failover = "never" | "before_output";
type Candidate = {
  modelProfileId: string;
  providerConnectionId: string;
  model: ModelSpec & { supportsTools?: boolean };
};

const fallbackIds = ["model-3", "model-4", "model-2", "model-5"];

function configurations(failover?: Failover) {
  const original = executionConfiguration();
  const publicOriginal = publicExecutionConfiguration(original);
  const providers = [1, 2, 3, 4, 5].map((index) => ({
    ...original.providers[0]!,
    connection_id: `provider-${index}`,
    base_url: `https://provider-${index}.example/v1`,
    enabled: index !== 5,
    credential_revision: `credential-${index}`,
    credential: {
      method: "api_key" as const,
      secret: `synthetic-fallback-provider-secret-${index}`,
    },
  }));
  const models = [1, 2, 3, 4, 5].map((index) => ({
    ...original.models[0]!,
    model_profile_id: `model-${index}`,
    connection_id: `provider-${index}`,
    enabled: index !== 4,
    model:
      index === 1 ? "deepseek-v4-flash" : index === 2 ? "deepseek-v4-pro" : `ordinary-${index}`,
    context_window: 64_000 + index * 1000,
    max_output_tokens: 1024 + index,
    temperature: index / 10,
    supports_images: index % 2 === 0,
    supports_audio: index === 2,
    supports_pdf: index === 3,
    supports_tools: index !== 3,
    pricing: {
      currency: "USD" as const,
      input_per_million: index,
      output_per_million: index * 2,
      cache_read_per_million: index / 10,
      cache_write_per_million: index / 5,
    },
  }));
  const fields = {
    fallback_model_profile_ids: [...fallbackIds],
    ...(failover === undefined ? {} : { failover }),
  };
  return {
    private: {
      ...original,
      providers,
      models,
      agents: original.agents.map((agent) => ({ ...agent, ...fields })),
    },
    public: structuredClone({
      ...publicOriginal,
      providers: providers.map(({ credential, ...provider }) => {
        void credential;
        return provider;
      }),
      models,
      agents: publicOriginal.agents.map((agent) => ({ ...agent, ...fields })),
    }),
  };
}

function capture(
  configuration: Parameters<typeof runSnapshot>[0]["configuration"],
  overrides: SessionConfiguration = {},
) {
  return runSnapshot({
    configuration,
    identity: executionIdentity(),
    overrides,
    accessRevision: "access-1",
    clientMcpRevisionId: "mcp-1",
    deadlineAt: new Date("2026-10-25T00:10:00.000Z"),
  });
}

function expectedCandidate(index: number): Candidate {
  return {
    modelProfileId: `model-${index}`,
    providerConnectionId: `provider-${index}`,
    model: {
      baseUrl: `https://provider-${index}.example/v1`,
      model: index === 2 ? "deepseek-v4-pro" : `ordinary-${index}`,
      contextWindow: 64_000 + index * 1000,
      maxOutputTokens: 1024 + index,
      temperature: index / 10,
      supportsImages: index % 2 === 0,
      supportsAudio: index === 2,
      supportsPdf: index === 3,
      supportsTools: index !== 3,
      pricing: {
        currency: "USD",
        inputPerMillion: index,
        outputPerMillion: index * 2,
        cacheReadPerMillion: index / 10,
        cacheWritePerMillion: index / 5,
      },
    },
  };
}

function plan(executionSpec: object): Candidate[] {
  const value: unknown = Reflect.get(executionSpec, "fallbackModels");
  expect(value).toBeInstanceOf(Array);
  return value as Candidate[];
}

function storedSpec() {
  const original = legacySnapshot();
  return {
    ...original,
    deadlineAt: original.deadlineAt.toISOString(),
    executionSpec: {
      ...original.executionSpec,
      modelFailover: "before_output",
      fallbackModels: [expectedCandidate(2)],
    } as Record<string, unknown>,
  };
}

describe("model fallback publication and immutable Run plan", () => {
  it.each(["never", "before_output"] as const)(
    "round-trips explicit %s with ordered, complete and credential-free candidates",
    (failover) => {
      const inputs = configurations(failover);
      const privateConfiguration = parseExecutionConfiguration(inputs.private);
      expect(privateConfiguration.agents[0]).toHaveProperty("failover", failover);
      expect(privateConfiguration.models[1]).toHaveProperty("supports_tools", true);
      expect(privateConfiguration.models[2]).toHaveProperty("supports_tools", false);
      const projected = publicExecutionConfiguration(privateConfiguration);
      expect(projected).toStrictEqual(inputs.public);
      const configuration = parsePublicExecutionConfiguration(projected);
      expect(configuration).toStrictEqual(inputs.public);
      expect(
        resolveExecutionConfiguration(privateConfiguration, executionIdentity(), {}),
      ).toStrictEqual(resolveExecutionConfiguration(configuration, executionIdentity(), {}));

      const run = capture(configuration);
      expect(run.executionSpec).toHaveProperty("modelFailover", failover);
      expect(run.executionSpec).toHaveProperty("fallbackModels", [
        expectedCandidate(3),
        expectedCandidate(2),
      ]);
      expect(run.executionSpec.model).toHaveProperty("supportsTools", true);
      const record: unknown = JSON.parse(JSON.stringify(run));
      expect(parseStoredRunSnapshot(record)).toStrictEqual(run);
      for (const value of [projected, run, record]) {
        const serialized = JSON.stringify(value);
        for (const provider of inputs.private.providers)
          expect(serialized).not.toContain(provider.credential.secret);
        expect(serialized).not.toContain(runtimeConfiguration().credential.token);
      }
      for (const candidate of plan(run.executionSpec)) {
        expect(candidate).not.toHaveProperty("credential");
        expect(candidate.model).not.toHaveProperty("credential");
      }
      expect(run.runtime).not.toHaveProperty("credential");
    },
  );

  it("keeps legacy wire and stored Runs unchanged without materializing failover or tools capability", () => {
    const original = executionConfiguration();
    const parsed = parseExecutionConfiguration(original);
    expect(parsed).toStrictEqual(original);
    const projected = publicExecutionConfiguration(parsed);
    expect(parsePublicExecutionConfiguration(projected)).toStrictEqual(projected);
    expect(projected.agents[0]).not.toHaveProperty("failover");
    expect(projected.models[0]).not.toHaveProperty("supports_tools");
    const run = capture(projected);
    expect(run.executionSpec).not.toHaveProperty("modelFailover");
    expect(run.executionSpec).not.toHaveProperty("fallbackModels");
    expect(run.executionSpec.model).not.toHaveProperty("supportsTools");
    const stored = legacySnapshot();
    expect(parseStoredRunSnapshot(JSON.parse(JSON.stringify(stored)) as unknown)).toStrictEqual(
      stored,
    );
  });

  it("does not create a runtime fallback plan from legacy fallback ids alone", () => {
    const inputs = configurations();
    const run = capture(publicExecutionConfiguration(parseExecutionConfiguration(inputs.private)));
    expect(run.executionSpec).not.toHaveProperty("modelFailover");
    expect(run.executionSpec).not.toHaveProperty("fallbackModels");
    expect(run.executionSpec.model).toHaveProperty("supportsTools", true);
  });

  it("keeps an explicit Session model as primary and removes only that effective primary from the configured sequence", () => {
    const configuration = parsePublicExecutionConfiguration(configurations("before_output").public);
    const run = capture(configuration, { modelProfileId: "model-2" });
    expect(run.modelProfileId).toBe("model-2");
    expect(run.providerConnectionId).toBe("provider-2");
    expect(plan(run.executionSpec).map((candidate) => candidate.modelProfileId)).toEqual([
      "model-3",
    ]);
    expect(() => capture(configuration, { modelProfileId: "foreign-or-unknown-model" })).toThrow();
  });

  it.each(["never", "before_output"] as const)(
    "preserves disabled-default selection and inherits its actual absent thinking under %s",
    (failover) => {
      const input = configurations(failover);
      input.private.models[0]!.enabled = false;
      const configuration = publicExecutionConfiguration(
        parseExecutionConfiguration(input.private),
      );
      const run = capture(configuration, { thinkingEffort: "high" });
      expect(run.modelProfileId).toBe("model-3");
      expect(run.providerConnectionId).toBe("provider-3");
      expect(run.executionSpec.model).not.toHaveProperty("thinking");
      expect(run.executionSpec).toHaveProperty("modelFailover", failover);
      expect(plan(run.executionSpec)).toEqual([expectedCandidate(2)]);
      expect(plan(run.executionSpec)[0]?.model).not.toHaveProperty("thinking");
    },
  );

  it.each(["off", "high"] as const)(
    "retains exact effective thinking=%s and excludes a different provider even with a known model name",
    (effort) => {
      const inputs = configurations("before_output");
      inputs.private.providers[2]!.provider_key = "openrouter";
      inputs.private.models[2]!.model = "deepseek-v4-pro";
      const configuration = publicExecutionConfiguration(
        parseExecutionConfiguration(inputs.private),
      );
      const run = capture(configuration, { thinkingEffort: effort });
      expect(run.executionSpec.model).toHaveProperty("thinking", { protocol: "deepseek", effort });
      expect(plan(run.executionSpec)).toEqual([
        {
          ...expectedCandidate(2),
          model: { ...expectedCandidate(2).model, thinking: { protocol: "deepseek", effort } },
        },
      ]);
    },
  );

  it("does not infer thinking capability from an unknown model name or silently downgrade the effort", () => {
    const inputs = configurations("before_output");
    inputs.private.models[1]!.model = "deepseek-v4-pro-unverified";
    const configuration = publicExecutionConfiguration(parseExecutionConfiguration(inputs.private));
    const run = capture(configuration, { thinkingEffort: "high" });
    expect(run.executionSpec.model).toHaveProperty("thinking", {
      protocol: "deepseek",
      effort: "high",
    });
    expect(run.executionSpec).toHaveProperty("fallbackModels", []);
  });

  it.each([null, true, 1, "fallback", {}, []])(
    "rejects invalid failover %j in private, public and stored shapes",
    (value) => {
      const inputs = configurations("before_output");
      Reflect.set(inputs.private.agents[0]!, "failover", value);
      Reflect.set(inputs.public.agents[0]!, "failover", value);
      expect(() => parseExecutionConfiguration(inputs.private)).toThrow();
      expect(() => parsePublicExecutionConfiguration(inputs.public)).toThrow();
      const stored = storedSpec();
      stored.executionSpec.modelFailover = value;
      expect(() => parseStoredRunSnapshot(stored)).toThrow();
    },
  );

  it.each([null, 0, 1, "true", {}, []])(
    "rejects invalid supports_tools %j instead of coercing or dropping it",
    (value) => {
      const inputs = configurations("before_output");
      Reflect.set(inputs.private.models[1]!, "supports_tools", value);
      Reflect.set(inputs.public.models[1]!, "supports_tools", value);
      expect(() => parseExecutionConfiguration(inputs.private)).toThrow();
      expect(() => parsePublicExecutionConfiguration(inputs.public)).toThrow();
      const primary = storedSpec();
      const primaryModel = primary.executionSpec.model as Record<string, unknown>;
      primaryModel.supportsTools = value;
      expect(() => parseStoredRunSnapshot(primary)).toThrow();
      const fallback = storedSpec();
      const candidate = (fallback.executionSpec.fallbackModels as Candidate[])[0]!;
      Reflect.set(candidate.model, "supportsTools", value);
      expect(() => parseStoredRunSnapshot(fallback)).toThrow();
    },
  );

  it.each(["modelFailover", "fallbackModels"] as const)(
    "rejects an incomplete stored plan missing %s",
    (field) => {
      const record = storedSpec();
      delete record.executionSpec[field];
      expect(() => parseStoredRunSnapshot(record)).toThrow();
    },
  );

  it("includes candidate prices and configured order in the execution-spec digest without changing primary parameters", () => {
    const inputs = configurations("before_output");
    const current = capture(parsePublicExecutionConfiguration(inputs.public));
    const changedPrice = structuredClone(inputs.public);
    changedPrice.models[1]!.pricing.output_per_million += 1;
    const repriced = capture(parsePublicExecutionConfiguration(changedPrice));
    expect(repriced.executionSpec.model).toStrictEqual(current.executionSpec.model);
    expect(repriced.agentExecutionSpecDigest).not.toBe(current.agentExecutionSpecDigest);
    const changedOrder = structuredClone(inputs.public);
    changedOrder.agents[0]!.fallback_model_profile_ids = [...fallbackIds].reverse();
    const reordered = capture(parsePublicExecutionConfiguration(changedOrder));
    expect(plan(reordered.executionSpec).map((candidate) => candidate.modelProfileId)).toEqual([
      "model-2",
      "model-3",
    ]);
    expect(reordered.agentExecutionSpecDigest).not.toBe(current.agentExecutionSpecDigest);
    expect(plan(current.executionSpec).map((candidate) => candidate.modelProfileId)).toEqual([
      "model-3",
      "model-2",
    ]);
  });

  it("isolates admitted candidate parameters and nested prices from publication and other capture aliases", () => {
    const configuration = parsePublicExecutionConfiguration(configurations("before_output").public);
    const run = capture(configuration);
    const separate = capture(configuration);
    const original = structuredClone(run);
    const captured = plan(run.executionSpec);
    const otherPlan = plan(separate.executionSpec);
    expect(captured).not.toBe(otherPlan);
    expect(captured[1]?.model.pricing).not.toBe(configuration.models[1]?.pricing);
    expect(captured[1]?.model.pricing).not.toBe(otherPlan[1]?.model.pricing);

    configuration.agents[0]!.fallback_model_profile_ids!.reverse();
    configuration.models[1]!.model = "later-model";
    configuration.models[1]!.pricing!.input_per_million = 99;
    Reflect.set(configuration.models[1]!, "supports_tools", false);
    expect(run).toStrictEqual(original);
    expect(separate).toStrictEqual(original);
    captured[1]!.model.pricing!.inputPerMillion = 77;
    expect(separate).toStrictEqual(original);
    expect(configuration.models[1]!.pricing!.input_per_million).toBe(99);
    const record: unknown = JSON.parse(JSON.stringify(separate));
    expect(parseStoredRunSnapshot(record)).toStrictEqual(original);
  });

  it("freezes the primary tokenizer and resolved compaction model into the Run snapshot and replay", () => {
    const inputs = configurations();
    Reflect.set(inputs.private.models[0]!, "tokenizer", "o200k");
    Reflect.set(inputs.private.models[0]!, "compaction_model_profile_id", "model-2");
    Reflect.set(inputs.private.models[1]!, "tokenizer", "cl100k");
    const configuration = publicExecutionConfiguration(parseExecutionConfiguration(inputs.private));
    const run = capture(configuration);
    expect(run.executionSpec.model).toHaveProperty("tokenizer", "o200k");
    expect(run.executionSpec).toHaveProperty("compactionModel", {
      ...expectedCandidate(2),
      model: { ...expectedCandidate(2).model, tokenizer: "cl100k" },
    });
    const record: unknown = JSON.parse(JSON.stringify(run));
    expect(parseStoredRunSnapshot(record)).toStrictEqual(run);
  });

  it("replays stored compaction and tokenizer fields while older snapshots without them stay valid", () => {
    const stored = legacySnapshot();
    Reflect.set(stored.executionSpec.model, "tokenizer", "o200k");
    const compactionModel = {
      modelProfileId: "model-compaction",
      providerConnectionId: "provider-compaction",
      model: {
        ...structuredClone(stored.executionSpec.model),
        model: "compaction-model",
        tokenizer: "cl100k",
      },
    };
    Reflect.set(stored.executionSpec, "compactionModel", compactionModel);
    const replayed = parseStoredRunSnapshot(JSON.parse(JSON.stringify(stored)) as unknown);
    expect(replayed.executionSpec.model).toHaveProperty("tokenizer", "o200k");
    expect(replayed.executionSpec).toHaveProperty("compactionModel", compactionModel);
    const legacy = parseStoredRunSnapshot(JSON.parse(JSON.stringify(legacySnapshot())) as unknown);
    expect(legacy.executionSpec.model).not.toHaveProperty("tokenizer");
    expect(legacy.executionSpec).not.toHaveProperty("compactionModel");
  });
});
