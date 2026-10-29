import { ModelError as OpenAICompatibleModelError } from "../../ports/model.js";

export { OpenAICompatibleModelError };

export function contextOverflow(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
  const code = (error as { code?: unknown }).code ?? (error as { type?: unknown }).type;
  return (
    code === "context_length_exceeded" ||
    code === "context_window_exceeded" ||
    code === "context_overflow"
  );
}

export function invalidResponse(message: string, cause?: unknown): OpenAICompatibleModelError {
  return new OpenAICompatibleModelError(
    "model_invalid_response",
    message,
    false,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}
