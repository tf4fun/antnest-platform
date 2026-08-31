import { createHash } from "node:crypto";

import type { ContentBlock } from "./types.js";

export const MAX_TOOL_RESULT_BYTES = 64 * 1024;

export function boundToolResult(content: ContentBlock[]): ContentBlock[] {
  const serialized = JSON.stringify(content);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_TOOL_RESULT_BYTES) {
    return structuredClone(content);
  }
  const digest = createHash("sha256").update(serialized).digest("hex");
  const marker =
    `\n[Tool result truncated: original_bytes=${bytes} ` +
    `sha256=${digest}; remaining content was not retained]`;
  return [{ type: "text", text: boundedText(serialized, marker) }];
}

function boundedText(source: string, marker: string): string {
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = safePrefix(source, middle) + marker;
    if (encodedResultBytes(candidate) <= MAX_TOOL_RESULT_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return safePrefix(source, low) + marker;
}

function safePrefix(source: string, length: number): string {
  const prefix = source.slice(0, length);
  const last = prefix.charCodeAt(prefix.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
}

function encodedResultBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify([{ type: "text", text }]), "utf8");
}
