import { setImmediate as turn } from "node:timers/promises";

export const largeInputBytes = 1024 * 1024;
let tail = Promise.resolve();

// Serialize synchronous input preparations with an I/O turn between them.
// Callbacks must finish synchronously and must not enqueue nested work. Await
// in each caller so its own authentication/telemetry context stays attached.
export async function runInputWork<T>(work: () => T, signal?: AbortSignal): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    signal?.throwIfAborted();
    await turn();
    signal?.throwIfAborted();
    return work();
  } finally { release(); }
}
