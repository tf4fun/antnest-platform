export function assertWorkerOwnership(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw ownershipError(signal);
}

export async function withWorkerOwnership<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  assertWorkerOwnership(signal);
  try {
    // The signal closes dispatch immediately, but the caller still owns the
    // original runner/SQL operation and its cleanup until that Promise settles.
    const result = await Promise.resolve().then(() => {
      assertWorkerOwnership(signal);
      return operation();
    });
    assertWorkerOwnership(signal);
    return result;
  } catch (error) {
    assertWorkerOwnership(signal);
    throw error;
  }
}

function ownershipError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Agent ACP worker ownership was lost");
}
