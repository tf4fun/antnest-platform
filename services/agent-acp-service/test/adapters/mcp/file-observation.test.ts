import { describe, expect, it } from "vitest";
import { parseFileObservation } from "../../../src/adapters/mcp/file-observation.js";
import type { ModelToolDefinition } from "../../../src/domain/types.js";

const tool: ModelToolDefinition = {
  source: "runtime",
  sourceId: "runtime",
  name: "write",
  modelName: "write",
  description: "",
};
const key = "io.antnest.runtime/file";
const file = {
  path: "/home/agent/file.txt",
  diff: { oldText: "head\nbefore\ntail\n", newText: "head\nafter\ntail\n" },
};
const result = { isError: false, toolEffectState: "settled" as const, meta: { [key]: file } };

describe("Runtime file observation boundary", () => {
  it("maps complete facts and preserves null versus empty before images", () => {
    expect(parseFileObservation(tool, result)).toEqual({
      path: file.path,
      change: { before: file.diff.oldText, after: file.diff.newText },
    });
    for (const oldText of [null, ""]) {
      const meta = { [key]: { path: file.path, diff: { oldText, newText: "new" } } };
      expect(parseFileObservation(tool, { ...result, meta })).toEqual({
        path: file.path,
        change: { before: oldText, after: "new" },
      });
    }
  });

  it.each(["too_large", "non_utf8", "unavailable"])(
    "keeps only the location for %s",
    (diffOmitted) => {
      expect(
        parseFileObservation(tool, {
          ...result,
          meta: { [key]: { path: file.path, diffOmitted } },
        }),
      ).toEqual({ path: file.path });
    },
  );

  it("does not synthesize changes for reads or unchanged existing content", () => {
    expect(
      parseFileObservation(
        { ...tool, name: "read" },
        { ...result, meta: { [key]: { path: "/opt/company-skills/guide/SKILL.md" } } },
      ),
    ).toEqual({ path: "/opt/company-skills/guide/SKILL.md" });
    expect(parseFileObservation({ ...tool, name: "read" }, result)).toBeUndefined();
    expect(
      parseFileObservation(tool, {
        ...result,
        meta: { [key]: { path: file.path, diff: { oldText: "same", newText: "same" } } },
      }),
    ).toEqual({ path: file.path });
  });

  it.each([
    null,
    [],
    {},
    { path: "relative.txt" },
    { path: "file:///workspace/file" },
    { path: "/work/../file" },
    { path: "/work/./file" },
    { path: "/work/\0file" },
    { path: "/work/\ud800" },
    { path: file.path, diff: { newText: "new" } },
    { path: file.path, diff: { oldText: 0, newText: "new" } },
    { path: file.path, diff: { oldText: "before", newText: "\ud800" } },
    { ...file, diffOmitted: "too_large" },
    { path: file.path, diffOmitted: "unknown" },
    { ...file, line: 10 },
    { path: file.path, diff: { oldText: null, newText: "\0".repeat(6000) } },
    { path: "/" + "a".repeat(32768) },
  ])("omits malformed or over-budget metadata without failing the result: %j", (value) => {
    expect(parseFileObservation(tool, { ...result, meta: { [key]: value } })).toBeUndefined();
  });

  it("requires exact builtin identity and a successful settled result", () => {
    for (const name of ["bash", "managed_read", "read_extra"])
      expect(parseFileObservation({ ...tool, name }, result)).toBeUndefined();
    expect(parseFileObservation({ ...tool, sourceId: "managed" }, result)).toBeUndefined();
    expect(parseFileObservation(tool, { ...result, isError: true })).toBeUndefined();
    expect(parseFileObservation(tool, { ...result, toolEffectState: "unknown" })).toBeUndefined();
    expect(parseFileObservation(tool, { ...result, toolEffectState: "none" })).toBeUndefined();
  });
});
