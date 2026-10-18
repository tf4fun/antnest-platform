import assert from "node:assert/strict";
import test from "node:test";
import { restorePrivateEvidenceFixture } from "./restore-private-evidence.fixture.mjs";
const url = new URL("./restore-private-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function fixture(t) {
  assert.equal(typeof implementation.restorePrivateAdmission, "function");
  return restorePrivateEvidenceFixture(t);
}

test("Restore admits two real private connections, original history and untouched Session Tool execution", async (t) => {
  const result = await fixture(t),
    before = JSON.stringify(result);
  const outcome = implementation.restorePrivateAdmission(result);
  assert.equal(outcome.strict_exit, 0);
  assert.equal(outcome.accepted_exit, 0);
  assert.deepEqual(outcome.inventory, {
    connections: 2,
    initializations: 2,
    business_requests: 6,
    runs: 2,
    provider_requests: 4,
    runtime_tool_calls: 2,
    lifecycle_admissions: 4,
    login_sessions: 2,
    databases: 7,
    persistent_volumes: 2,
    encryption_keys: 3,
  });
  assert.equal(JSON.stringify(result), before);
  const summary = implementation.restorePublicResult(result);
  for (const key of [
    "private_restore",
    "private_connections",
    "private_collection_errors",
    "private_cleanup_completed",
  ])
    assert.equal(summary[key], undefined);
  assert.equal(summary.completed_runs, 2);
  assert.equal(JSON.stringify(result), before);
});

test("Restore rejects substituted login, wire, Run, recovery and lifecycle evidence", async (t) => {
  const original = await fixture(t);
  implementation.restorePrivateAdmission(original);
  for (const mutate of [
    (r) => r.private_connections.pop(),
    (r) => r.request_traces.pop(),
    (r) => (r.private_restore.logins[0].principal.user_id = "administrator"),
    (r) =>
      (r.private_restore.logins[1].session_digest =
        r.private_restore.logins[0].session_digest),
    (r) =>
      (r.private_restore.delegations[1].session_digest =
        r.private_restore.logins[0].session_digest),
    (r) => (r.private_restore.logins[1].status = 401),
    (r) => (r.private_restore.pre_restore_connections[0].closed = false),
    (r) => r.private_restore.transport_after.rows[0].RestartCount++,
    (r) =>
      (r.private_restore.runs[1].execution_snapshot.executionRevision =
        "old-revision"),
    (r) => (r.private_restore.preserved_runs[2].state = "cancelled"),
    (r) => r.private_restore.histories[1].push({ sessionId: "foreign" }),
    (r) =>
      (r.private_connections[1].evidence[0].inputSessionID =
        r.private_connections[0].evidence[1].sessionId),
    (r) => r.private_connections[0].raw_frames.pop(),
    (r) => (r.request_traces[3].run_id = "foreign"),
    (r) => r.private_restore.before_model.pop(),
    (r) => (r.private_restore.provider_requests[0].trace_id = "foreign"),
    (r) => (r.private_restore.lifecycle_admissions[2].kind = "rebuild"),
    (r) => (r.traces[1].request_id = "foreign"),
    (r) => (r.database_count = 6),
    (r) => delete r.database_fingerprints.antnest_temporal,
    (r) => (r.original_acp_ciphertext_read = false),
    (r) => (r.private_cleanup_completed = false),
    (r) => r.private_collection_errors.push("original failure"),
    (r) => (r.private_connections[0].initialization.rejection = "agent_busy"),
    (r) =>
      (r.private_connections[1].evidence[1].rejectionReceipt = {
        code: "agent_unavailable",
      }),
    (r) => (r.request_traces[0].rejection = "agent_unavailable"),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => implementation.restorePrivateAdmission(changed));
  }
});

test("Restore retains strict failures but cannot borrow Loss or Managed semantic denial allowances", async (t) => {
  const original = await fixture(t);
  for (const reason of [
    "loss-unavailable-rejection",
    "managed-busy-rejection",
    "unknown",
  ]) {
    const changed = structuredClone(original),
      trace = changed.request_traces[3];
    trace.strict_trace = "failed";
    trace.error_spans = 1;
    trace.raw_error_inventory = [
      { trace_id: trace.trace_id, span_id: "error" },
    ];
    trace.owned_error_spans = [{ ...trace.raw_error_inventory[0], reason }];
    assert.notEqual(
      implementation.restorePrivateAdmission(changed).accepted_exit,
      0,
    );
    assert.equal(trace.strict_trace, "failed");
  }
  const changed = structuredClone(original);
  changed.traces[0].warnings.push("unknown internal warning");
  assert.notEqual(
    implementation.restorePrivateAdmission(changed).accepted_exit,
    0,
  );
});
