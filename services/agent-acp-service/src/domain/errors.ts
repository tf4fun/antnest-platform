import { resolveErrorDefinition } from "./error-catalog.js";

export class DomainError extends Error {
  public readonly errorClass: string;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;
  public readonly recovery: string;

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
    const definition = resolveErrorDefinition(code);
    this.errorClass = definition.errorClass;
    this.retryable = definition.retryable;
    if (definition.retryAfterMs !== undefined) this.retryAfterMs = definition.retryAfterMs;
    this.recovery = definition.recovery;
  }
}
