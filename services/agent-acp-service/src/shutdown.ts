export async function withShutdownDeadline(
  operation: Promise<void>,
  timeoutMs: number,
  forceExit: () => void,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          forceExit();
          reject(new Error("Agent ACP Service shutdown deadline exceeded"));
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function flushBeforeFailStop(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function raceWithOwnershipLoss<T>(
  operation: Promise<T>,
  ownershipLoss: Promise<Error>,
): Promise<T> {
  return Promise.race([operation, ownershipLoss.then((error) => Promise.reject(error))]);
}
