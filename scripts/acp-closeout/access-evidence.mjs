import assert from "node:assert/strict";

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
  assert.equal(error?.code, -32020, "expected ACP domain rejection");
  assert.equal(error.message, `Session belongs to another ${scope}`);
  assert.deepEqual(
    error.data,
    { code: "session_access_denied", retryable: false },
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
