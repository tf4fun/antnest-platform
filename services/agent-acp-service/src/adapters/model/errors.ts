import { ModelError as OpenAICompatibleModelError } from "../../ports/model.js";

export { OpenAICompatibleModelError };

export function invalidResponse(message: string, cause?: unknown): OpenAICompatibleModelError {
  return new OpenAICompatibleModelError(
    "model_invalid_response",
    message,
    false,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}
