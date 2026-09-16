export function errorMessage(cause: unknown, fallback: string): string {
  if (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === -32022 &&
    "data" in cause &&
    typeof cause.data === "object" &&
    cause.data !== null &&
    "code" in cause.data &&
    cause.data.code === "model_unsupported_content"
  ) {
    return "The selected model does not support this attachment type. Use a model that supports the attachment, or start a new conversation without it.";
  }
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : fallback;
}
