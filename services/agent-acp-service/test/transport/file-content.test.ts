import { applyPatch, parsePatch } from "diff";
import { describe, expect, it, vi } from "vitest";
import * as diff from "diff";
vi.mock("diff", async (original) => {
  const actual = await original<typeof diff>();
  return { ...actual, formatPatch: vi.fn(actual.formatPatch) };
});
import { fileContent as v1Content } from "../../src/transport/acp/v1/file-content.js";
import { fileContent as v2Content } from "../../src/transport/acp/v2/file-content.js";

describe("Version-specific ACP file content", () => {
  it.each([null, "", "head\nbefore\ntail\n", "before\r\n"])(
    "maps complete before/after for %j",
    (before) => {
      const file = {
        path: "/workspace/notes.txt",
        change: { before, after: "head\nafter\ntail\n" },
      };
      expect(v1Content(file)).toEqual([
        { type: "diff", path: file.path, oldText: before, newText: file.change.after },
      ]);
      const result = v2Content(file)[0];
      expect(result).toMatchObject({
        type: "diff",
        changes: [
          { path: file.path, operation: before === null ? "add" : "modify", fileType: "text" },
        ],
        patch: { format: "git_patch" },
      });
      const patch = (result as { patch: { text: string } }).patch.text;
      expect(patch.startsWith("diff --git ")).toBe(true);
      expect(patch).not.toContain("file mode");
      expect(applyPatch(before ?? "", patch)).toBe(file.change.after);
      const parsed = parsePatch(patch)[0];
      expect(parsed?.newFileName).toBe(file.path);
      expect(parsed?.oldFileName).toBe(before === null ? "/dev/null" : file.path);
    },
  );

  it.each(["space dir /file", "中文.md", "tab\tfile", 'quote"file', "line\nfile"])(
    "preserves absolute patch paths: %j",
    (name) => {
      const file = { path: `/workspace/${name}`, change: { before: "old", after: "new" } };
      const result = v2Content(file)[0] as { patch: { text: string } };
      expect(parsePatch(result.patch.text)[0]?.newFileName).toBe(file.path);
      expect(applyPatch("old", result.patch.text)).toBe("new");
    },
  );

  it("keeps changes without patch for empty creation, NUL and dense over-budget edits", () => {
    for (const change of [
      { before: null, after: "" },
      { before: "old\0", after: "new\0" },
      { before: "a\n".repeat(600), after: "b\n".repeat(600) },
    ]) {
      const result = v2Content({ path: "/workspace/f", change })[0];
      expect(result).toHaveProperty("changes");
      expect(result).not.toHaveProperty("patch");
    }
    expect(v2Content({ path: "/workspace/f" })).toEqual([]);
    expect(v1Content({ path: "/workspace/f" })).toEqual([]);
  });

  it.each([null, "old"])(
    "omits patches that cannot round-trip the exact observed path (%j)",
    (before) => {
      const file = { path: "/workspace/file ", change: { before, after: "new" } };
      expect(v2Content(file)).toEqual([
        {
          type: "diff",
          changes: [
            { path: file.path, operation: before === null ? "add" : "modify", fileType: "text" },
          ],
        },
      ]);
      expect(v1Content(file)).toEqual([
        { type: "diff", path: file.path, oldText: before, newText: "new" },
      ]);
    },
  );

  it("does not fail event delivery when the optional patch formatter fails", () => {
    vi.mocked(diff.formatPatch).mockImplementationOnce(() => {
      throw new Error("patch failed");
    });
    expect(
      v2Content({ path: "/workspace/f", change: { before: "a", after: "b" } })[0],
    ).not.toHaveProperty("patch");
  });

  it("bounds JSON-encoded patch output even when long paths repeat in headers", () => {
    const file = { path: "/" + "p".repeat(20000), change: { before: "old", after: "new" } };
    const result = v2Content(file)[0];
    expect(result).toHaveProperty("changes");
    expect(result).not.toHaveProperty("patch");
    expect(v2Content({ path: "/workspace/f", change: { before: "same", after: "same" } })).toEqual(
      [],
    );
  });
});
