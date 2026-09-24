import { createHash } from "node:crypto";

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
