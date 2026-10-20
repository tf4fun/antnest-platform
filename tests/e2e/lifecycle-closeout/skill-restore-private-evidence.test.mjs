import assert from "node:assert/strict";
import test from "node:test";
import { skillRestorePrivateEvidenceFixture } from "./skill-restore-private-evidence.fixture.mjs";
const url = new URL("./skill-restore-private-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function fixture(t) {
  assert.equal(typeof implementation.skillRestorePrivateAdmission, "function");
  return skillRestorePrivateEvidenceFixture(t);
}

test("Skill-restore admits four real private connections, original history and untouched Session Tool execution", async (t) => {
  const result = await fixture(t),
    before = JSON.stringify(result);
  const outcome = implementation.skillRestorePrivateAdmission(result);
  assert.equal(outcome.strict_exit, 0);
  assert.equal(outcome.accepted_exit, 0);
  assert.deepEqual(outcome.inventory, {
    connections: 4,
    initializations: 4,
    business_requests: 10,
    runs: 4,
    provider_requests: 8,
    runtime_tool_calls: 4,
    lifecycle_admissions: 9,
    login_sessions: 2,
    databases: 8,
    persistent_volumes: 5,
    encryption_keys: 3,
  });
  assert.equal(JSON.stringify(result), before);
  const summary = implementation.skillRestorePublicResult(result);
  for (const key of [
    "private_skill_restore",
    "private_connections",
    "private_collection_errors",
    "private_cleanup_completed",
  ])
    assert.equal(summary[key], undefined);
  assert.equal(summary.completed_runs, 4);
  assert.equal(JSON.stringify(result), before);
});

test("Skill-restore rejects substituted login, wire, Run, recovery and lifecycle evidence", async (t) => {
  const original = await fixture(t);
  implementation.skillRestorePrivateAdmission(original);
  for (const mutate of [
    (r) => r.private_connections.pop(),
    (r) =>
      (r.private_skill_restore.states[3].skillVolume =
        r.private_skill_restore.states[2].skillVolume),
    (r) => (r.private_skill_restore.skill_files[2].content = "replacement v2"),
    (r) => r.private_skill_restore.recovery_after.volumes.pop(),
    (r) => (r.private_skill_restore.registry_stopped[0].State.Running = true),
    (r) => (r.private_skill_restore.blocked_enable.request.agent_id = "agent"),
    (r) => (r.private_skill_restore.blocked_enable.raw_text = "broken-json"),
    (r) =>
      (r.private_skill_restore.missing_volume.queries[0].body.request_id =
        "other-request"),
    (r) =>
      r.private_skill_restore.missing_volume.resources.containers.push(
        "stopped-runtime",
      ),
    (r) =>
      r.private_skill_restore.missing_volume.volume_query.lines.push(
        "skills-peer",
      ),
    (r) => (r.private_skill_restore.delegations[3].login_index = 0),
    (r) =>
      r.private_skill_restore.lifecycle_admissions.push({
        kind: "enable",
        agentID: "peer",
      }),
    (r) => r.request_traces.pop(),
    (r) =>
      (r.private_skill_restore.logins[0].principal.user_id = "administrator"),
    (r) =>
      (r.private_skill_restore.logins[1].session_digest =
        r.private_skill_restore.logins[0].session_digest),
    (r) =>
      (r.private_skill_restore.delegations[1].session_digest =
        r.private_skill_restore.logins[0].session_digest),
    (r) => (r.private_skill_restore.logins[1].status = 401),
    (r) => (r.private_skill_restore.pre_restore_connections[0].closed = false),
    (r) => r.private_skill_restore.transport_after.rows[0].RestartCount++,
    (r) =>
      (r.private_skill_restore.runs[1].execution_snapshot.executionRevision =
        "old-revision"),
    (r) => (r.private_skill_restore.preserved_runs[2].state = "cancelled"),
    (r) => r.private_skill_restore.histories[1].push({ sessionId: "foreign" }),
    (r) =>
      (r.private_connections[1].evidence[0].inputSessionID =
        r.private_connections[0].evidence[1].sessionId),
    (r) => r.private_connections[0].raw_frames.pop(),
    (r) => (r.request_traces[3].run_id = "foreign"),
    (r) => r.private_skill_restore.before_model.pop(),
    (r) => (r.private_skill_restore.provider_requests[0].trace_id = "foreign"),
    (r) => (r.private_skill_restore.lifecycle_admissions[2].kind = "rebuild"),
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
    assert.throws(() => implementation.skillRestorePrivateAdmission(changed));
  }
});

test("Skill-restore retains strict failures but cannot borrow Loss or Managed semantic denial allowances", async (t) => {
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
      implementation.skillRestorePrivateAdmission(changed).accepted_exit,
      0,
    );
    assert.equal(trace.strict_trace, "failed");
  }
  const changed = structuredClone(original);
  changed.traces[0].warnings.push("unknown internal warning");
  assert.notEqual(
    implementation.skillRestorePrivateAdmission(changed).accepted_exit,
    0,
  );
});
