import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export async function waitForDeletedResources({
  deadline,
  now = Date.now,
  wait = (ms, signal) => delay(ms, undefined, { signal }),
  readInventory,
  preserve,
  signal,
}) {
  const evidence = { observations: [] };
  const deadlineController = new AbortController();
  const operationSignal = signal
    ? AbortSignal.any([signal, deadlineController.signal])
    : deadlineController.signal;
  const deadlineFailure = new Error(
    "Runtime deletion inspection deadline expired",
  );
  let deadlineTimer;
  let failed = false;
  let failure;
  let result;

  function remainingTime() {
    signal?.throwIfAborted();
    deadlineController.signal.throwIfAborted();
    const remaining = deadline - now();
    assert(Number.isFinite(remaining), "Runtime deletion clock must be finite");
    if (remaining <= 0) {
      deadlineController.abort(deadlineFailure);
      throw deadlineFailure;
    }
    return remaining;
  }

  try {
    signal?.throwIfAborted();
    assert(
      Number.isFinite(deadline),
      "Runtime deletion deadline must be finite",
    );
    deadlineTimer = setTimeout(
      () => deadlineController.abort(deadlineFailure),
      remainingTime(),
    );
    deadlineTimer.unref();

    for (;;) {
      remainingTime();
      const inventory = await readInventory(operationSignal);
      evidence.observations.push(inventory);
      remainingTime();
      assert(
        Array.isArray(inventory?.containers),
        "Runtime container inventory must be an array",
      );
      assert(
        Array.isArray(inventory?.volumes),
        "Runtime volume inventory must be an array",
      );
      if (inventory.containers.length === 0 && inventory.volumes.length === 0) {
        result = { runtime_containers: 0, runtime_volumes: 0 };
        break;
      }
      await wait(Math.min(250, remainingTime()), operationSignal);
      remainingTime();
    }
  } catch (error) {
    failed = true;
    failure = signal?.aborted
      ? signal.reason
      : deadlineController.signal.aborted
        ? deadlineController.signal.reason
        : error;
    if (failure !== error) evidence.operationError = error;
  } finally {
    clearTimeout(deadlineTimer);
  }

  try {
    await preserve(evidence, failure);
  } catch (error) {
    if (failed)
      throw new AggregateError(
        [failure, error],
        "Runtime deletion inspection and private archive failed",
      );
    if (signal?.aborted)
      throw new AggregateError(
        [signal.reason, error],
        "Runtime deletion inspection and private archive failed",
      );
    throw error;
  }
  if (failed) throw failure;
  signal?.throwIfAborted();
  return result;
}
