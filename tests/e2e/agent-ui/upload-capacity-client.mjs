import assert from "node:assert/strict";
import { request } from "node:http";

const stamp = () => process.hrtime.bigint().toString();
export function startHeldUpload(url, headers, body, signal) {
  assert(Buffer.isBuffer(body) && body.length > 1);
  signal?.throwIfAborted();
  const pending = Promise.withResolvers(),
    closed = Promise.withResolvers(),
    flushed = Promise.withResolvers();
  const evidence = {
    sent_ns: stamp(),
    sent_perf_ms: performance.now(),
    body_bytes: body.length,
  };
  let responseEnded = false,
    finished = false,
    closing;
  const outgoing = request(
    url,
    {
      method: "POST",
      agent: false,
      signal: AbortSignal.any(
        [signal, AbortSignal.timeout(45000)].filter(Boolean),
      ),
      headers: {
        ...headers,
        "content-type": "application/json",
        "content-length": body.length,
      },
    },
    async (incoming) => {
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of incoming) {
          bytes += chunk.length;
          assert(bytes < 128 * 1024, "capacity response exceeded budget");
          chunks.push(chunk);
        }
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        responseEnded = true;
        const result = {
          status: incoming.statusCode,
          trace_id: incoming.headers["x-antnest-trace-id"],
          response_trace_id: incoming.headers["x-antnest-trace-id"],
          response,
          complete_ns: stamp(),
          complete_perf_ms: performance.now(),
        };
        Object.assign(evidence, result);
        pending.resolve(result);
      } catch (error) {
        pending.reject(error);
        outgoing.destroy(error);
      }
    },
  );
  outgoing.on("error", (error) => {
    pending.reject(error);
    flushed.reject(error);
  });
  outgoing.once("close", () => {
    if (!responseEnded)
      pending.reject(new Error("upload closed before complete response"));
    closed.resolve();
  });
  void pending.promise.catch(() => {});
  void flushed.promise.catch(() => {});
  outgoing.write(body.subarray(0, -1), (error) =>
    error ? flushed.reject(error) : flushed.resolve(),
  );
  return {
    evidence,
    response: pending.promise,
    flushed: flushed.promise,
    async finish() {
      assert(
        !finished && !outgoing.destroyed,
        "upload cannot send EOF twice or after closure",
      );
      finished = true;
      evidence.eof_sent_ns = stamp();
      evidence.eof_sent_perf_ms = performance.now();
      await new Promise((resolve, reject) =>
        outgoing.end(body.subarray(-1), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    },
    closeAndWait() {
      return (closing ??= (async () => {
        if (!responseEnded) outgoing.destroy(new Error("upload cleanup"));
        await closed.promise;
        await Promise.allSettled([pending.promise, flushed.promise]);
        evidence.joined = true;
      })());
    },
  };
}
