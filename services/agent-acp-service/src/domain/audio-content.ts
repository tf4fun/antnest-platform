import { decodeContentData } from "./content-data.js";
import { DomainError } from "./errors.js";
import type { ContentBlock } from "./types.js";

const formats = new Map<string, "wav" | "mp3">([
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
]);

export function audioInput(block: ContentBlock): { data: string; format: "wav" | "mp3" } {
  const format =
    typeof block.mimeType === "string"
      ? formats.get(block.mimeType.toLowerCase().trim())
      : undefined;
  const bytes = decodeContentData(block.data);
  if (format === undefined || bytes === undefined || bytes.length === 0)
    throw new DomainError(
      "unsupported_audio_content",
      "Audio must be a nonempty WAV or MP3 Base64 payload of at most 1 MiB.",
    );
  return { data: bytes.toString("base64"), format };
}
