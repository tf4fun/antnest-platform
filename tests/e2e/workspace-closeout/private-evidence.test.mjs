import assert from "node:assert/strict";
import test from "node:test";
import { workspacePrivateEvidenceFixture } from "./private-evidence.fixture.mjs";
const implementation = await import("./private-evidence.mjs").catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes("/workspace-closeout/private-evidence.mjs")
  )
    throw error;
  return {};
});
function admit(result) {
  assert.equal(typeof implementation.workspacePrivateAdmission, "function");
  return implementation.workspacePrivateAdmission(result);
}
test("Workspace admission accepts original diagnostic identities regardless of export order", async () => {
  const result = await workspacePrivateEvidenceFixture();
  result.authority_traces.at(-1).raw_error_inventory.reverse();
  assert.equal(admit(result).accepted_exit, 0);
});
test("Workspace admission binds the complete original protocol inventory, private evidence and physical recovery", async () => {
  const result = await workspacePrivateEvidenceFixture(),
    before = structuredClone(result);
  const admission = admit(result);
  assert.equal(admission.accepted_exit, 0);
  assert.equal(admission.strict_exit, 2);
  for (const [key, value] of Object.entries({
    connections: 5,
    initializations: 5,
    business_requests: 12,
    original_business_requests: 11,
    revocation_probes: 1,
    sessions: 2,
    login_sessions: 1,
    runs: 3,
    provider_requests: 5,
    runtime_tool_calls: 3,
    notifications: 1,
    deliberate_disconnects: 2,
    private_state_watches: 2,
    lifecycle_admissions: 4,
    offboarding_operations: 1,
  }))
    assert.equal(admission.inventory[key], value, key);
  assert.deepEqual(result, before);
});
for (const [name, mutate] of [
  ["missing request trace", (r) => r.request_traces.pop()],
  [
    "extra initialized connection",
    (r) =>
      r.private_connections.push(structuredClone(r.private_connections[0])),
  ],
  ["unjoined connection", (r) => (r.private_connections[0].closed = false)],
  [
    "duplicate raw request",
    (r) =>
      r.private_connections[0].evidence.push(
        structuredClone(r.private_connections[0].evidence[0]),
      ),
  ],
  [
    "foreign request binding",
    (r) =>
      (r.request_traces[0].connection_trace_id =
        r.private_connections[1].connectionTraceID),
  ],
  ["unrecorded wire request", (r) => r.private_connections[0].requests.pop()],
  [
    "extra reply on disconnected Prompt",
    (r) =>
      r.private_connections[0].raw_frames.push({
        id: r.private_connections[0].evidence.at(-1).requestId,
        result: { stopReason: "end_turn" },
      }),
  ],
  [
    "missing denial probe",
    (r) => delete r.private_workspace.observations.at(-1).probe,
  ],
  [
    "replaced login",
    (r) =>
      r.private_workspace.logins.push(
        structuredClone(r.private_workspace.logins[0]),
      ),
  ],
  [
    "wrong Runtime status",
    (r) => (r.private_workspace.bindings[0].status.execution_id = "foreign"),
  ],
  [
    "wrong Runtime generation",
    (r) => r.private_workspace.bindings[0].status.generation++,
  ],
  [
    "cancelled process still alive",
    (r) =>
      (r.private_workspace.business.cancel.process_after =
        r.private_workspace.business.cancel.process_before),
  ],
  [
    "cancelled workspace effect repeated",
    (r) =>
      (r.private_workspace.business.cancel.recovered_effects += "started\n"),
  ],
  [
    "unknown Run rewritten by recovery",
    (r) =>
      (r.private_workspace.business.cancel.recovery_audit.run.state =
        "completed"),
  ],
  [
    "replay invoked another model",
    (r) =>
      r.private_workspace.business.offline.model_after.push({
        phase: "extra",
        stage: "tool",
      }),
  ],
  [
    "rebuild retained its old container",
    (r) =>
      (r.private_workspace.business.offline.after.container.Id =
        r.private_workspace.business.offline.before.container.Id),
  ],
  [
    "wrong Run execution revision",
    (r) =>
      (r.private_workspace.observations.find(
        (row) => row.phase === "c4-rebuilt",
      ).run.execution_snapshot.executionRevision = "foreign"),
  ],
  [
    "extra Provider",
    (r) =>
      r.private_workspace.final_model.requests.push(
        structuredClone(r.private_workspace.final_model.requests[0]),
      ),
  ],
  [
    "wrong Provider Trace",
    (r) =>
      (r.private_workspace.final_model.requests[0].trace_id = "f".repeat(32)),
  ],
  [
    "revocation added an audit",
    (r) =>
      r.private_workspace.business.revocation.audit_after.items.push({
        run_id: "new",
      }),
  ],
  [
    "Delete retained a resource",
    (r) => r.private_workspace.business.deleted.resources.volumes.push("left"),
  ],
  ["missing state trace", (r) => r.state_traces.pop()],
  [
    "local close substituted for revocation",
    (r) => (r.private_state_watches[1].closure.kind = "local-close"),
  ],
  [
    "wrong state authority",
    (r) =>
      (r.private_state_receipts[0].authority_scope =
        r.private_connections[0].authority_scope),
  ],
  [
    "extra Resolve",
    (r) =>
      r.private_authority_receipts[0].receipts.push(
        structuredClone(r.private_authority_receipts[0].receipts[0]),
      ),
  ],
  [
    "wrong Identity report scope",
    (r) => r.authority_traces[0].authority_scope.operation_id++,
  ],
  ["missing actual denied Resolve", (r) => r.private_authority_receipts.pop()],
  [
    "invented notification request ID",
    (r) => (r.private_notifications[0].requestId = "invented"),
  ],
  [
    "missing notification diagnostic inventory",
    (r) => delete r.notification_traces[0].diagnostic_inventory_verified,
  ],
  [
    "wrong cancellation Session",
    (r) => (r.private_notifications[0].sessionId = "foreign"),
  ],
  [
    "copied disconnect from another request",
    (r) =>
      (r.private_disconnects[1] = structuredClone(r.private_disconnects[0])),
  ],
  [
    "missing disconnect proof",
    (r) =>
      (r.request_traces.find(
        (row) => row.disconnect_verified,
      ).disconnect_verified = false),
  ],
  ["missing lifecycle", (r) => r.traces.pop()],
  [
    "automatic Disable substituted for Rebuild",
    (r) => (r.private_workspace.lifecycle_admissions[1].kind = "disable"),
  ],
  [
    "wrong Rebuild settlement",
    (r) =>
      (r.private_workspace.lifecycle_admissions[1].settlementOutcome =
        "not_settled"),
  ],
  [
    "wrong offboarding source",
    (r) => (r.offboarding_traces[0].source_trace_id = "f".repeat(32)),
  ],
  [
    "wrong offboarding settlement",
    (r) =>
      (r.offboarding_traces[0].settlement_outcome = "runtime_barrier_required"),
  ],
  [
    "wrong original owner event",
    (r) =>
      (r.private_workspace.offboarding[0].ownerRevocation.event.event_id =
        "foreign"),
  ],
  [
    "foreign revoked owner",
    (r) =>
      (r.private_workspace.offboarding[0].ownerRevocation.ownerUserID =
        "foreign"),
  ],
  [
    "foreign revocation request",
    (r) =>
      (r.private_workspace.business.revocation.request.path =
        "/api/admin/directory/users/foreign/active"),
  ],
  [
    "activation substituted for revocation",
    (r) => (r.private_workspace.business.revocation.request.body.active = true),
  ],
  [
    "failed original revocation HTTP",
    (r) => (r.private_workspace.business.revocation.response.status = 500),
  ],
  ["cleanup incomplete", (r) => (r.private_cleanup_completed = false)],
  [
    "original collection failure",
    (r) => r.private_collection_errors.push("original"),
  ],
  [
    "missing source receipt",
    (r) => delete r.request_traces[0].complete_source_receipt,
  ],
  [
    "only two stable samples",
    (r) => (r.request_traces[0].complete_source_receipt.stable_samples = 2),
  ],
  [
    "different final snapshot",
    (r) =>
      (r.request_traces[0].complete_source_receipt.samples[2].snapshot_sha256 =
        "f".repeat(64)),
  ],
  [
    "lost original connection source",
    (r) =>
      (r.request_traces[0].complete_source_receipt.source_trace_ids = [
        r.request_traces[0].trace_id,
      ]),
  ],
  ...["request_traces", "state_traces"].map((group) => [
    `unreviewed source appended to ${group}`,
    (r) => {
      const receipt = r[group][0].complete_source_receipt;
      receipt.source_trace_ids.push("e".repeat(32));
      for (const sample of receipt.samples)
        sample.source_trace_ids.push("e".repeat(32));
    },
  ]),
  ...[
    ["notification_traces", 0],
    ["state_traces", 0],
    ["watch_traces", 1],
    ["authority_traces", 0],
  ].map(([group, index]) => [
    `Identity denial borrowed by ${group}/${index}`,
    (r) => {
      const report = r[group][index];
      const identity = { trace_id: report.trace_id, span_id: "d".repeat(16) };
      report.raw_error_inventory.push(identity);
      report.owned_error_spans.push({
        ...identity,
        reason: "workspace-identity-denied-server",
      });
      report.error_spans++;
      report.strict_trace = "failed";
    },
  ]),
  [
    "watch closure assigned to another SERVER",
    (r) => {
      r.watch_traces[0].raw_error_inventory[0].span_id = "d".repeat(16);
      r.watch_traces[0].owned_error_spans[0].span_id = "d".repeat(16);
    },
  ],
  [
    "Identity denial borrowed a watch reason",
    (r) => {
      r.authority_traces.at(-1).owned_error_spans[0].reason =
        "workspace-private-watch-local-close";
    },
  ],
  [
    "unknown raw error",
    (r) => {
      const report = r.request_traces[0];
      report.raw_error_inventory.push({
        trace_id: report.trace_id,
        span_id: "a".repeat(16),
      });
      report.error_spans++;
      report.strict_trace = "failed";
    },
  ],
])
  test(`Workspace admission rejects ${name}`, async () => {
    const result = await workspacePrivateEvidenceFixture();
    mutate(result);
    let rejected = false;
    try {
      rejected = admit(result).accepted_exit !== 0;
    } catch {
      rejected = true;
    }
    assert(rejected, name);
  });
