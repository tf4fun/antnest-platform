import assert from "node:assert/strict";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";
import {
  openPrivateCommandConnection,
  withPrivateCommandConnection,
} from "../acp-commands/connection.mjs";

function identity(transport, actual, method, sessionId) {
  assert.equal(transport.boundary, "private-acp");
  assert.equal(transport.transport, "websocket");
  assert.equal(actual?.method, method, "actual Progress SDK request required");
  assert(typeof actual.requestId === "string" && actual.requestId.length > 0);
  const matches = transport.requests.filter(
    (row) => row.requestId === actual.requestId,
  );
  assert.equal(matches.length, 1, "Progress request missing or duplicated");
  assert.strictEqual(
    matches[0],
    transport.requests.at(-1),
    "stale Progress request",
  );
  assert.equal(matches[0].method, method);
  const inputSessionID = matches[0].sessionId ?? null;
  if (Object.hasOwn(actual, "inputSessionID"))
    assert.equal(actual.inputSessionID, inputSessionID);
  if (["initialize", "session/new"].includes(method))
    assert.equal(inputSessionID, null);
  else {
    assert(typeof sessionId === "string" && sessionId.length > 0);
    assert.equal(sessionId, inputSessionID);
  }
  return {
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: transport.version,
    agentId: transport.agentId,
    connectionTraceID: transport.connectionTraceID,
    clientSpanID: transport.clientSpanID,
    requestId: actual.requestId,
    method,
    inputSessionID,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

// Progress deliberately disconnects an outstanding v1 prompt after a preview.
// Keep that narrowly observed event separate from failed or completed RPCs.
export async function openPrivateProgressConnection(
  version,
  agentId,
  browser,
  options,
) {
  assert([1, 2].includes(version), "unsupported Progress protocol");
  const transport = await openPrivateCommandConnection(
    { version },
    agentId,
    browser,
    {
      ...options,
      captureNotifications: true,
      captureRawFrames: true,
    },
  );
  const isLocalCloseError = transport.isLocalCloseError;
  assert.equal(typeof isLocalCloseError, "function");
  const client = Object.create(transport);
  const records = [],
    pending = new Set();
  let initialization,
    active,
    replayRequest,
    replayClosing = false,
    closing;
  const replied = (requestId) =>
    transport.rawFrames.some(
      (frame) =>
        Object.hasOwn(frame, "id") &&
        String(frame.id) === requestId &&
        (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")),
    );
  Object.defineProperties(client, {
    initializationRequest: {
      enumerable: true,
      get: () => structuredClone(initialization),
    },
    requestEvidence: { enumerable: true, get: () => structuredClone(records) },
    lastRequest: {
      enumerable: true,
      get: () => structuredClone(records.at(-1)),
    },
  });
  client.closeAndWait = () => {
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        const errors = [];
        try {
          await transport.closeAndWait();
        } catch (error) {
          errors.push(error);
        }
        while (pending.size) await Promise.allSettled([...pending]);
        try {
          const all = [initialization, ...records];
          assert.equal(
            transport.requests.length,
            all.length,
            "unrecorded Progress request",
          );
          assert.equal(
            new Set(all.map((row) => row.requestId)).size,
            all.length,
            "duplicate Progress request identity",
          );
          assert.deepEqual(
            transport.requests.map(({ requestId, method, sessionId }) => ({
              requestId,
              method,
              sessionId: sessionId ?? null,
            })),
            all.map(({ requestId, method, inputSessionID }) => ({
              requestId,
              method,
              sessionId: inputSessionID,
            })),
          );
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length)
          throw new AggregateError(
            errors,
            "Progress connection cleanup failed",
          );
      });
      void closing.catch(() => {});
    }
    return closing;
  };
  client.close = client.closeAndWait;
  client.disconnectForReplay = async () => {
    if (replayClosing) return client.closeAndWait();
    assert(
      !closing && transport.closeCode === undefined,
      "Progress connection already closed before replay disconnect",
    );
    assert(
      (active?.name ?? records.at(-1)?.method?.split("/")[1]) === "prompt",
      "replay disconnect requires the original prompt",
    );
    if (version === 1 && active) {
      const actual = transport.requests.at(-1);
      assert.equal(actual.method, "session/prompt");
      if (!replied(actual.requestId)) replayRequest = active;
    }
    replayClosing = true;
    return client.closeAndWait();
  };
  client.request = (name, params, timeout) => {
    if (closing)
      return Promise.reject(new Error("Progress connection is closing"));
    if (pending.size)
      return Promise.reject(new Error("Progress request overlap"));
    assert(
      ["new", "prompt", version === 1 ? "load" : "resume"].includes(name),
      "unsupported Progress request",
    );
    const state = { name, params: structuredClone(params) };
    active = state;
    const task = perform(state, timeout);
    pending.add(task);
    const finished = () => {
      pending.delete(task);
      if (active === state) active = undefined;
    };
    void task.then(finished, finished);
    return task;
  };
  async function perform(state, timeout) {
    const { name, params } = state,
      previous = transport.lastRequest;
    const errors = [];
    let result, original;
    try {
      result = await transport.request(name, params, timeout);
    } catch (error) {
      original = error;
      errors.push(error);
    }
    try {
      const actual = transport.lastRequest;
      if (actual && actual !== previous) {
        const row = identity(
          transport,
          actual,
          `session/${name}`,
          name === "new" ? result?.sessionId : params.sessionId,
        );
        const barrier = original?.data?.code === "runtime_barrier_required";
        if (barrier) assertAdmissionError(original, "runtime_barrier_required");
        Object.assign(row, {
          outcome: barrier ? "rejected" : original ? "failed" : "succeeded",
        });
        if (barrier) {
          const expected = admissionErrorReceipt("runtime_barrier_required");
          Object.assign(row, {
            rejection: "runtime_barrier_required",
            rejectionReceipt: {
              rpcCode: expected.code,
              ...expected.data,
            },
          });
        }
        if (!original)
          row.requestReceipt = structuredClone({
            requestId: row.requestId,
            params,
            result,
          });
        else if (
          replayRequest === state &&
          isLocalCloseError(original) &&
          !replied(row.requestId)
        )
          row.closedBeforeResponse = true;
        records.push(row);
      }
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, "Progress request and evidence failed");
    return result;
  }
  try {
    assert.equal(
      transport.requests.length,
      1,
      "one actual Progress initialize required",
    );
    initialization = {
      ...identity(transport, transport.requests[0], "initialize"),
      outcome: "succeeded",
      initializationResult: structuredClone(transport.initializationResult),
    };
    return client;
  } catch (error) {
    return withPrivateCommandConnection(transport, [], async () => {
      throw error;
    });
  }
}
