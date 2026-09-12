export const MAX_ATTACHMENT_BYTES = 1_048_576;

export function decodeContentData(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3))
    return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= MAX_ATTACHMENT_BYTES && bytes.toString("base64") === value
    ? bytes
    : undefined;
}
