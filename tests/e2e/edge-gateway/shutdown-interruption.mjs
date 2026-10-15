export function shutdownInterruption({
  emitter = process,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const controller = new AbortController();
  let interruption;
  const interrupt = () => {
    interruption ??= new Error("Gateway shutdown regression interrupted");
    controller.abort(interruption);
  };
  emitter.once("SIGINT", interrupt);
  emitter.once("SIGTERM", interrupt);
  const timer = setTimer(interrupt, 180000);
  return {
    signal: controller.signal,
    beginCleanup() {
      controller.abort();
    },
    finish(failure) {
      clearTimer(timer);
      emitter.removeListener("SIGINT", interrupt);
      emitter.removeListener("SIGTERM", interrupt);
      if (!interruption || failure === interruption) return failure;
      return failure
        ? new AggregateError([failure, interruption])
        : interruption;
    },
  };
}
