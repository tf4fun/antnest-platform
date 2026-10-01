import { describe, expect, it } from "vitest";

import { describeTool, boundedRawOutput } from "../../src/domain/tool-presentation.js";
import { MAX_TOOL_RESULT_BYTES } from "../../src/domain/tool-result.js";
import type { ModelToolDefinition } from "../../src/domain/types.js";

function tool(name: string): ModelToolDefinition {
  return { source: "runtime", sourceId: "runtime", name, modelName: name, description: name };
}

describe("Tool presentation", () => {
  it.each([
    ["read", "read", "Read"],
    ["write", "edit", "Write"],
    ["edit", "edit", "Edit"],
  ])("describes %s's intended target using the actual Runtime root", (name, kind, action) => {
    expect(
      describeTool(
        tool(name),
        {
          path: "notes/./file.txt",
          offset: 512,
          old_string: "fragment",
          new_string: "replacement",
        },
        "/home/agent",
      ),
    ).toEqual({
      title: `${action} /home/agent/notes/file.txt`,
      toolKind: kind,
      locations: [{ path: "/home/agent/notes/file.txt" }],
    });
  });

  it("describes Bash without parsing shell commands as locations", () => {
    expect(
      describeTool(tool("bash"), { command: "node server.js\necho done" }, "/home/agent"),
    ).toEqual({ title: "Run node server.js", toolKind: "execute" });
  });

  it.each(["mcp__docs__read", "read_file", "search", "__proto__"])(
    "does not guess managed or unknown Tool %s semantics",
    (name) => {
      expect(
        describeTool(
          { ...tool(name), title: "Search company documents" },
          {
            path: "private.txt",
          },
          "/home/agent",
        ),
      ).toEqual({ title: "Search company documents", toolKind: "other" });
    },
  );

  it("does not identify a non-platform read as a builtin", () => {
    expect(describeTool({ ...tool("read"), sourceId: "external" }, {})).toEqual({
      title: "read",
      toolKind: "other",
    });
  });

  it("uses a bounded single-line MCP title and falls back from whitespace", () => {
    const title = describeTool(
      { ...tool("read"), title: "  " + "测".repeat(140) + "\nnext" },
      {},
    ).title;
    expect(Array.from(title)).toHaveLength(120);
    expect(title).not.toContain("next");
    expect(describeTool({ ...tool("read"), title: "  \n" }, {}).title).toBe("Read");
  });

  it.each([
    undefined,
    "/etc/passwd",
    "../outside",
    "a/../b",
    "a\0b",
    { root: "workspace", path: "file" },
  ])("omits locations for invalid string paths: %j", (path) => {
    expect(describeTool(tool("read"), { path }, "/home/agent")).not.toHaveProperty("locations");
  });

  it("never guesses missing or system Skill root addresses", () => {
    expect(describeTool(tool("read"), { path: "file" })).not.toHaveProperty("locations");
    expect(describeTool(tool("read"), { path: "/skills/guide/SKILL.md" }, "/home/agent")).toEqual({
      title: "Read /skills/guide/SKILL.md",
      toolKind: "read",
    });
  });

  it.each([" notes.txt", "notes.txt ", "\ufeffnotes.txt"])(
    "does not guess normalization of whitespace-bearing path %j",
    (path) => {
      const args = { path };
      expect(describeTool(tool("read"), args, "/home/agent")).not.toHaveProperty("locations");
      expect(args.path).toBe(path);
    },
  );

  it.each(["/workspace/notes/file.txt", "~/notes/file.txt"])(
    "maps virtual workspace path %s to the observed Runtime workspace",
    (path) => {
      expect(describeTool(tool("read"), { path }, "/home/agent")).toEqual({
        title: "Read /home/agent/notes/file.txt",
        toolKind: "read",
        locations: [{ path: "/home/agent/notes/file.txt" }],
      });
    },
  );

  it("normalizes display-only labels to Unicode text without NUL", () => {
    expect(describeTool({ ...tool("mcp__docs__read"), title: "Read\0 \ud800" }, {}).title).toBe(
      "Read \ufffd",
    );
  });
});

describe("Structured raw output", () => {
  it.each([null, false, 0, "", { nested: [1, { ok: true }] }])(
    "retains JSON shape: %j",
    (value) => {
      expect(boundedRawOutput(value)).toEqual(value);
    },
  );

  it("omits absent and oversized values instead of inventing a raw truncation object", () => {
    expect(boundedRawOutput(undefined)).toBeUndefined();
    expect(boundedRawOutput("x".repeat(MAX_TOOL_RESULT_BYTES - 2))).toBeDefined();
    expect(boundedRawOutput("x".repeat(MAX_TOOL_RESULT_BYTES - 1))).toBeUndefined();
    expect(boundedRawOutput({ text: "测".repeat(MAX_TOOL_RESULT_BYTES / 2) })).toBeUndefined();
  });
});
