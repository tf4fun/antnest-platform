// Own browser lifetime without letting a failed reader or cleanup replace the
// original business/cancellation failure. Every registered task is joined.
export async function runC4BrowserScope({ launch, signal }, work) {
  const failures = new Set(),
    pending = new Set(),
    observers = [];
  let browser, context, browserClosing, contextClosing, result;
  const recordFailure = (error) => {
    failures.add(error);
  };
  const capture = async (action) => {
    try {
      return await action();
    } catch (error) {
      recordFailure(error);
    }
  };
  const closeBrowser = () =>
    (browserClosing ??= capture(async () => {
      await browser?.close();
    }));
  const closeContext = () =>
    (contextClosing ??= capture(async () => {
      await context?.close();
    }));
  const interrupted = () => {
    recordFailure(signal.reason);
    void closeBrowser();
  };
  const track = (work) => {
    const promise =
      typeof work === "function"
        ? Promise.resolve().then(work)
        : Promise.resolve(work);
    const settled = promise.then((value) => value, recordFailure);
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    // The rejection handler above owns background tasks; an explicit await
    // must still stop the business flow with the original rejection.
    return promise;
  };
  const joinTasks = async () => {
    while (pending.size) await Promise.all([...pending]);
  };
  try {
    signal?.throwIfAborted();
    browser = await launch();
    signal?.addEventListener("abort", interrupted, { once: true });
    signal?.throwIfAborted();
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    signal?.throwIfAborted();
    result = await work({
      context,
      track,
      recordFailure,
      capture,
      closeContext,
      joinTasks,
      addObserver: (observer) => {
        observers.push(observer);
        return observer;
      },
    });
  } catch (error) {
    recordFailure(error);
  } finally {
    signal?.removeEventListener("abort", interrupted);
    await closeContext();
    await closeBrowser();
    await joinTasks();
    for (const observer of observers)
      await capture(() => observer.closeAndWait());
    await joinTasks();
    if (signal?.aborted) recordFailure(signal.reason);
  }
  if (failures.size === 1) throw [...failures][0];
  if (failures.size > 1)
    throw new AggregateError(
      [...failures],
      "C4 browser business or cleanup failed",
    );
  return result;
}
