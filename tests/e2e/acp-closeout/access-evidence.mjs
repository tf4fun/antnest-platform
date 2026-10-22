import assert from "node:assert/strict";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";

export function assertExecutionBinding(result, expected) {
  assert(
    expected.requestId && expected.runId,
    "wire and durable identities required",
  );
  assert.equal(result.request_id, expected.requestId, "wrong JSON-RPC request");
  assert.equal(
    result.run_id,
    expected.runId,
    "Trace belongs to another durable Run",
  );
}

export function assertScopeDenial(error, scope) {
  assert(["principal", "Agent"].includes(scope));
  assertAdmissionError(error, "session_access_denied");
  assert.deepEqual(
    error.data,
    admissionErrorReceipt("session_access_denied").data,
    "Session denial leaked extra data",
  );
}

export function assertReplayMetadata(updates, session) {
  assert(
    updates.every((u) => u.sessionId === session.id),
    "foreign Session notification",
  );
  const infos = updates.filter(
    (u) => u.update.sessionUpdate === "session_info_update",
  );
  assert.equal(infos.length, 1, "fresh replay metadata missing or duplicated");
  assert.deepEqual(infos[0].update, {
    sessionUpdate: "session_info_update",
    title: session.title,
    updatedAt: new Date(session.updated_at).toISOString(),
  });
}
