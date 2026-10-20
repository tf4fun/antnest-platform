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

// Preparing opens only TCP; send() is the first HTTP write. The write callback
// proves local write completion, not remote receipt or cancellation processing.
export function prepareCapacityCancellation(url, headers, body, signal) {
  signal?.throwIfAborted();
  const bytes = Buffer.from(JSON.stringify(body));
  assert(bytes.length > 0 && bytes.length <= 16 * 1024);
  const ready = Promise.withResolvers(),
    written = Promise.withResolvers(),
    pending = Promise.withResolvers(),
    closed = Promise.withResolvers();
  const evidence = { prepared_ns: stamp(), body_bytes: bytes.length };
  let socketReady = false,
    sent = false,
    responseEnded = false,
    closing;
  const fail = (error) => {
    ready.reject(error);
    written.reject(error);
    pending.reject(error);
  };
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
        "content-length": bytes.length,
      },
    },
    async (incoming) => {
      try {
        assert(sent, "cancellation response preceded send");
        const chunks = [];
        let size = 0;
        for await (const chunk of incoming) {
          size += chunk.length;
          assert(size < 128 * 1024, "capacity response exceeded budget");
          chunks.push(chunk);
        }
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = {
          status: incoming.statusCode,
          trace_id: incoming.headers["x-antnest-trace-id"],
          response_trace_id: incoming.headers["x-antnest-trace-id"],
          response,
          complete_ns: stamp(),
          complete_perf_ms: performance.now(),
        };
        responseEnded = true;
        Object.assign(evidence, result);
        pending.resolve(result);
      } catch (error) {
        fail(error);
        incoming.destroy();
        outgoing.destroy(error);
      }
    },
  );
  outgoing.once("socket", (socket) => {
    socket.setNoDelay(true);
    const connected = () => {
      if (outgoing.destroyed) return;
      socketReady = true;
      evidence.socket_ready_ns = stamp();
      ready.resolve();
    };
    if (socket.connecting) socket.once("connect", connected);
    else connected();
  });
  outgoing.on("error", fail);
  outgoing.once("close", () => {
    written.reject(new Error("cancellation closed before write completion"));
    if (!responseEnded)
      fail(new Error("cancellation closed before complete response"));
    closed.resolve();
  });
  for (const value of [ready, written, pending])
    void value.promise.catch(() => {});
  return {
    evidence,
    ready: ready.promise,
    written: written.promise,
    response: pending.promise,
    send() {
      signal?.throwIfAborted();
      assert(!sent, "cancellation already sent");
      assert(
        socketReady && !outgoing.destroyed,
        "cancellation socket not ready",
      );
      sent = true;
      evidence.sent_ns = stamp();
      evidence.sent_perf_ms = performance.now();
      outgoing.end(bytes, (error) => {
        if (error) fail(error);
        else {
          evidence.written_ns = stamp();
          written.resolve();
        }
      });
      return pending.promise;
    },
    closeAndWait() {
      return (closing ??= (async () => {
        if (!responseEnded) outgoing.destroy(new Error("cancellation cleanup"));
        await closed.promise;
        await Promise.allSettled([
          ready.promise,
          written.promise,
          pending.promise,
        ]);
        evidence.joined = true;
      })());
    },
  };
}

// Callers provide bounded operations. Start the send and original SSE waiter
// together. A prepared request can defer costly Runtime sampling until its
// actual write completes; the original send still starts the acceptance clock.
// Join every branch even on failure. Branches stamp their own complete receipts.
export async function observeCapacityCancellation(
  actions,
  { cancellationWritten } = {},
) {
  const names = ["cancel", "quiescent", "terminal"];
  for (const name of names) assert.equal(typeof actions[name], "function");
  const results = await Promise.allSettled(
    names.map((name) =>
      Promise.resolve().then(async () => {
        if (name === "quiescent" && cancellationWritten !== undefined)
          await cancellationWritten;
        return actions[name]();
      }),
    ),
  );
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "capacity cancellation observation failed",
    );
  return Object.fromEntries(
    names.map((name, index) => [name, results[index].value]),
  );
}
