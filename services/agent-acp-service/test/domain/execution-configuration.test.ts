import { describe, expect, it } from "vitest";
import {
  parseExecutionConfiguration,
  parsePublicExecutionConfiguration,
  publicExecutionConfiguration,
  resolveExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

describe("execution configuration", () => {
  it("accepts an empty organization without confusing it with an incomplete snapshot", () => {
    const empty = {
      organization_id: "organization-1",
      revision: 1,
      providers: [],
      models: [],
      agents: [],
    };
    expect(parseExecutionConfiguration(empty)).toEqual(empty);
    expect(() =>
      parseExecutionConfiguration({ organization_id: "organization-1", revision: 1 }),
    ).toThrow();
  });

  it.each([
    ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["zero revision", { revision: 0 }],
    ["unknown field", { admission_id: "old-admission" }],
    ["missing organization", { organization_id: "" }],
  ])("rejects %s", (_name, change) => {
    expect(() => parseExecutionConfiguration({ ...executionConfiguration(), ...change })).toThrow();
  });

  it.each(["providers", "models", "agents"] as const)(
    "rejects duplicate %s identifiers",
    (collection) => {
      const snapshot = executionConfiguration();
      const duplicated = [...snapshot[collection], ...snapshot[collection]];
      expect(() =>
        parseExecutionConfiguration({ ...snapshot, [collection]: duplicated }),
      ).toThrow();
    },
  );

  it("rejects dangling provider and default-model references", () => {
    const snapshot = executionConfiguration();
    expect(() => parseExecutionConfiguration({ ...snapshot, providers: [] })).toThrow();
    expect(() => parseExecutionConfiguration({ ...snapshot, models: [] })).toThrow();
  });

  it("rejects unsupported providers and credential methods instead of silently adapting them", () => {
    const snapshot = executionConfiguration();
    const provider = snapshot.providers[0];
    expect(() =>
      parseExecutionConfiguration({
        ...snapshot,
        providers: [{ ...provider, provider_key: "other" }],
      }),
    ).toThrow();
    expect(() =>
      parseExecutionConfiguration({
        ...snapshot,
        providers: [{ ...provider, credential: { method: "oauth", secret: "synthetic" } }],
      }),
    ).toThrow();
  });

  it("requires credentials only for enabled providers", () => {
    const snapshot = executionConfiguration();
    const provider = snapshot.providers[0];
    expect(() =>
      parseExecutionConfiguration({
        ...snapshot,
        providers: [{ ...provider, credential: undefined }],
      }),
    ).toThrow();
    const disabled = {
      connection_id: "provider-1",
      provider_key: "deepseek",
      request_protocol: "openai_chat_completions",
      base_url: "https://api.deepseek.com",
      enabled: false,
    };
    expect(parseExecutionConfiguration({ ...snapshot, providers: [disabled] }).providers).toEqual([
      disabled,
    ]);
    expect(() =>
      parseExecutionConfiguration({
        ...snapshot,
        providers: [{ ...disabled, credential: provider?.credential }],
      }),
    ).toThrow();
  });

  it("accepts paired authentication for disabled connections but never persists their secret", () => {
    const fixture = executionConfiguration();
    const provider = { ...fixture.providers[0], enabled: false };
    const configuration = parseExecutionConfiguration({ ...fixture, providers: [provider] });
    const stored = publicExecutionConfiguration(configuration);
    expect(stored.providers[0]).toMatchObject({
      enabled: false,
      credential_revision: "credential-1",
    });
    expect(stored.providers[0]).not.toHaveProperty("credential");
    expect(JSON.stringify(stored)).not.toContain("synthetic-provider-key");
    expect(parsePublicExecutionConfiguration(stored)).toEqual(stored);
    expect(() => parsePublicExecutionConfiguration(configuration)).toThrow();
  });

  it.each(["credential", "credential_revision"] as const)(
    "rejects a disabled connection with missing %s from its authentication pair",
    (field) => {
      const fixture = executionConfiguration();
      const provider = { ...fixture.providers[0], enabled: false, [field]: undefined };
      expect(() => parseExecutionConfiguration({ ...fixture, providers: [provider] })).toThrow();
    },
  );

  it("rejects embedded URL authentication and non-HTTP endpoints", () => {
    const snapshot = executionConfiguration();
    for (const base_url of [
      "file:///tmp/provider",
      "https://user:pass@api.example.test",
      "https://api.example.test/#fragment",
    ]) {
      expect(() =>
        parseExecutionConfiguration({
          ...snapshot,
          providers: [{ ...snapshot.providers[0], base_url }],
        }),
      ).toThrow();
    }
  });

  it("permits an unavailable Agent without a Runtime but never an accepting one", () => {
    const snapshot = executionConfiguration();
    const agent = {
      ...snapshot.agents[0],
      runtime: null,
      agent_spec_revision: null,
      execution_revision: null,
    };
    expect(() => parseExecutionConfiguration({ ...snapshot, agents: [agent] })).toThrow();
    expect(
      parseExecutionConfiguration({
        ...snapshot,
        agents: [{ ...agent, accepting_runs: false, unavailable_reason: "building" }],
      }).agents[0]?.runtime,
    ).toBeNull();
  });

  it("removes all credential payloads from the persistent representation without mutating input", () => {
    const snapshot = parseExecutionConfiguration(executionConfiguration());
    const stored = publicExecutionConfiguration(snapshot);
    expect(JSON.stringify(stored)).not.toContain("synthetic-provider-key");
    expect(stored.providers[0]).not.toHaveProperty("credential");
    expect(stored.providers[0]).toHaveProperty("credential_revision", "credential-1");
    stored.agents[0]?.principal_ids.push("other");
    expect(snapshot.agents[0]?.principal_ids).toEqual(["principal-1"]);
  });

  it("resolves defaults and explicit model selection from the same current catalog", () => {
    const snapshot = executionConfiguration();
    const next = parseExecutionConfiguration({
      ...snapshot,
      models: snapshot.models.map((model) => ({ ...model, context_window: 128000 })),
    });
    const implicit = resolveExecutionConfiguration(next, executionIdentity(), {});
    const explicit = resolveExecutionConfiguration(next, executionIdentity(), {
      modelProfileId: "model-1",
    });
    expect(implicit).toEqual(explicit);
    expect(implicit.model.contextWindow).toBe(128000);
    expect(implicit.providerConnectionId).toBe("provider-1");
    expect(JSON.stringify(implicit)).not.toContain("synthetic-provider-key");
  });

  it("copies the selected model so a later catalog change cannot rewrite a Run", () => {
    const snapshot = parseExecutionConfiguration(executionConfiguration());
    const selected = resolveExecutionConfiguration(snapshot, executionIdentity(), {});
    const model = snapshot.models[0];
    if (model === undefined) throw new Error("Missing fixture model");
    model.model = "new-model";
    expect(selected.model.model).toBe("test-model");
  });

  it.each([
    { organizationId: "other-organization" },
    { principalId: "other-principal" },
    { agentId: "other-agent" },
  ])("rejects identity outside the local projection: %j", (change) => {
    const snapshot = parseExecutionConfiguration(executionConfiguration());
    expect(() =>
      resolveExecutionConfiguration(snapshot, { ...executionIdentity(), ...change }, {}),
    ).toThrow("access");
  });

  it("rejects closed Agents and unavailable model selections locally", () => {
    const fixture = executionConfiguration();
    const snapshot = parseExecutionConfiguration(fixture);
    expect(() =>
      resolveExecutionConfiguration(snapshot, executionIdentity(), { modelProfileId: "missing" }),
    ).toThrow("model");
    const disabled = parseExecutionConfiguration({
      ...fixture,
      agents: fixture.agents.map((agent) => ({
        ...agent,
        accepting_runs: false,
        unavailable_reason: "disabled",
      })),
    });
    expect(() => resolveExecutionConfiguration(disabled, executionIdentity(), {})).toThrow(
      "disabled",
    );
    const noModel = parseExecutionConfiguration({
      ...fixture,
      models: fixture.models.map((model) => ({ ...model, enabled: false })),
    });
    expect(() => resolveExecutionConfiguration(noModel, executionIdentity(), {})).toThrow("model");
  });

  it("allows Session approval overrides without bypassing identity or model ownership", () => {
    const snapshot = parseExecutionConfiguration(executionConfiguration());
    const selected = resolveExecutionConfiguration(snapshot, executionIdentity(), {
      authorizationMode: "auto",
    });
    expect(selected.authorization.mode).toBe("auto");
    expect(() =>
      resolveExecutionConfiguration(
        snapshot,
        { ...executionIdentity(), principalId: "other" },
        { authorizationMode: "auto" },
      ),
    ).toThrow("access");
  });
});
