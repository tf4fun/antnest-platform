import { describe, expect, it } from "vitest";
import { bridgeIntentDigest } from "../../src/domain/bridge-intent.js";

describe("Bridge prompt intent digest", () => {
  it("canonicalizes object keys while preserving content block order and bytes", () => {
    const first = bridgeIntentDigest(3, [
      { type: "text", text: "hello" },
      { type: "resource", resource: { uri: "file:///a", text: "value" } },
    ]);
    const same = bridgeIntentDigest(3, [
      { text: "hello", type: "text" },
      { resource: { text: "value", uri: "file:///a" }, type: "resource" },
    ]);
    expect(first).toBe(same);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(
      bridgeIntentDigest(4, [
        { type: "text", text: "hello" },
        { type: "resource", resource: { uri: "file:///a", text: "value" } },
      ]),
    ).not.toBe(first);
    expect(
      bridgeIntentDigest(3, [
        { type: "resource", resource: { uri: "file:///a", text: "value" } },
        { type: "text", text: "hello" },
      ]),
    ).not.toBe(first);
  });
});
