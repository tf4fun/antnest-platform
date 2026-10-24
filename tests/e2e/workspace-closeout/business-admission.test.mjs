import assert from "node:assert/strict";
import test from "node:test";
import { workspacePrivateEvidenceFixture } from "./private-evidence.fixture.mjs";
import * as implementation from "./private-evidence.mjs";

const diagnosticFields = new Set([
  "trace_id",
  "model_span_id",
  "response_trace_id",
]);
function removeDiagnostics(value) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (diagnosticFields.has(key)) delete value[key];
    else removeDiagnostics(value[key]);
  }
}
async function fixture() {
  const result = await workspacePrivateEvidenceFixture();
  for (const field of [
    "request_traces",
    "watch_traces",
    "state_traces",
    "notification_traces",
    "authority_traces",
    "offboarding_traces",
    "traces",
  ])
    delete result[field];
  result.private_collection_errors = [{ error: "original collector failed" }];
  result.private_resource_cleanup = {
    version: 1,
    status: "joined",
    connections: 5,
    watches: 2,
    state_receipts: result.private_state_receipts.length,
    authority_receipts: result.private_authority_receipts.length,
  };
  removeDiagnostics(result);
  return result;
}
function admit(result) {
  assert.equal(typeof implementation.inspectWorkspaceBusiness, "function");
  return implementation.inspectWorkspaceBusiness(result);
}
const revocationProbe = (result) =>
  result.private_workspace.business.revocation.closed_connection_probe;
test("Workspace business admits full protocol and resource proof without any collected Trace", async () => {
  const result = await fixture(),
    original = structuredClone(result);
  const admitted = admit(result);
  assert.equal(admitted.status, "business_passed");
  for (const [key, count] of Object.entries({
    connections: 5,
    initializations: 5,
    business_requests: 11,
    wire_requests: 16,
    revocation_probes: 1,
    revocation_probe_wire_requests: 0,
    sessions: 2,
    runs: 3,
    provider_requests: 5,
    notifications: 1,
    deliberate_disconnects: 2,
    private_state_watches: 2,
    lifecycle_admissions: 4,
    offboarding_operations: 1,
  }))
    assert.equal(admitted.inventory[key], count, key);
  assert.equal(
    admitted.inventory.runtime_tool_calls,
    undefined,
    "Trace-derived Tool count must not become business proof",
  );
  assert.deepEqual(result, original);
});
for (const [name, mutate] of [
  [
    "missing resource completion receipt",
    (r) => delete r.private_resource_cleanup,
  ],
  [
    "unjoined resources",
    (r) => (r.private_resource_cleanup.status = "pending"),
  ],
  [
    "resource inventory mismatch",
    (r) => (r.private_resource_cleanup.connections = 4),
  ],
  [
    "state completion inventory mismatch",
    (r) => (r.private_resource_cleanup.state_receipts += 1),
  ],
  [
    "authority completion inventory mismatch",
    (r) => (r.private_resource_cleanup.authority_receipts += 1),
  ],
  [
    "unjoined actual connection",
    (r) => (r.private_connections[0].closed = false),
  ],
  [
    "extra connection",
    (r) =>
      r.private_connections.push(structuredClone(r.private_connections[0])),
  ],
  ["unrecorded request", (r) => r.private_connections[0].requests.pop()],
  [
    "missing no-wire revocation receipt",
    (r) =>
      delete r.private_workspace.business.revocation.closed_connection_probe,
  ],
  [
    "local cleanup substituted for remote old-connection closure",
    (r) => (revocationProbe(r).close.localClose = true),
  ],
  [
    "old-connection closure predates revocation",
    (r) => {
      const probe = revocationProbe(r);
      probe.close.at = probe.started_at - 1;
    },
  ],
  [
    "old-connection closure exceeds its bound",
    (r) => {
      const probe = revocationProbe(r);
      probe.close.at = probe.deadline_at + 1;
    },
  ],
  [
    "old-connection cleanup is unfinished",
    (r) => (revocationProbe(r).cleanup_joined = false),
  ],
  [
    "post-close probe emitted a request",
    (r) => revocationProbe(r).request_count_after++,
  ],
  [
    "post-close probe emitted a raw frame",
    (r) => revocationProbe(r).raw_frame_count_after++,
  ],
  [
    "post-close probe has a wire receipt",
    (r) => (revocationProbe(r).requestId = "invented"),
  ],
  [
    "replaced login",
    (r) =>
      r.private_workspace.logins.push(
        structuredClone(r.private_workspace.logins[0]),
      ),
  ],
  [
    "cancelled process survived",
    (r) =>
      (r.private_workspace.business.cancel.process_after =
        r.private_workspace.business.cancel.process_before),
  ],
  [
    "workspace effect repeated",
    (r) =>
      (r.private_workspace.business.cancel.recovered_effects += "started\n"),
  ],
  [
    "unknown Run rewritten",
    (r) =>
      (r.private_workspace.business.cancel.recovery_audit.run.state =
        "completed"),
  ],
  [
    "extra model after replay",
    (r) =>
      r.private_workspace.business.offline.model_after.push({
        phase: "extra",
        stage: "tool",
      }),
  ],
  [
    "old Runtime after Rebuild",
    (r) =>
      (r.private_workspace.business.offline.after.container.Id =
        r.private_workspace.business.offline.before.container.Id),
  ],
  [
    "invalid Runtime status",
    (r) => (r.private_workspace.bindings[0].status.execution_id = "foreign"),
  ],
  [
    "extra Provider",
    (r) =>
      r.private_workspace.final_model.requests.push(
        structuredClone(r.private_workspace.final_model.requests[0]),
      ),
  ],
  [
    "model error",
    (r) => r.private_workspace.final_model.errors.push("failure"),
  ],
  [
    "model receive time missing",
    (r) => delete r.private_workspace.final_model.requests[0].received_at_ms,
  ],
  [
    "deleted resource remains",
    (r) => r.private_workspace.business.deleted.resources.volumes.push("left"),
  ],
  [
    "extra Run after revocation",
    (r) =>
      r.private_workspace.business.revocation.audit_after.items.push({
        run_id: "new",
      }),
  ],
  [
    "local watch substituted for revocation",
    (r) => (r.private_state_watches[1].closure.kind = "local-close"),
  ],
  [
    "unfinished state receipt",
    (r) => (r.private_state_receipts[0].joined = false),
  ],
  [
    "wrong state authority",
    (r) =>
      (r.private_state_receipts[0].authority_scope =
        r.private_connections[0].authority_scope),
  ],
  ["missing denied Resolve", (r) => r.private_authority_receipts.pop()],
  [
    "fresh same-scope connection was authorized",
    (r) => (r.private_authority_receipts.at(-1).receipts[0].status = 200),
  ],
  [
    "wrong cancellation Session",
    (r) => (r.private_notifications[0].sessionId = "foreign"),
  ],
  [
    "copied disconnect",
    (r) =>
      (r.private_disconnects[1] = structuredClone(r.private_disconnects[0])),
  ],
  [
    "automatic Disable instead of Rebuild",
    (r) => (r.private_workspace.lifecycle_admissions[1].kind = "disable"),
  ],
  [
    "wrong Rebuild settlement",
    (r) =>
      (r.private_workspace.lifecycle_admissions[1].settlementOutcome =
        "not_settled"),
  ],
  [
    "unfinished lifecycle",
    (r) =>
      (r.private_workspace.lifecycle_admissions[1].terminal.state = "pending"),
  ],
])
  test(`Workspace business independently rejects ${name}`, async () => {
    const result = await fixture();
    admit(result);
    mutate(result);
    assert.throws(() => admit(result));
  });
