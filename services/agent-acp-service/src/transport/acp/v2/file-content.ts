import type { ToolCallContent } from "@agentclientprotocol/sdk/experimental/v2";
import { formatPatch, parsePatch, structuredPatch } from "diff";
import type { ToolFileObservation } from "../../../domain/tool-presentation.js";

export function fileContent(file?: ToolFileObservation): ToolCallContent[] {
  if (file?.change === undefined || file.change.before === file.change.after) return [];
  const patch = renderPatch(file.path, file.change);
  return [
    {
      type: "diff",
      changes: [
        {
          path: file.path,
          operation: file.change.before === null ? "add" : "modify",
          fileType: "text",
        },
      ],
      ...(patch === undefined ? {} : { patch }),
    },
  ];
}

function renderPatch(path: string, change: NonNullable<ToolFileObservation["change"]>) {
  if (change.before?.includes("\0") || change.after.includes("\0")) return undefined;
  try {
    const patch = structuredPatch(
      path,
      path,
      change.before ?? "",
      change.after,
      undefined,
      undefined,
      { maxEditLength: 512 },
    );
    if (patch === undefined || patch.hunks.length === 0) return undefined;
    // Use library quoting and hunks; do not invent file modes for Runtime observations.
    const header = formatPatch({ ...patch, isGit: true, hunks: [] });
    const body = formatPatch(
      { ...patch, oldFileName: change.before === null ? "/dev/null" : path },
      { includeIndex: false, includeUnderline: false, includeFileHeaders: true },
    );
    const value = { format: "git_patch" as const, text: header + body };
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) return undefined;
    const parsed = parsePatch(value.text);
    // A display patch must identify the same file as the authoritative observation.
    if (
      parsed.length !== 1 ||
      parsed[0]?.newFileName !== path ||
      parsed[0].oldFileName !== (change.before === null ? "/dev/null" : path)
    )
      return undefined;
    return value;
  } catch {
    // Optional rendering never changes the authoritative operation or breaks replay.
    return undefined;
  }
}
