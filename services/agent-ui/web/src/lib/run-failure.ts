export function runFailureMessage(errorClass: string | null | undefined): string | undefined {
  if (errorClass === "model_unsupported_content")
    return "The selected model does not support this attachment type. Use a model that supports the attachment, or start a new conversation without it.";
  return undefined;
}
