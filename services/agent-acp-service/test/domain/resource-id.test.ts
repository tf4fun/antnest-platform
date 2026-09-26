import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveResourceId, newResourceId, resourceKinds } from "../../src/domain/resource-id.js";

describe("platform resource IDs", () => {
  it("generates a distinct typed 128-bit identifier for every owned resource kind", () => {
    const seen = new Set<string>();
    for (const kind of resourceKinds) {
      for (let i = 0; i < 4; i++) {
        const value = newResourceId(kind);
        expect(value).toMatch(new RegExp(`^${kind}_[0-9a-f]{32}$`));
        expect(seen.has(value)).toBe(false);
        seen.add(value);
      }
    }
  });

  it("keeps retry identities deterministic and separates derivation purposes", () => {
    const key = "session_0123456789abcdef0123456789abcdef:5";
    const suffix = createHash("sha256").update(`fork-message\0${key}`).digest("hex").slice(0, 32);
    expect(deriveResourceId("message", "fork-message", key)).toBe(`message_${suffix}`);
    expect(deriveResourceId("message", "fork-message", key)).toBe(
      deriveResourceId("message", "fork-message", key),
    );
    expect(deriveResourceId("message", "recovery", key)).not.toBe(`message_${suffix}`);
    expect(deriveResourceId("message", "fork-message", key + "0")).not.toBe(`message_${suffix}`);
  });
});
