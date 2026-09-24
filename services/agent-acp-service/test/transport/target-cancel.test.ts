import { describe, expect, it } from "vitest";
import { targetCancelRunId } from "../../src/transport/acp/v1/target-cancel.js";

describe("ACP v1 targeted cancellation metadata", () => {
  it("keeps ordinary session cancellation when metadata is absent", () => {
    expect(targetCancelRunId(undefined)).toBeUndefined();
    expect(targetCancelRunId(null)).toBeUndefined();
    expect(targetCancelRunId({ another: { value: 1 } })).toBeUndefined();
  });

  it("uses only a valid named Run target", () => {
    expect(targetCancelRunId({ "antnest.dev/target-cancel": { expectedRunId: "run-1" } })).toBe(
      "run-1",
    );
    for (const value of [
      {},
      { expectedRunId: "" },
      { expectedRunId: 42 },
      { expectedRunId: "run-1", principalId: "spoofed" },
    ]) {
      expect(() => targetCancelRunId({ "antnest.dev/target-cancel": value })).toThrowError(
        /target/i,
      );
    }
  });
});
