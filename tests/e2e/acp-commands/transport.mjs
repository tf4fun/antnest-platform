import assert from "node:assert/strict";

function requestMetadata(message) {
  if (typeof message?.method !== "string" || message.id === undefined) return;
  return {
    requestId: String(message.id),
    method: message.method,
    sessionId: message.params?.sessionId,
  };
}
// Keep one consumer-driven read chain. The copy precedes SDK schema parsing,
// and cancellation joins the same upstream reader instead of a background tee.
function captureIncoming(readable, frames) {
  const reader = readable.getReader();
  let stopped = false,
    cancelling;
  const cancel = (reason) => {
    stopped = true;
    return (cancelling ??= reader
      .cancel(reason)
      .finally(() => reader.releaseLock()));
  };
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (stopped) return;
          if (next.done) {
            stopped = true;
            reader.releaseLock();
            controller.close();
            return;
          }
          frames.push(structuredClone(next.value));
          controller.enqueue(next.value);
        } catch (error) {
          if (stopped) return;
          try {
            await cancel(error);
          } catch (cleanupError) {
            if (cleanupError !== error) {
              controller.error(
                new AggregateError(
                  [error, cleanupError],
                  "Raw frame capture and upstream cleanup failed",
                ),
              );
              return;
            }
          }
          controller.error(error);
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
}

export function observeStream(stream, observed, frames, notifications) {
  assert(
    frames === undefined || Array.isArray(frames),
    "raw frame destination must be an array",
  );
  const writer = stream.writable.getWriter();
  let readable = stream.readable;
  try {
    if (frames !== undefined) readable = captureIncoming(readable, frames);
  } catch (error) {
    writer.releaseLock();
    throw error;
  }
  return {
    readable,
    writable: new WritableStream({
      write(message) {
        const metadata = requestMetadata(message);
        if (metadata) observed.push(metadata);
        return notifications
          ? notifications.write(message, (frame) => writer.write(frame))
          : writer.write(message);
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }),
  };
}
export function observeFetch(send, observed) {
  return async (url, init) => {
    const metadata =
      init?.method === "POST"
        ? requestMetadata(JSON.parse(init.body))
        : undefined;
    const response = await send(url, init);
    if (metadata) {
      const traceID = response.headers.get("X-Antnest-Trace-ID");
      assert.match(
        traceID ?? "",
        /^[a-f0-9]{32}$/,
        "Gateway response trace identity missing",
      );
      observed.push({ ...metadata, traceID });
    }
    return response;
  };
}
