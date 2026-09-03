import type { ContentBlock, PromptCapabilities } from "@agentclientprotocol/sdk";
import type { Attachment } from "./types";

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export async function buildPromptBlocks(
  text: string,
  attachments: readonly Attachment[],
  capabilities: PromptCapabilities | null | undefined,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  if (text.trim()) blocks.push({ type: "text", text: text.trim() });
  for (const attachment of attachments) {
    if (!attachment.file) throw new Error(`${attachment.name} is no longer available in this browser tab.`);
    if (attachment.file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${attachment.name} exceeds the 4 MB attachment limit.`);
    }
    if (attachment.kind === "image") {
      if (!capabilities?.image) throw new Error("This Agent does not accept image prompts.");
      blocks.push({
        type: "image",
        data: await fileBase64(attachment.file),
        mimeType: attachment.mimeType || attachment.file.type || "application/octet-stream",
      });
      continue;
    }
    if (isTextFile(attachment.file)) {
      blocks.push({
        type: "text",
        text: `\n\nAttachment: ${attachment.name}\n\n${await attachment.file.text()}`,
      });
      continue;
    }
    if (!capabilities?.embeddedContext) {
      throw new Error("This Agent accepts text files and images only.");
    }
    blocks.push({
      type: "resource",
      resource: {
        uri: `attachment:///${encodeURIComponent(attachment.name)}`,
        mimeType: attachment.mimeType || attachment.file.type || "application/octet-stream",
        blob: await fileBase64(attachment.file),
      },
    });
  }
  if (!blocks.length) throw new Error("Enter a message or attach a file.");
  return blocks;
}

function isTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (["application/json", "application/javascript", "application/xml", "application/yaml"].includes(file.type)) {
    return true;
  }
  return /\.(?:c|cc|cpp|css|csv|go|h|html|java|js|json|jsx|md|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i.test(file.name);
}

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}
