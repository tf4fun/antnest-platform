import { describe, expect, it } from "vitest";

import { LearningChangeCursor } from "../../src/domain/learning-change-cursor.js";

const scope = { organizationId: "org-1", agentId: "agent-1", ownerId: "owner-1" };
const codec = new LearningChangeCursor(Buffer.alloc(32, 7), () => 1_790_700_000);

describe("Skill learning change cursor", () => {
  it("accepts genesis only as a forward cursor", () => {
    expect(codec.decode("0", scope, "after")).toBe("0");
    expect(() => codec.decode("0", scope, "before")).toThrow();
  });

  it("round-trips a bounded cursor with scope and direction", () => {
    const value = codec.encode(scope, "after", "42");
    expect(value).not.toBe("42");
    expect(codec.decode(value, scope, "after")).toBe("42");
    expect(() => codec.decode(value, scope, "before")).toThrow();
    expect(() => codec.decode(value, { ...scope, ownerId: "owner-2" }, "after")).toThrow();
  });

  it("rejects tampering, expired tokens and invalid sequence values", () => {
    const value = codec.encode(scope, "before", "9223372036854775807");
    expect(codec.decode(value, scope, "before")).toBe("9223372036854775807");
    expect(() => codec.decode(`${value}x`, scope, "before")).toThrow();
    expect(() => codec.encode(scope, "after", "01")).toThrow();
    expect(() => codec.encode(scope, "after", "9223372036854775808")).toThrow();
    const later = new LearningChangeCursor(Buffer.alloc(32, 7), () => 1_790_800_000);
    expect(() => later.decode(value, scope, "before")).toThrow();
  });
});
