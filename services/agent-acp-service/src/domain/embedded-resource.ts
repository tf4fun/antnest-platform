import { z } from "zod";

import { DomainError } from "./errors.js";
import type { ContentBlock } from "./types.js";

const resourceSchema = z.object({
  uri: z.string(),
  mimeType: z.string().optional(),
  text: z.string().optional(),
  blob: z.string().optional(),
});

export function normalizePromptResources(content: readonly ContentBlock[]): ContentBlock[] {
  return content.map((block) =>
    block.type === "resource"
      ? { ...block, resource: normalizeEmbeddedResource(block.resource) }
      : block,
  );
}

export function normalizeEmbeddedResource(value: unknown): {
  uri: string;
  mimeType?: string;
  text: string;
} {
  const parsed = resourceSchema.safeParse(value);
  if (!parsed.success) throw unsupportedResource();
  const { uri, mimeType, text, blob } = parsed.data;
  if (text !== undefined) return { uri, ...(mimeType === undefined ? {} : { mimeType }), text };
  if (blob === undefined || !isUtf8Text(mimeType)) throw unsupportedResource();
  const bytes = Buffer.from(blob, "base64");
  if (bytes.toString("base64") !== blob) throw unsupportedResource();
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
    "Embedded attachments must contain text or valid UTF-8 textual blobs. Send images as image content; PDF and other binary attachments are not supported.",
  );
}
