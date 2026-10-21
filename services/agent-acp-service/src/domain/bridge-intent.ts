import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";

export const promptPreparationChunk = 64 * 1024;

export function canonicalPromptJson(prompt: readonly unknown[]): string {
  return JSON.stringify(canonical(prompt));
}

// The same preimage as bridgeIntentDigest, without building another complete
// wrapper string. Keep UTF-16 pairs together when encoding each UTF-8 chunk.
export async function bridgeIntentDigestFromJson(
  expectedAppendVersion: number,
  promptJson: string,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ expectedAppendVersion, prompt: [] }).slice(0, -3));
  for (let offset = 0; offset < promptJson.length;) {
    let end = Math.min(offset + promptPreparationChunk, promptJson.length);
    if (
      end < promptJson.length &&
      promptJson.charCodeAt(end - 1) >= 0xd800 &&
      promptJson.charCodeAt(end - 1) <= 0xdbff &&
      promptJson.charCodeAt(end) >= 0xdc00 &&
      promptJson.charCodeAt(end) <= 0xdfff
    )
      end--;
    hash.update(promptJson.slice(offset, end));
    offset = end;
    if (offset < promptJson.length) await nextTurn();
  }
  return hash.update("}").digest("hex");
}

export function bridgeIntentDigest(
  expectedAppendVersion: number,
  prompt: readonly unknown[],
): string {
  const payload = JSON.stringify({ expectedAppendVersion, prompt: canonical(prompt) });
  return createHash("sha256").update(payload).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}
