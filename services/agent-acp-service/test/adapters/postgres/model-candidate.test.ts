import { describe, expect, it } from "vitest";

import { frozenModelCandidate } from "../../../src/adapters/postgres/run-event-repository.js";
import type { RunExecutionSnapshot } from "../../../src/domain/types.js";
import { snapshot } from "../../support/fixtures.js";

function compactorSnapshot(): RunExecutionSnapshot {
  const run = snapshot();
  run.executionSpec.compactionModel = {
    modelProfileId: "compactor-1",
    providerConnectionId: "connection-1",
    model: { ...run.executionSpec.model, model: "summary-model" },
  };
  return run;
}

describe("frozenModelCandidate", () => {
  const primary = { modelProfileId: "profile-1", providerConnectionId: "connection-1" };

  it("accepts the configured compaction model for a compaction attempt", () => {
    const run = compactorSnapshot();
    expect(
      frozenModelCandidate(run, {
        modelProfileId: "compactor-1",
        providerConnectionId: "connection-1",
        model: "summary-model",
        purpose: "compaction",
      }),
    ).toEqual(run.executionSpec.compactionModel);
  });

  it("rejects an externally supplied non-frozen model for a compaction attempt", () => {
    const run = compactorSnapshot();
    expect(
      frozenModelCandidate(run, {
        modelProfileId: "foreign-1",
        providerConnectionId: "connection-1",
        model: "foreign-model",
        purpose: "compaction",
      }),
    ).toBeUndefined();
  });

  it("does not treat the configured compactor as a foreground candidate", () => {
    const run = compactorSnapshot();
    expect(
      frozenModelCandidate(run, {
        modelProfileId: "compactor-1",
        providerConnectionId: "connection-1",
        model: "summary-model",
        purpose: "foreground",
      }),
    ).toBeUndefined();
  });

  it("rejects the primary model for compaction when a dedicated model is configured", () => {
    const run = compactorSnapshot();
    expect(
      frozenModelCandidate(run, {
        ...primary,
        model: run.executionSpec.model.model,
        purpose: "compaction",
      }),
    ).toBeUndefined();
  });

  it("allows the primary model for compaction when no dedicated model is configured", () => {
    const run = snapshot();
    expect(
      frozenModelCandidate(run, {
        ...primary,
        model: run.executionSpec.model.model,
        purpose: "compaction",
      }),
    ).toMatchObject({ ...primary, model: run.executionSpec.model });
  });

  it("does not allow fallback candidates for compaction even with before_output failover", () => {
    const run = snapshot();
    run.executionSpec.fallbackModels = [
      {
        modelProfileId: "fallback-1",
        providerConnectionId: "connection-2",
        model: { ...run.executionSpec.model, model: "fallback-model" },
      },
    ];
    Reflect.set(run.executionSpec, "modelFailover", "before_output");
    expect(
      frozenModelCandidate(run, {
        modelProfileId: "fallback-1",
        providerConnectionId: "connection-2",
        model: "fallback-model",
        purpose: "compaction",
      }),
    ).toBeUndefined();
  });
});
