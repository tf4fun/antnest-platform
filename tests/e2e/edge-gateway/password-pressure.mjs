import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Own a bounded number of independent requests until the target assertions
// finish. Stopping cancels only scheduling; already-started operations are joined.
export function startPasswordPressure({
  run,
  signal,
  concurrency = 40,
  maximum = 1500,
  intervalMS = 25,
  timeoutMS = 15000,
}) {
  for (const value of [concurrency, maximum, timeoutMS])
    assert(Number.isSafeInteger(value) && value > 0);
  assert(Number.isSafeInteger(intervalMS) && intervalMS >= 0);
  signal?.throwIfAborted();
  const controller = new AbortController();
  const errors = [];
  let started = 0,
    active = 0,
    peak = 0,
    stopped = false,
    exhausted = false;
  const deadline = performance.now() + timeoutMS;
  let timer;
  const halt = () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
  };
  const exhaust = () => {
    if (stopped) return;
    exhausted = true;
    errors.push(
      new Error("password pressure exhausted its bounded request/time budget"),
    );
    halt();
  };
  const abort = () => {
    errors.push(signal.reason);
    halt();
  };
  timer = setTimeout(exhaust, timeoutMS);
  signal?.addEventListener("abort", abort, { once: true });
  const workers = Array.from({ length: concurrency }, async () => {
    try {
      while (!stopped) {
        if (started >= maximum || performance.now() >= deadline) {
          exhaust();
          break;
        }
        const index = started++;
        peak = Math.max(peak, ++active);
        try {
          await run(index);
        } finally {
          active--;
        }
        if (!stopped) {
          try {
            await delay(intervalMS, undefined, { signal: controller.signal });
          } catch (error) {
            if (!(controller.signal.aborted && error.name === "AbortError"))
              throw error;
          }
        }
      }
    } catch (error) {
      errors.push(error);
      halt();
    }
  });
  const completed = Promise.allSettled(workers).then(() => {
    signal?.removeEventListener("abort", abort);
  });
  const state = () => ({ started, peak, active, stopped, exhausted });
  const stop = async () => {
    if (performance.now() >= deadline) exhaust();
    halt();
    await completed;
    if (errors.length)
      throw new AggregateError(
        errors,
        "password pressure requests failed after joining",
      );
    return state();
  };
  return { completed, state, stop };
}
