import assert from "node:assert/strict";

// A single admitted, noninterruptible KDF owns the full memory budget. The
// deadline stops the fault phase, restores CPU, and joins both HTTP work and
// its actual server transaction. A completed holder is never restarted.
export async function withPasswordHolder({
  signal,
  timeoutMS = 12000,
  throttle,
  start,
  exercise,
  restore,
  drain,
}) {
  assert(Number.isSafeInteger(timeoutMS) && timeoutMS > 0);
  signal?.throwIfAborted();
  const failure = Promise.withResolvers();
  // Setup may still be awaiting Docker when an interruption arrives.
  failure.promise.catch(() => {});
  const errors = [];
  let holder,
    targets,
    timer,
    finished = false,
    holderFinished = false,
    result;
  let deadline = Infinity,
    stopped;
  const halt = (error) => {
    if (!finished) {
      stopped ??= error;
      failure.reject(error);
    }
  };
  const abort = () => halt(signal.reason);
  const assertHeld = () => {
    signal?.throwIfAborted();
    if (stopped) throw stopped;
    assert(
      performance.now() < deadline,
      "password holder phase deadline exceeded",
    );
    assert(!finished, "password holder phase already ended");
    assert(
      !holderFinished,
      "password holder finished before target completion",
    );
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await throttle();
    signal?.throwIfAborted();
    deadline = performance.now() + timeoutMS;
    timer = setTimeout(
      () => halt(new Error("password holder phase deadline exceeded")),
      timeoutMS,
    );
    holder = Promise.resolve().then(start);
    holder.then(
      () => {
        holderFinished = true;
        halt(new Error("password holder finished before target completion"));
      },
      (error) => {
        holderFinished = true;
        halt(error);
      },
    );
    targets = Promise.resolve().then(() => exercise(assertHeld));
    result = await Promise.race([targets, failure.promise]);
    assertHeld();
  } catch (error) {
    errors.push(error);
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    try {
      await restore();
    } catch (error) {
      errors.push(error);
    }
    for (const row of await Promise.allSettled([holder, targets]))
      if (row.status === "rejected") errors.push(row.reason);
    try {
      await drain();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      [...new Set(errors)],
      "password holder phase failed after joining",
    );
  return result;
}
