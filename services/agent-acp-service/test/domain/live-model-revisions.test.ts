import { describe, expect, it } from "vitest";
import {
  parseExecutionConfiguration,
  parsePublicExecutionConfiguration,
  publicExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { parseExecutionAuthority } from "../../src/domain/execution-publication-v2.js";
import { runSnapshot } from "../../src/domain/run-snapshot.js";
import type { SessionConfiguration } from "../../src/domain/session-configuration.js";
import { parseStoredRunSnapshot } from "../../src/domain/stored-run-snapshot.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

function liveConfiguration() {
  const base = executionConfiguration();
  const providers = [1, 2, 3].map((index) => ({
    ...base.providers[0]!,
    connection_id: `provider-${index}`,
    base_url: `https://provider-${index}.example/v1`,
    credential_revision: `credential-${index}`,
  }));
  const models = [
    {
      ...base.models[0]!,
      model_profile_id: "model-1",
      connection_id: "provider-1",
      model_profile_revision: 7,
      compaction_model_profile_id: "model-3",
    },
    {
      ...base.models[0]!,
      model_profile_id: "model-2",
      connection_id: "provider-2",
      model_profile_revision: 4,
    },
    {
      ...base.models[0]!,
      model_profile_id: "model-3",
      connection_id: "provider-3",
      model_profile_revision: 9,
    },
  ];
  return {
    ...base,
    providers,
    models: models as typeof base.models,
    agents: base.agents.map((agent) => ({
      ...agent,
      failover: "before_output" as const,
      fallback_model_profile_ids: ["model-2"],
    })),
  };
}

function capture(configuration: unknown, overrides: SessionConfiguration = {}) {
  return runSnapshot({
    configuration: configuration as Parameters<typeof runSnapshot>[0]["configuration"],
    identity: executionIdentity(),
    overrides,
    accessRevision: "access-1",
    clientMcpRevisionId: "mcp-1",
    deadlineAt: new Date("2026-10-25T00:10:00.000Z"),
  });
}

describe("live model revisions", () => {
  it("accepts the current model revision on private, public and v2 publications", () => {
    const live = liveConfiguration();
    expect(
      parseExecutionConfiguration(structuredClone(live)).models[0]?.model_profile_revision,
    ).toBe(7);
    const publicWire = publicExecutionConfiguration(structuredClone(live));
    expect(parsePublicExecutionConfiguration(publicWire).models[0]?.model_profile_revision).toBe(7);
    const v2 = {
      ...structuredClone(live),
      schema_version: 2,
      providers: live.providers.map((provider) => ({
        connection_id: provider.connection_id,
        provider_key: provider.provider_key,
        request_protocol: provider.request_protocol,
        base_url: provider.base_url,
        enabled: provider.enabled,
        credential_revision: provider.credential_revision,
        credential: { ref: provider.connection_id, version: provider.credential_revision },
      })),
    };
    expect(parseExecutionAuthority(v2).models[0]?.model_profile_revision).toBe(7);
  });

  it("freezes the admitted primary, fallback and compactor revisions into the run snapshot", () => {
    const live = liveConfiguration();
    const admitted = capture(publicExecutionConfiguration(structuredClone(live)));
    expect(admitted.modelProfileRevision).toBe(7);
    expect(admitted.executionSpec.fallbackModels?.[0]?.modelProfileRevision).toBe(4);
    expect(admitted.executionSpec.compactionModel?.modelProfileRevision).toBe(9);

    const restored = parseStoredRunSnapshot(JSON.parse(JSON.stringify(admitted)));
    expect(restored.modelProfileRevision).toBe(7);
    expect(restored.executionSpec.fallbackModels?.[0]?.modelProfileRevision).toBe(4);
    expect(restored.executionSpec.compactionModel?.modelProfileRevision).toBe(9);

    const changed = structuredClone(live);
    (changed.models[0] as { model_profile_revision: number }).model_profile_revision = 8;
    const next = capture(publicExecutionConfiguration(changed));
    expect(next.modelProfileRevision).toBe(8);
    expect(admitted.modelProfileRevision).toBe(7);
  });

  it("keeps legacy publications free of the revision field without inventing one", () => {
    const live = liveConfiguration();
    for (const model of live.models) {
      delete (model as { model_profile_revision?: number }).model_profile_revision;
    }
    const admitted = capture(publicExecutionConfiguration(structuredClone(live)));
    expect(admitted.modelProfileRevision).toBeUndefined();
    expect("modelProfileRevision" in JSON.parse(JSON.stringify(admitted))).toBe(false);
    const restored = parseStoredRunSnapshot(JSON.parse(JSON.stringify(admitted)));
    expect(restored.modelProfileRevision).toBeUndefined();
    expect(restored.executionSpec.fallbackModels?.[0]?.modelProfileRevision).toBeUndefined();
    expect(restored.executionSpec.compactionModel?.modelProfileRevision).toBeUndefined();
    expect(restored.configurationRevision).toBe(admitted.configurationRevision);
  });

  it.each([0, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid publication revision %j",
    (revision) => {
      const live = liveConfiguration();
      (live.models[0] as { model_profile_revision: unknown }).model_profile_revision = revision;
      expect(() => parseExecutionConfiguration(structuredClone(live))).toThrow();
      expect(() => parsePublicExecutionConfiguration(structuredClone(live))).toThrow();
    },
  );

  it.each([
    { modelProfileRevision: 0 },
    { modelProfileRevision: "7" },
    { modelProfileRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects the invalid stored snapshot revision %j", (mutant) => {
    const admitted = capture(publicExecutionConfiguration(structuredClone(liveConfiguration())));
    const stored = JSON.parse(JSON.stringify(admitted)) as {
      modelProfileRevision?: unknown;
      executionSpec: { fallbackModels: Record<string, unknown>[] };
    };
    Object.assign(stored, mutant);
    expect(() => parseStoredRunSnapshot(stored)).toThrow();
    delete stored.modelProfileRevision;
    Object.assign(stored.executionSpec.fallbackModels[0]!, mutant);
    expect(() => parseStoredRunSnapshot(stored)).toThrow();
  });
});
