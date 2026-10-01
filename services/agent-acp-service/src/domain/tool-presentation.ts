import { posix } from "node:path";

import { MAX_TOOL_RESULT_BYTES } from "./tool-result.js";
import type { JsonValue, ModelToolDefinition } from "./types.js";

export type ToolKind = "read" | "edit" | "execute" | "other";
export type ToolLocation = { path: string; line?: number };
export type ToolFileObservation = {
  path: string;
  change?: { before: string | null; after: string };
};
export type ToolResultPresentation = { rawOutput?: JsonValue; file?: ToolFileObservation };
export type ToolPresentation = { title: string; toolKind: ToolKind; locations?: ToolLocation[] };

const BUILTINS = new Map<string, { title: string; kind: ToolKind }>([
  ["read", { title: "Read", kind: "read" }],
  ["write", { title: "Write", kind: "edit" }],
  ["edit", { title: "Edit", kind: "edit" }],
  ["bash", { title: "Run", kind: "execute" }],
]);

export function describeTool(
  tool: ModelToolDefinition,
  args: Record<string, unknown>,
  workspace?: string,
): ToolPresentation {
  const builtin =
    tool.source === "runtime" && tool.sourceId === "runtime" ? BUILTINS.get(tool.name) : undefined;
  if (builtin === undefined) {
    return { title: shortTitle(tool.title) || shortTitle(tool.name), toolKind: "other" };
  }
  const target = builtin.kind === "execute" ? undefined : fileTarget(args.path, workspace);
  const detail = builtin.kind === "execute" ? shortTitle(args.command) : target?.label;
  return {
    title: shortTitle(tool.title) || shortTitle([builtin.title, detail].filter(Boolean).join(" ")),
    toolKind: builtin.kind,
    ...(target?.absolute === undefined ? {} : { locations: [{ path: target.absolute }] }),
  };
}

function fileTarget(
  value: unknown,
  workspace?: string,
): { label: string; absolute?: string } | undefined {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return undefined;
  if (value.includes("\0") || value.split("/").includes("..")) return undefined;
  if (value.startsWith("/skills/")) return { label: posix.normalize(value) };
  const path = value.startsWith("/workspace/")
    ? value.slice("/workspace/".length)
    : value.startsWith("~/")
      ? value.slice(2)
      : value === "/workspace" || value === "~"
        ? "."
        : value;
  if (posix.isAbsolute(path)) return undefined;
  const relative = posix.normalize(path || ".");
  if (workspace === undefined || !posix.isAbsolute(workspace)) {
    return { label: `/workspace/${relative}` };
  }
  const absolute = posix.join(workspace, relative);
  return { label: absolute, absolute };
}

function shortTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = (value.split(/[\r\n]/, 1)[0] ?? "").replaceAll("\0", "").toWellFormed().trim();
  const points = Array.from(line);
  return points.length <= 120 ? line : points.slice(0, 117).join("") + "...";
}

export function boundedRawOutput(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_RESULT_BYTES) return undefined;
  return JSON.parse(serialized) as JsonValue;
}
