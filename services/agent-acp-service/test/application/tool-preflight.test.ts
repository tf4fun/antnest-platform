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

  it("accepts the JSON Schema 2020-12 dialect published by Runtime MCP", () => {
    const [tool] = tools;
    if (tool === undefined) {
      throw new Error("test Tool is required");
    }
    const result = new ToolPreflight().inspect(
      [{ id: "call-1", name: "write", arguments: { path: "a.txt", text: "ok" } }],
      [
        {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            $schema: "https://json-schema.org/draft/2020-12/schema",
          },
        },
      ],
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

  it("validates static patterns without mutating Tool arguments", () => {
    const preflight = new ToolPreflight();
    const patterned: ModelToolDefinition[] = [
      {
        ...tools[0]!,
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", pattern: "^[a-z]+\\.txt$" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ];
    for (const [path, expected] of [
      ["notes.txt", "ready"],
      ["../notes.txt", "rejected"],
    ] as const) {
      const args = { path };
      expect(
        preflight.inspect([{ id: path, name: "write", arguments: args }], patterned).kind,
      ).toBe(expected);
      expect(args).toEqual({ path });
    }
  });

  it("rejects data-supplied patterns before compiling or validating Tool arguments", () => {
    const dynamic: ModelToolDefinition[] = [
      {
        ...tools[0]!,
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            text: { type: "string", pattern: { $data: "1/pattern" } },
          },
        },
      },
    ];
    expect(() =>
      new ToolPreflight().inspect(
        [{ id: "dynamic", name: "write", arguments: { pattern: "^ok$", text: "ok" } }],
        dynamic,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_tool_schema" }));
  });
});
