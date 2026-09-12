import type { Attachment } from "./types";
import { inlineMediaURL } from "./attachments.ts";
import { formatBytes } from "./presentation.ts";

export function contentView(block: unknown, attachmentID: string): { text: string; attachment?: Attachment } {
  if (!isRecord(block)) return { text: "" };
  if (block.type === "text" && typeof block.text === "string") return { text: block.text };
  if (block.type === "resource_link" && typeof block.name === "string") return { text: `\n[${block.name}]\n` };
  if (block.type === "image" || block.type === "audio") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "";
    return { text: "", attachment: {
      id: attachmentID, kind: block.type, name: block.type === "image" ? "Image" : "Audio",
      mimeType, sizeLabel: binarySize(block.data), previewURL: inlineMediaURL(block.type, mimeType, block.data),
    } };
  }
  if (block.type === "resource" && isRecord(block.resource)) {
    const resource = block.resource;
    const name = resourceName(resource.uri);
    const text = typeof resource.text === "string" ? resource.text : undefined;
    return { text: text === undefined ? "" : `\n\nAttachment: ${name}\n\n${text}`,
      attachment: { id: attachmentID, kind: "file", name,
        sizeLabel: text === undefined ? binarySize(resource.blob) : formatBytes(new TextEncoder().encode(text).length),
        mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined } };
  }
  return { text: "" };
}

function resourceName(uri: unknown): string {
  if (typeof uri !== "string") return "Attachment";
  try { return decodeURIComponent(new URL(uri).pathname.split("/").at(-1) || "Attachment"); }
  catch { return "Attachment"; }
}

function binarySize(data: unknown): string {
  if (typeof data !== "string") return "Attachment";
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return formatBytes(Math.max(0, Math.floor(data.length * 3 / 4) - padding));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
