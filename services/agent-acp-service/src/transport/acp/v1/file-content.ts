import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { ToolFileObservation } from "../../../domain/tool-presentation.js";

export function fileContent(file?: ToolFileObservation): ToolCallContent[] {
  if (file?.change === undefined || file.change.before === file.change.after) return [];
  return [
    { type: "diff", path: file.path, oldText: file.change.before, newText: file.change.after },
  ];
}
