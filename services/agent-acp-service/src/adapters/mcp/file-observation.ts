import { posix } from "node:path";
import { z } from "zod";

import type { ModelToolDefinition, ToolEffectState } from "../../domain/types.js";
import type { ToolFileObservation } from "../../domain/tool-presentation.js";

const FILE_KEY = "io.antnest.runtime/file";
const MAX_FILE_BYTES = 32 * 1024;
const text = z.string().refine((value) => value.isWellFormed());
const observation = z
  .object({
    path: text.refine(
      (value) =>
        posix.isAbsolute(value) && posix.normalize(value) === value && !value.includes("\0"),
    ),
    diff: z.object({ oldText: text.nullable(), newText: text }).strict().optional(),
    diffOmitted: z.enum(["too_large", "non_utf8", "unavailable"]).optional(),
  })
  .strict()
  .refine((value) => value.diff === undefined || value.diffOmitted === undefined);

export function parseFileObservation(
  tool: ModelToolDefinition,
  result: { meta?: unknown; isError: boolean; toolEffectState: ToolEffectState },
): ToolFileObservation | undefined {
  if (
    tool.source !== "runtime" ||
    tool.sourceId !== "runtime" ||
    !["read", "write", "edit"].includes(tool.name)
  )
    return undefined;
  if (result.isError || result.toolEffectState !== "settled") return undefined;
  if (typeof result.meta !== "object" || result.meta === null || !(FILE_KEY in result.meta))
    return undefined;
  const value: unknown = result.meta[FILE_KEY];
  const parsed = observation.safeParse(value);
  if (!parsed.success) return undefined;
  if (Buffer.byteLength(JSON.stringify({ [FILE_KEY]: parsed.data }), "utf8") > MAX_FILE_BYTES)
    return undefined;
  const { path, diff, diffOmitted } = parsed.data;
  if (tool.name === "read" && (diff !== undefined || diffOmitted !== undefined)) return undefined;
  return {
    path,
    ...(diff === undefined || diff.oldText === diff.newText
      ? {}
      : { change: { before: diff.oldText, after: diff.newText } }),
  };
}
