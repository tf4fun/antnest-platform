import { describe, expect, it } from "vitest";
import { promptBridgeIntent } from "../../src/transport/acp/v1/prompt-intent.js";

describe("ACP v1 Bridge prompt metadata", () => {
  it("keeps ordinary clients unchanged", () => {
    expect(promptBridgeIntent(undefined)).toBeUndefined();
    expect(promptBridgeIntent(null)).toBeUndefined();
    expect(promptBridgeIntent({ other: true })).toBeUndefined();
  });

  it("accepts only a stable intent and safe append version", () => {
    expect(
      promptBridgeIntent({
        "antnest.dev/intent": { intentId: "intent-1", expectedAppendVersion: 3 },
      }),
    ).toEqual({ intentId: "intent-1", expectedAppendVersion: 3 });
    for (const value of [
      {},
      { intentId: "" },
      { intentId: "intent-1", expectedAppendVersion: -1 },
      { intentId: "intent-1", expectedAppendVersion: 1.5 },
      { intentId: "intent-1", expectedAppendVersion: 3, principalId: "spoofed" },
    ]) {
      expect(() => promptBridgeIntent({ "antnest.dev/intent": value })).toThrowError(/intent/i);
    }
  });
});
