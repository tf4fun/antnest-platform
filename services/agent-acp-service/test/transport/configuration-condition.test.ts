import { describe, expect, it } from "vitest";
import { configurationCondition } from "../../src/transport/acp/v1/configuration-condition.js";

describe("Bridge configuration condition", () => {
  it("accepts a canonical producer revision while leaving ordinary ACP requests unchanged", () => {
    expect(configurationCondition(undefined)).toBeUndefined();
    expect(configurationCondition({ other: true })).toBeUndefined();
    expect(
      configurationCondition({
        "antnest.dev/configuration": {
          expectedRevision: "a".repeat(64),
        },
      }),
    ).toBe("a".repeat(64));
  });

  it.each([
    null,
    {},
    { expectedRevision: "stale" },
    { expectedRevision: "a".repeat(64), sessionId: "other" },
  ])("rejects malformed metadata %j", (value) => {
    expect(() => configurationCondition({ "antnest.dev/configuration": value })).toThrowError(
      /configuration/i,
    );
  });
});
