import assert from "node:assert/strict";
import { openBrowserPrivateACP } from "../identity-closeout/private-acp-browser.mjs";
import {
  createPrivateACPRecorder,
  checkPrivateACPConnection,
} from "../../support/private-acp-recorder.mjs";

const disconnectProofs = new WeakMap();
function fail(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Workspace request, evidence or cleanup failed",
    );
}
const responses = (transport, requestId) =>
  transport.rawFrames.filter(
    (frame) =>
      Object.hasOwn(frame, "id") &&
      String(frame.id) === requestId &&
      (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")),
  );

// An archived copy cannot authorize a deliberate-disconnect Trace exception.
// Only the original receipt, issued after joining this actual connection, can.
export function inspectWorkspaceDisconnect(receipt) {
  const proof = disconnectProofs.get(receipt);
  assert(proof, "original Workspace disconnect receipt required");
  assert(proof.joined(), "Workspace disconnect did not join successfully");
  assert.deepEqual(
    receipt,
    proof.original,
    "Workspace disconnect receipt changed",
  );
  proof.validate();
  return structuredClone(receipt);
}

export async function openWorkspaceConnection(agentId, browser, options) {
  assert.equal(
    typeof options.preserve,
    "function",
    "Workspace private archive required",
  );
  const transport = await openBrowserPrivateACP(1, agentId, browser, {
    ...options,
    captureRawFrames: true,
    captureNotifications: true,
    requestPermission: ({ params }) => {
      const option = params.options.find((item) => item.kind === "allow_once");
      assert(option, "Workspace Tool requires its original one-use permission");
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    },
  });
  try {
    return await recordWorkspaceConnection(transport, options);
  } catch (error) {
    const errors = [error];
    try {
      await transport.closeAndWait();
    } catch (cleanup) {
      errors.push(cleanup);
    }
    fail(errors);
  }
}

export async function recordWorkspaceConnection(
  transport,
  { preserve, signal },
) {
  assert.equal(transport.version, 1);
  assert.equal(typeof preserve, "function");
  assert.equal(typeof transport.isLocalCloseError, "function");
  const pending = new Set(),
    archiveErrors = [];
  let active, selected, closure, closing, disconnect;
  let joined = false,
    archiving = Promise.resolve();
  const snapshotOf = (value) => ({
    ...value,
    close_receipt: closure ? structuredClone(closure) : null,
    notifications: structuredClone(transport.notifications),
    deliberate_disconnects: disconnect ? [structuredClone(disconnect)] : [],
  });
  const archive = (value) => {
    const captured = snapshotOf(value);
    const task = archiving.then(() => preserve(captured));
    archiving = task.catch((error) => {
      archiveErrors.push(error);
    });
    return task;
  };
  const observed = Object.create(transport);
  observed.request = async (name, params, timeout) => {
    const state = active;
    try {
      return await transport.request(name, params, timeout);
    } catch (error) {
      // Keep the exact original Error even if the recorder's subsequent archive
      // also fails and its caller receives an AggregateError.
      state.error = error;
      throw error;
    }
  };
  observed.closeAndWait = async () => {
    closure = await transport.closeAndWait();
    return closure;
  };
  const recorder = createPrivateACPRecorder(
    observed,
    { agentId: transport.agentId, version: 1 },
    archive,
  );
  const snapshot = () => snapshotOf(recorder.snapshot());
  const client = Object.create(transport);
  client.snapshot = snapshot;
  Object.defineProperties(client, {
    disconnectReceipts: { get: () => (disconnect ? [disconnect] : []) },
    notificationReceipts: { get: () => transport.notifications },
    initializationRequest: { get: () => recorder.snapshot().initialization },
    requestEvidence: { get: () => recorder.snapshot().evidence },
  });
  client.request = (name, params, timeout) => {
    if (closing || signal?.aborted)
      return Promise.reject(
        signal?.reason ?? new Error("Workspace connection is closing"),
      );
    if (active)
      return Promise.reject(new Error("Workspace connection request overlap"));
    assert(
      ["new", "load", "prompt"].includes(name),
      "unsupported Workspace request",
    );
    const state = {
      name,
      params: structuredClone(params),
      offset: transport.requests.length,
    };
    active = state;
    const task = recorder.request(name, params, timeout).then(
      (value) => {
        signal?.throwIfAborted();
        return value;
      },
      (error) => {
        fail(signal?.aborted ? [error, signal.reason] : [error]);
      },
    );
    pending.add(task);
    const finished = () => {
      pending.delete(task);
      if (active === state) active = undefined;
    };
    void task.then(finished, finished);
    return task;
  };
  function validateDisconnect() {
    signal?.throwIfAborted();
    const { state, wire, phase, startedAt } = selected;
    assert(
      transport.isLocalCloseError(state.error),
      "original local-close Error required",
    );
    assert.equal(
      responses(transport, wire.requestId).length,
      0,
      "disconnected Prompt has a wire response",
    );
    assert(closure, "actual Workspace close receipt missing");
    assert.equal(
      closure.localClose,
      true,
      "remote closure is not a deliberate disconnect",
    );
    assert([1000, 1005].includes(closure.code), "abnormal Workspace closure");
    assert(
      Number.isFinite(closure.at) && closure.at >= startedAt,
      "closure precedes deliberate disconnect",
    );
    const value = recorder.snapshot();
    checkPrivateACPConnection(value);
    const rows = value.evidence.filter(
      (row) => row.requestId === wire.requestId,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.outcome, "failed");
    assert.equal(row.method, "session/prompt");
    assert.equal(row.inputSessionID, state.params.sessionId);
    assert.deepEqual(row.requestParams, state.params);
    assert.deepEqual(state.params.prompt, [{ type: "text", text: phase }]);
    return row;
  }
  client.closeAndWait = () => {
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        signal?.removeEventListener("abort", abort);
        const errors = [];
        try {
          await recorder.closeAndWait();
        } catch (error) {
          errors.push(error);
        }
        while (pending.size) await Promise.allSettled([...pending]);
        if (selected) {
          try {
            const row = validateDisconnect();
            disconnect = {
              boundary: row.boundary,
              transport: row.transport,
              protocolVersion: row.protocolVersion,
              agentId: row.agentId,
              connectionTraceID: row.connectionTraceID,
              clientSpanID: row.clientSpanID,
              requestId: row.requestId,
              method: row.method,
              inputSessionID: row.inputSessionID,
              sessionId: row.sessionId,
              phase: selected.phase,
              started_at: selected.startedAt,
              close: structuredClone(closure),
              original_local_close_error: true,
              response_absent: true,
            };
            disconnectProofs.set(disconnect, {
              original: structuredClone(disconnect),
              joined: () => joined,
              validate: validateDisconnect,
            });
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await archive(recorder.snapshot());
        } catch (error) {
          errors.push(error);
        }
        errors.push(...archiveErrors);
        if (signal?.aborted) errors.push(signal.reason);
        fail(errors);
        joined = true;
        return snapshot();
      });
      void closing.catch(() => {});
    }
    return closing;
  };
  client.close = client.closeAndWait;
  client.disconnectPending = (phase) => {
    signal?.throwIfAborted();
    assert(
      ["c4-cancel", "c4-offline"].includes(phase),
      "unknown Workspace disconnect phase",
    );
    assert(
      !closing && transport.closeCode === undefined,
      "Workspace connection already closing",
    );
    assert(
      active?.name === "prompt",
      "Workspace disconnect requires an active Prompt",
    );
    assert.deepEqual(
      active.params.prompt,
      [{ type: "text", text: phase }],
      "foreign Workspace Prompt phase",
    );
    const observed = transport.requests.slice(active.offset);
    assert.equal(
      observed.length,
      1,
      "one actual pending Workspace request required",
    );
    const wire = observed[0];
    assert.equal(wire.method, "session/prompt");
    assert.equal(wire.sessionId, active.params.sessionId);
    assert.equal(
      responses(transport, wire.requestId).length,
      0,
      "Prompt already has a response",
    );
    assert(
      !Object.hasOwn(active, "error"),
      "Prompt already failed before disconnect",
    );
    selected = {
      state: active,
      wire: structuredClone(wire),
      phase,
      startedAt: Date.now(),
    };
    return client.closeAndWait();
  };
  const abort = () => {
    void client.closeAndWait().catch(() => {});
  };
  try {
    signal?.addEventListener("abort", abort, { once: true });
    signal?.throwIfAborted();
    await archive(recorder.snapshot());
    signal?.throwIfAborted();
    return client;
  } catch (error) {
    const errors = [error];
    try {
      await client.closeAndWait();
    } catch (cleanup) {
      errors.push(cleanup);
    }
    if (signal?.aborted) errors.push(signal.reason);
    fail(errors);
  }
}
