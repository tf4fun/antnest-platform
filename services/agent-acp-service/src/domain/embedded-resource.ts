import { z } from "zod";

import { DomainError } from "./errors.js";
import type { ContentBlock } from "./types.js";
import { audioInput } from "./audio-content.js";
import { decodeContentData, MAX_ATTACHMENT_BYTES } from "./content-data.js";

const resourceSchema = z.object({
  uri: z.string(),
  mimeType: z.string().optional(),
  text: z.string().optional(),
  blob: z.string().optional(),
});

export function normalizePromptResources(content: readonly ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type === "audio") audioInput(block);
    return block.type === "resource"
      ? { ...block, resource: normalizeEmbeddedResource(block.resource) }
      : block;
  });
}

export type EmbeddedResource =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType: "application/pdf"; blob: string };

export function normalizeEmbeddedResource(value: unknown): EmbeddedResource {
  const parsed = resourceSchema.safeParse(value);
  if (!parsed.success) throw unsupportedResource();
  const { uri, mimeType, text, blob } = parsed.data;
  if ((text === undefined) === (blob === undefined)) throw unsupportedResource();
  if (text !== undefined) {
    if (Buffer.byteLength(text, "utf8") > MAX_ATTACHMENT_BYTES) throw unsupportedResource();
    return { uri, ...(mimeType === undefined ? {} : { mimeType }), text };
  }
  const bytes = decodeContentData(blob);
  if (bytes === undefined) throw unsupportedResource();
  if (mimeType?.toLowerCase().trim() === "application/pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw unsupportedResource();
    return { uri, mimeType: "application/pdf", blob: bytes.toString("base64") };
  }
  if (!isUtf8Text(mimeType)) throw unsupportedResource();
  try {
    return {
      uri,
      ...(mimeType === undefined ? {} : { mimeType }),
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    throw unsupportedResource();
  }
}

function isUtf8Text(mimeType: string | undefined): boolean {
  if (mimeType === undefined) return false;
  const [mediaType, ...parameters] = mimeType
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  if (
    parameters.some(
      (part) =>
        part.startsWith("charset=") && part !== "charset=utf-8" && part !== "charset=us-ascii",
    )
  )
    return false;
  return (
    mediaType?.startsWith("text/") === true ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/yaml",
      "application/toml",
    ].includes(mediaType ?? "") ||
    mediaType?.endsWith("+json") === true ||
    mediaType?.endsWith("+xml") === true
  );
}

function unsupportedResource(): DomainError {
  return new DomainError(
    "unsupported_resource_content",
    "Embedded attachments must contain either UTF-8 text or a PDF Base64 blob, at most 1 MiB. Send images as image content; other binary formats are not supported.",
  );
}
