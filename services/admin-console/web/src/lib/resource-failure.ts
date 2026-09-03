export type ResourceFailure = {
  kind: "not_found" | "forbidden" | "unavailable";
  message: string;
  retryable: boolean;
};

type ResponseFailure = Error & { status?: unknown };

export function resourceFailure(cause: unknown): ResourceFailure {
  const message = cause instanceof Error
    ? cause.message
    : "The request could not be completed.";
  const status = cause instanceof Error
    ? (cause as ResponseFailure).status
    : undefined;

  if (status === 404 || status === 410) {
    return { kind: "not_found", message, retryable: false };
  }
  if (status === 403) {
    return { kind: "forbidden", message, retryable: false };
  }
  return { kind: "unavailable", message, retryable: true };
}
