import { describe, expect, it } from "vitest";
import { snapshotWithModelCandidate } from "../../src/domain/run-snapshot.js";
import { snapshot } from "../support/fixtures.js";

describe("snapshotWithModelCandidate", () => {
  it("replaces the primary selection and carries the candidate revision", () => {
    const primary = { ...snapshot(), modelProfileRevision: 7 };
    const fallback = {
      modelProfileId: "model-2",
      providerConnectionId: "provider-2",
      modelProfileRevision: 4,
      model: { ...primary.executionSpec.model, model: "fallback-model" },
    };
    const selected = snapshotWithModelCandidate(primary, fallback);
    expect(selected.modelProfileId).toBe("model-2");
    expect(selected.providerConnectionId).toBe("provider-2");
    expect(selected.modelProfileRevision).toBe(4);
    expect(selected.executionSpec.model.model).toBe("fallback-model");
    expect(primary.modelProfileRevision).toBe(7);
    expect(selected.agentExecutionSpecDigest).toBe(primary.agentExecutionSpecDigest);
    expect(selected.configurationRevision).toBe(primary.configurationRevision);
  });

  it("clears the admitted revision for a legacy candidate instead of inheriting it", () => {
    const primary = { ...snapshot(), modelProfileRevision: 7 };
    const legacy = {
      modelProfileId: "model-2",
      providerConnectionId: "provider-2",
      model: { ...primary.executionSpec.model, model: "fallback-model" },
    };
    const selected = snapshotWithModelCandidate(primary, legacy);
    expect(selected.modelProfileId).toBe("model-2");
    expect(selected.modelProfileRevision).toBeUndefined();
    expect("modelProfileRevision" in selected).toBe(false);
    expect(primary.modelProfileRevision).toBe(7);
  });

  it("preserves the revision when the same primary is reselected", () => {
    const primary = { ...snapshot(), modelProfileRevision: 7 };
    const again = {
      modelProfileId: primary.modelProfileId,
      providerConnectionId: primary.providerConnectionId,
      modelProfileRevision: 7,
      model: primary.executionSpec.model,
    };
    const selected = snapshotWithModelCandidate(primary, again);
    expect(selected.modelProfileRevision).toBe(7);
    expect(selected.modelProfileId).toBe(primary.modelProfileId);
  });
});
