import { DomainError } from "../domain/errors.js";
import { assertWorkerOwnership, withWorkerOwnership } from "./worker-ownership.js";

// Only use for an idempotent repository write with one fixed request identity.
// Executing a model, Tool or Run is never a retryable persistence callback.
export async function retryRunWrite<T>(signal: AbortSignal, write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    assertWorkerOwnership(signal);
    try {
      return await withWorkerOwnership(signal, write);
    } catch (error) {
      assertWorkerOwnership(signal);
      if (error instanceof DomainError || attempt === 2) throw error;
      await waitForRunPersistence(signal, 25 * 2 ** attempt + Math.floor(Math.random() * 25));
    }
  }
}

export function waitForRunPersistence(signal: AbortSignal, milliseconds: number): Promise<void> {
  assertWorkerOwnership(signal);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      try {
        assertWorkerOwnership(signal);
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error("Run persistence wait lost ownership", { cause: error }),
        );
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
