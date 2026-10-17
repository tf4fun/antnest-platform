import assert from "node:assert/strict";
import {
  openPrivateCommandConnection,
  withPrivateCommandConnection,
} from "../acp-commands/connection.mjs";

function identity(transport, actual, method, sessionId) {
  assert.equal(transport.boundary, "private-acp");
  assert.equal(transport.transport, "websocket");
  assert.equal(actual?.method, method, "actual Permissions request required");
  assert(typeof actual.requestId === "string" && actual.requestId.length > 0);
  const matches = transport.requests.filter(
    (row) => row.requestId === actual.requestId,
  );
  assert.equal(matches.length, 1, "Permissions request missing or duplicated");
  assert.strictEqual(
    matches[0],
    transport.requests.at(-1),
    "stale Permissions request",
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

// The consumer owns decisions and request outcomes. The shared transport still
// owns Identity delegation, SDK protocol handling and bounded socket cleanup.
export async function openPrivatePermissionConnection(
  version,
  agentId,
  browser,
  options,
) {
  assert([1, 2].includes(version), "unsupported Permissions protocol");
  const records = [],
    deliveries = [],
    evidenceErrors = [];
  const pending = new Set(),
    approvals = new Map(),
    callbacks = new Set();
  let transport, initialization, active, replayRequest, closing, replayClosing;
  const permission = ({ params, signal, requestId }) => {
    let operation;
    try {
      assert(transport, "permission arrived before initialization completed");
      const sessionId = active
        ? active.params.sessionId
        : records.at(-1)?.sessionId;
      assert(typeof sessionId === "string" && sessionId.length > 0);
      assert.equal(
        params.sessionId,
        sessionId,
        "permission belongs to another Session",
      );
      assert(
        ["string", "number"].includes(typeof requestId),
        "actual permission request ID required",
      );
      const id = String(requestId);
      assert(
        !deliveries.some((row) => row.requestId === id),
        "duplicate permission delivery",
      );
      const row = {
        requestId: id,
        params: structuredClone(params),
        outcome: "pending",
      };
      const deferred = Promise.withResolvers();
      const settle = (outcome, optionId) => {
        assert.equal(row.outcome, "pending", "permission already settled");
        signal.removeEventListener("abort", abort);
        approvals.delete(id);
        row.outcome = outcome;
        if (optionId !== undefined) row.optionId = optionId;
        deferred.resolve({
          outcome: { outcome, ...(optionId === undefined ? {} : { optionId }) },
        });
      };
      const abort = () => {
        if (row.outcome === "pending") settle("cancelled");
      };
      const answer = (optionId) => {
        assert.equal(row.outcome, "pending", "permission already settled");
        assert(
          row.params.options.some((option) => option.optionId === optionId),
          "permission option was not offered",
        );
        settle("selected", optionId);
      };
      deliveries.push(row);
      approvals.set(id, { row, answer });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      operation = deferred.promise.finally(() => callbacks.delete(operation));
      callbacks.add(operation);
      return operation;
    } catch (error) {
      evidenceErrors.push(error);
      throw error;
    }
  };
  transport = await openPrivateCommandConnection(
    { version },
    agentId,
    browser,
    {
      ...options,
      captureRawFrames: true,
      captureNotifications: true,
      requestPermission: permission,
    },
  );
  const client = Object.create(transport);
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
    permissionEvidence: {
      enumerable: true,
      get: () => structuredClone(deliveries),
    },
    pendingPermissions: {
      enumerable: true,
      get: () =>
        [...approvals.values()].map(({ row, answer }) => ({
          requestId: row.requestId,
          params: structuredClone(row.params),
          answer,
        })),
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
        while (callbacks.size) await Promise.allSettled([...callbacks]);
        errors.push(...evidenceErrors);
        try {
          assert.equal(
            approvals.size,
            0,
            "permission decisions did not settle",
          );
          const all = [initialization, ...records];
          assert.equal(
            new Set(all.map((row) => row.requestId)).size,
            all.length,
            "duplicate Permissions request identity",
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
            "unrecorded Permissions request",
          );
          assert.deepEqual(
            transport.rawFrames
              .filter((frame) => frame.method === "session/request_permission")
              .map(({ id, params }) => ({ requestId: String(id), params })),
            deliveries.map(({ requestId, params }) => ({ requestId, params })),
            "unrecorded or changed permission delivery",
          );
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length)
          throw new AggregateError(
            errors,
            "Permissions connection cleanup failed",
          );
      });
      void closing.catch(() => {});
    }
    return closing;
  };
  client.close = client.closeAndWait;
  client.disconnectForReplay = async () => {
    if (replayClosing) return replayClosing;
    assert(
      !closing && transport.closeCode === undefined,
      "Permissions connection already closed",
    );
    assert.equal(approvals.size, 1, "replay requires one pending approval");
    const approval = [...approvals.values()][0].row;
    if (version === 1) {
      assert(
        active?.name === "prompt",
        "v1 replay requires an unanswered prompt",
      );
      const actual = transport.requests.at(-1);
      assert.equal(actual.method, "session/prompt");
      assert(
        !replied(actual.requestId),
        "v1 replay requires an unanswered prompt",
      );
      assert.equal(approval.params.sessionId, active.params.sessionId);
      replayRequest = active;
    } else {
      assert.equal(
        active,
        undefined,
        "v2 replay requires a completed prompt ACK",
      );
      const row = records.at(-1);
      assert.equal(row?.method, "session/prompt");
      assert.equal(row.outcome, "succeeded");
      assert.equal(row.sessionId, approval.params.sessionId);
      assert(
        typeof row.requestReceipt?.result?.messageId === "string" &&
          row.requestReceipt.result.messageId.length > 0,
        "v2 replay requires its actual messageId ACK",
      );
    }
    replayClosing = client.closeAndWait().then(() => {
      const row = records.at(-1);
      assert.equal(row.sessionId, approval.params.sessionId);
      if (version === 1) {
        assert.equal(row.outcome, "failed");
        assert.equal(
          row.closedBeforeResponse,
          true,
          "v1 replay did not observe its original local close",
        );
      } else assert.equal(row.outcome, "succeeded");
    });
    return replayClosing;
  };
  client.request = (name, params, timeout) => {
    if (closing)
      return Promise.reject(new Error("Permissions connection is closing"));
    if (pending.size || approvals.size)
      return Promise.reject(new Error("Permissions request overlap"));
    assert(
      [
        "new",
        "setConfigOption",
        "prompt",
        version === 1 ? "load" : "resume",
      ].includes(name),
      "unsupported Permissions request",
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
          name === "setConfigOption"
            ? "session/set_config_option"
            : `session/${name}`,
          name === "new" ? result?.sessionId : params.sessionId,
        );
        const denied =
          original?.code === -32020 &&
          original.data?.code === "access_denied" &&
          original.data?.retryable === false;
        row.requestParams = structuredClone(params);
        row.outcome = denied ? "rejected" : original ? "failed" : "succeeded";
        if (denied) {
          assert.deepEqual(actual.rejectionReceipt, {
            rpcCode: -32020,
            code: "access_denied",
            retryable: false,
          });
          row.rejection = "access_denied";
          row.rejectionReceipt = structuredClone(actual.rejectionReceipt);
        }
        if (!original)
          row.requestReceipt = structuredClone({
            requestId: row.requestId,
            params,
            result,
          });
        else if (
          replayRequest === state &&
          transport.isLocalCloseError(original) &&
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
      throw new AggregateError(
        errors,
        "Permissions request and evidence failed",
      );
    return result;
  }
  try {
    assert.equal(
      transport.requests.length,
      1,
      "one actual Permissions initialize required",
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
