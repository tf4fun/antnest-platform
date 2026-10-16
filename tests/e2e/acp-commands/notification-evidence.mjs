import assert from "node:assert/strict";

// These receipts describe local SDK writes. The locked WS adapter calls
// socket.send without awaiting its callback or any peer acknowledgement.
export function createNotificationEvidence(binding) {
  assert([1, 2].includes(binding.version));
  assert(typeof binding.agentId === "string" && binding.agentId.length > 0);
  assert.match(binding.connectionTraceID, /^[a-f0-9]{32}$/);
  assert.match(binding.clientSpanID, /^[a-f0-9]{16}$/);
  const identity = Object.freeze({
    agentId: binding.agentId,
    version: binding.version,
    connectionTraceID: binding.connectionTraceID,
    clientSpanID: binding.clientSpanID,
  });
  const attempts = [],
    ownedParams = new WeakMap(),
    pending = new Set(),
    failures = new Set();
  const closed = new Error("private ACP notification connection closed");
  let stopping = false;
  const session = (params) =>
    typeof params?.sessionId === "string" ? params.sessionId : null;
  const attempt = (method, params, origin) => {
    const value = {
      ...identity,
      index: attempts.length,
      method,
      sessionId: session(params),
      origin,
      status: stopping ? "closed_before_write" : "queued",
      wireObserved: false,
      writeOutcome: null,
    };
    attempts.push(value);
    return value;
  };
  const failed = (value, error) => {
    if (!value.status.startsWith("closed_")) value.status = "failed";
    failures.add(error);
  };
  const track = (task) => {
    pending.add(task);
    // Observe failure immediately, including callers that have not awaited
    // notify yet. The original returned promise still rejects unchanged.
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  return {
    snapshot: () =>
      Object.freeze(attempts.map((value) => Object.freeze({ ...value }))),
    get pending() {
      return pending.size;
    },
    notify(method, params, send) {
      assert(typeof method === "string" && method.length > 0);
      assert(
        params !== null && typeof params === "object" && !Array.isArray(params),
      );
      // The SDK retains this object through its write queue and, for v2,
      // initialization barrier. Each call gets its own identity, even when
      // two concurrent notifications have identical method/Session values.
      const privateParams = structuredClone(params);
      const value = attempt(method, privateParams, "notify");
      if (stopping) return Promise.reject(closed);
      ownedParams.set(privateParams, value);
      return track(
        (async () => {
          try {
            await send(method, privateParams);
            assert.equal(
              value.status,
              "write_completed",
              "notification write receipt missing",
            );
          } catch (error) {
            failed(value, error);
            throw error;
          } finally {
            ownedParams.delete(privateParams);
          }
        })(),
      );
    },
    write(message, forward) {
      if (typeof message?.method !== "string" || Object.hasOwn(message, "id"))
        return forward(message);
      const value =
        ownedParams.get(message.params) ??
        attempt(message.method, message.params, "sdk");
      return track(
        (async () => {
          try {
            if (stopping) throw closed;
            // Observe and forward the same private frame. No caller-owned object
            // can alter its method or Session while the actual write is pending.
            const frame = structuredClone(message);
            assert.equal(frame.method, value.method);
            assert.equal(session(frame.params), value.sessionId);
            assert.equal(
              value.wireObserved,
              false,
              "duplicate notification write",
            );
            value.wireObserved = true;
            value.status = "writing";
            try {
              await forward(frame);
              value.writeOutcome = "completed";
            } catch (error) {
              value.writeOutcome = "failed";
              throw error;
            }
            if (stopping) throw closed;
            value.status = "write_completed";
          } catch (error) {
            failed(value, error);
            throw error;
          }
        })(),
      );
    },
    stop() {
      stopping = true;
      for (const value of attempts) {
        if (value.status === "queued") value.status = "closed_before_write";
        else if (value.status === "writing")
          value.status = "closed_during_write";
      }
    },
    async join() {
      while (pending.size) await Promise.allSettled([...pending]);
      if (failures.size)
        throw new AggregateError(
          [...failures],
          "private ACP notification writes failed",
        );
    },
  };
}
