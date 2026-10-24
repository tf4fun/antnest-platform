// Inspect the complete owned fetch cause, not the bounded telemetry summary.
// Only native fetch wrappers and exclusively refused/reset connection leaves
// qualify. A reset has no acknowledgement; the original close still rejects.
export function isDisconnectedHttpPeer(error: unknown): boolean {
  const seen = new Set<Error>();
  const visit = (value: unknown, depth: number): boolean => {
    if (!(value instanceof Error) || depth > 8 || seen.size >= 32 || seen.has(value)) return false;
    seen.add(value);
    const code = (value as Error & { code?: unknown }).code;
    const disconnected = code === "ECONNREFUSED" || code === "ECONNRESET";
    const hasCause = Object.hasOwn(value, "cause");
    if (value instanceof AggregateError) {
      return (
        disconnected &&
        Array.isArray(value.errors) &&
        value.errors.length > 0 &&
        value.errors.length <= 16 &&
        value.errors.every((cause: unknown) => visit(cause, depth + 1)) &&
        (!hasCause || visit(value.cause, depth + 1))
      );
    }
    if (disconnected) return !hasCause || visit(value.cause, depth + 1);
    return (
      value instanceof TypeError && code === undefined && hasCause && visit(value.cause, depth + 1)
    );
  };
  try {
    return visit(error, 0);
  } catch {
    return false;
  }
}
