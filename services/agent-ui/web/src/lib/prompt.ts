import type { ContentBlock, PromptCapabilities } from "@agentclientprotocol/sdk";
import type { Attachment } from "./types";

import { describeAttachment, validateAttachmentCount } from "./attachments.ts";

export async function buildPromptBlocks(
  text: string,
  attachments: readonly Attachment[],
  capabilities: PromptCapabilities | null | undefined,
): Promise<ContentBlock[]> {
  validateAttachmentCount(attachments.length);
  const files = attachments.map(attachment => {
    if (!attachment.file) throw new Error(`${attachment.name} is no longer available in this browser tab.`);
    return { file: attachment.file, ...describeAttachment(attachment.file, capabilities) };
  });
  const blocks: ContentBlock[] = [];
  if (text.trim()) blocks.push({ type: "text", text: text.trim() });
  for (const { file, kind, mimeType } of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const uri = `attachment:///${encodeURIComponent(file.name)}`;
    if (kind === "text") {
      const content = utf8Text(bytes, file.name);
      blocks.push(capabilities?.embeddedContext
        ? { type: "resource", resource: { uri, mimeType, text: content } }
        : { type: "text", text: `\n\nAttachment: ${file.name}\n\n${content}` });
    } else if (kind === "pdf") {
      if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") throw new Error(`${file.name} is not a PDF document.`);
      blocks.push({ type: "resource", resource: { uri, mimeType, blob: base64(bytes) } });
    } else {
      blocks.push({ type: kind, mimeType, data: base64(bytes) });
    }
  }
  if (!blocks.length) throw new Error("Enter a message or attach a file.");
  return blocks;
}

function utf8Text(bytes: Uint8Array, name: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${name} must contain valid UTF-8 text.`); }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}
