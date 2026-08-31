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
  let onAbort: (() => void) | undefined;
  const lost = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(ownershipError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const result = await Promise.race([Promise.resolve().then(operation), lost]);
    assertWorkerOwnership(signal);
    return result;
  } catch (error) {
    assertWorkerOwnership(signal);
    throw error;
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function ownershipError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Agent ACP worker ownership was lost");
}
