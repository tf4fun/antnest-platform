import assert from "node:assert/strict";

function requestMetadata(message) {
  if (typeof message?.method !== "string" || message.id === undefined) return;
  return {
    requestId: String(message.id),
    method: message.method,
    sessionId: message.params?.sessionId,
  };
}
export function observeStream(stream, observed) {
  const writer = stream.writable.getWriter();
  return {
    readable: stream.readable,
    writable: new WritableStream({
      write(message) {
        const metadata = requestMetadata(message);
        if (metadata) observed.push(metadata);
        return writer.write(message);
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
