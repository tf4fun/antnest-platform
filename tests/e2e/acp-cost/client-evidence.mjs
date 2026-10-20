import assert from "node:assert/strict";

export function costCompletionFields(outcomes) {
  assert(Array.isArray(outcomes));
  const transports = outcomes.map((row) => row.transport);
  assert.deepEqual(transports, ["v1-ws", "v2-ws", "v1-http"]);
  for (const row of outcomes) assert.equal(row.restored_sessions, 3);
  return {
    scenarios: outcomes.length,
    outcomes: structuredClone(outcomes),
    transports,
    restored_sessions: outcomes.reduce(
      (count, row) => count + row.restored_sessions,
      0,
    ),
  };
}
import { assertModelSelection } from "./evidence.mjs";

function actualReceipt(client, method, sessionId) {
  const actual = client.lastRequest;
  assert.equal(actual?.boundary, "private-acp");
  assert.equal(actual.method, method);
  assert.equal(actual.outcome, "succeeded");
  assert.equal(actual.protocolVersion, client.version);
  assert.equal(actual.inputSessionID, sessionId ?? null);
  const receipt = actual.requestReceipt;
  assert(
    receipt && typeof receipt === "object",
    "actual Cost SDK receipt missing",
  );
  assert.equal(receipt.requestId, actual.requestId);
  assert.equal(receipt.params.sessionId, sessionId);
  return receipt;
}

export function bindCostConfiguration(client, sessionId, selection) {
  const receipt = actualReceipt(client, "session/set_config_option", sessionId);
  assert.deepEqual(receipt.params, {
    sessionId,
    configId: "model",
    value: selection,
    ...(client.version === 2 ? { type: "id" } : {}),
  });
  assertModelSelection(receipt.result, selection);
  Object.assign(client.lastRequest, {
    modelSelection: selection,
    configurationReceipt: structuredClone(receipt),
  });
}

export function bindCostList(client, sessionIds) {
  const receipt = actualReceipt(client, "session/list");
  assert.deepEqual(receipt.params, {});
  assert(Array.isArray(sessionIds));
  assert(sessionIds.every((id) => typeof id === "string" && id.length));
  assert.equal(new Set(sessionIds).size, sessionIds.length);
  assert.equal(receipt.result.nextCursor, undefined, "Cost list truncated");
  assert(Array.isArray(receipt.result.sessions));
  assert.deepEqual(
    receipt.result.sessions.map((row) => row.sessionId).sort(),
    [...sessionIds].sort(),
  );
  Object.assign(client.lastRequest, {
    listSessionIds: structuredClone(sessionIds),
    listReceipt: structuredClone(receipt),
  });
}

export function bindCostPrompt(client, sessionId, result, phase) {
  const receipt = actualReceipt(client, "session/prompt", sessionId);
  assert.deepEqual(
    receipt.result,
    result,
    "Cost prompt reply differs from actual SDK receipt",
  );
  assert(typeof phase === "string" && phase.length);
  assert.deepEqual(receipt.params.prompt, [{ type: "text", text: phase }]);
  const terminals = client.rawUpdates.filter(
    ({ update }) =>
      update.sessionUpdate === "state_update" && update.state === "idle",
  );
  if (client.version === 1) {
    assert.deepEqual(receipt.result, { stopReason: "end_turn" });
    assert.deepEqual(terminals, []);
  } else {
    assert.equal(client.version, 2);
    assert.deepEqual(Object.keys(receipt.result), ["messageId"]);
    assert(
      typeof receipt.result.messageId === "string" &&
        receipt.result.messageId.length,
    );
    assert.deepEqual(terminals, [
      {
        sessionId,
        update: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        },
      },
    ]);
  }
  Object.assign(client.lastRequest, {
    kind: "native",
    phase,
    label: phase,
    promptReceipt: structuredClone({
      requestId: receipt.requestId,
      sessionId,
      result: receipt.result,
      error: null,
      terminals,
    }),
  });
}

// Register the rejection observer before publication work, always release the
// held model and join the original bounded prompt, even when release fails.
export async function withFrozenCostPrompt(pending, action, release) {
  const observed = pending.then(
    (value) => ({ value }),
    (error) => ({ failed: true, error }),
  );
  const errors = [];
  for (const step of [action, release]) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  const result = await observed;
  if (result.failed) errors.push(result.error);
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "Cost admission, release and prompt failed",
    );
  return result.value;
}
