import { setTimeout as delay } from "node:timers/promises";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

export function createManagedWork() {
  const abort = new AbortController(),
    tasks = [],
    pending = new Set();
  return {
    signal: abort.signal,
    pending: () => pending.size,
    stop() {
      abort.abort(new Error("Managed business work stopped"));
    },
    track(task) {
      pending.add(task);
      tasks.push(
        task
          .then(
            () => undefined,
            (error) => error,
          )
          .finally(() => pending.delete(task)),
      );
      return task;
    },
    async join() {
      return (await Promise.all(tasks)).filter((error) => error !== undefined);
    },
    async wait(probe, label, timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        abort.signal.throwIfAborted();
        const result = await probe();
        abort.signal.throwIfAborted();
        if (result) return result;
        try {
          await delay(100, undefined, { signal: abort.signal });
        } catch (error) {
          abort.signal.throwIfAborted();
          throw error;
        }
      }
      throw new Error(`Timed out: ${label}`);
    },
  };
}

export async function runManagedWork(
  work,
  clients,
  telemetry,
  action,
  { traceDiagnostics, directory = process.env.TEST_EVIDENCE_DIRECTORY } = {},
) {
  const errors = [];
  let result;
  try {
    result = await action();
  } catch (error) {
    errors.push(error);
  }
  work.stop();
  // v1 work may still be inside the real SDK request. Close first, then join
  // that request and v2's post-ACK idle waiter before shutting down exports.
  for (const client of clients) {
    try {
      await client.closeAndWait();
    } catch (error) {
      errors.push(error);
    } finally {
      clients.delete?.(client);
    }
  }
  errors.push(...(await work.join()));
  try {
    // Actual shutdown is joined even when the auxiliary diagnostic budget has
    // already expired. Only its result is diagnostic; it is never abandoned.
    await telemetry.shutdown();
  } catch (error) {
    console.warn(
      "Managed telemetry shutdown failed; auxiliary diagnostics retained",
    );
    try {
      const diagnostics =
        traceDiagnostics ??
        (directory ? createTraceDiagnostics({ directory }) : undefined);
      await diagnostics?.run("telemetry-shutdown", () => {
        throw error;
      });
    } catch {
      console.warn("Managed telemetry diagnostic recording failed");
    }
  }
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(unique, "Managed business and cleanup failed");
  return result;
}
