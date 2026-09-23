export function observeSocket(WebSocket, closed, onClose) {
  return class extends WebSocket {
    constructor(...args) {
      super(...args);
      this.on("error", (error) => closed.abort(error));
      this.once("close", (code) => {
        onClose(code);
        closed.abort(new Error("ACP connection closed"));
      });
      this.once("unexpected-response", (_request, response) => {
        const error = new Error(
          `ACP upgrade rejected: HTTP ${response.statusCode}`,
        );
        error.status = response.statusCode;
        closed.abort(error);
        response.resume();
        this.terminate();
      });
    }
  };
}

export async function requestWithin(work, closed, close, timeout) {
  closed.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("ACP request timed out")),
    timeout,
  );
  const signal = AbortSignal.any([closed, deadline.signal]);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      reject(signal.reason);
      close();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work({ cancellationSignal: signal }), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
