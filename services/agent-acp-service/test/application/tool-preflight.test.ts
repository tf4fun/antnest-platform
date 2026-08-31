import { describe, expect, it } from "vitest";

import { ToolPreflight } from "../../src/application/tool-preflight.js";
import type { ModelToolDefinition } from "../../src/domain/types.js";

const tools: ModelToolDefinition[] = [
  {
    source: "runtime",
    sourceId: "runtime",
    name: "write",
    modelName: "write",
    description: "Write a file",
    inputSchema: {
      type: "object",
      required: ["path", "text"],
      properties: {
        path: { type: "string" },
        text: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

describe("ToolPreflight", () => {
  it("validates every call before returning an executable batch", () => {
    const result = new ToolPreflight().inspect(
      [{ id: "call-1", name: "write", arguments: { path: "a.txt", text: "ok" } }],
      tools,
    );

    expect(result).toMatchObject({ kind: "ready" });
  });

  it("rejects the whole batch when one call is invalid", () => {
    const result = new ToolPreflight().inspect(
      [
        { id: "call-1", name: "write", arguments: { path: "a.txt", text: "ok" } },
        { id: "call-2", name: "write", arguments: { path: "b.txt" } },
      ],
      tools,
    );

    expect(result).toMatchObject({ kind: "rejected" });
    if (result.kind !== "rejected") {
      throw new Error("expected rejected Tool batch");
    }
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]?.message).toContain("another call");
    expect(result.calls[1]?.message).toContain("required property");
  });

  it("rejects duplicate call IDs because results would be ambiguous", () => {
    expect(() =>
      new ToolPreflight().inspect(
        [
          { id: "call-1", name: "write", arguments: { path: "a.txt", text: "ok" } },
          { id: "call-1", name: "write", arguments: { path: "b.txt", text: "ok" } },
        ],
        tools,
      ),
    ).toThrow("duplicate Tool call ID");
  });
});
