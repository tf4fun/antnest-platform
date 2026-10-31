import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Deterministic lifecycle resource identity, mirroring domain/resource_id.go:
// kind + "_" + SHA256(namespace + "\0" + key).hex.slice(0, 32).
export function deriveReliabilityID(kind, namespace, key) {
  const hex = createHash("sha256")
    .update(`${namespace}\x00${key}`)
    .digest("hex")
    .slice(0, 32);
  return `${kind}_${hex}`;
}

export const cancelDeleteRequestID = (createRequestID) =>
  deriveReliabilityID("request", "lifecycle-cancel-delete", createRequestID);

export const gcDeleteRequestID = (createRequestID) =>
  deriveReliabilityID("request", "failed-create-gc-delete", createRequestID);

export const gcScheduledEventID = (createRequestID) =>
  deriveReliabilityID("event", "failed-create-gc", createRequestID);

function requireEventPage(events, agentID) {
  assert(Array.isArray(events), "event page must be an array");
  assert(events.length > 0, "audit evidence is missing");
  assert(events.length < 100, "event page is truncated at the read limit");
  let last = 0;
  let lastGlobal = 0;
  const identities = new Set();
  for (const event of events) {
    assert.equal(
      event.agent_id,
      agentID,
      "event page must contain only this Agent's events",
    );
    assert(
      Number.isSafeInteger(event.aggregate_sequence),
      "event sequence must be a safe integer",
    );
    assert(
      event.aggregate_sequence > last,
      "event sequence must be strictly increasing",
    );
    last = event.aggregate_sequence;
    assert(
      Number.isSafeInteger(event.global_sequence) &&
        event.global_sequence > lastGlobal,
      "global event sequence must be positive and increasing",
    );
    lastGlobal = event.global_sequence;
    assert(
      typeof event.event_id === "string" &&
        event.event_id &&
        !identities.has(event.event_id),
      "event identity must be present and unique",
    );
    identities.add(event.event_id);
    assert(
      typeof event.event_type === "string" && event.event_type,
      "event type is required",
    );
  }
}

function oneEvent(events, type, requestID) {
  const selected = events.filter((event) => event.event_type === type);
  assert.equal(selected.length, 1, `exactly one ${type} event is required`);
  assert.equal(
    selected[0].operation_request_id,
    requestID,
    `${type} request identity`,
  );
  return selected[0];
}

function neverReady(events) {
  for (const type of ["agent_ready", "runtime_bound"]) {
    assert(
      !events.some((event) => event.event_type === type),
      `failed create must not emit ${type}`,
    );
  }
}

function requireOperation(operation, agentID, kind) {
  assert(
    operation && typeof operation === "object",
    "operation record is required",
  );
  assert.equal(
    operation.agent_id,
    agentID,
    "operation must belong to the Agent",
  );
  assert.equal(operation.kind, kind, `operation must be ${kind}`);
  assert(
    typeof operation.request_id === "string" && operation.request_id,
    "operation request ID required",
  );
  return operation;
}

// assertFailedCreateEvidence checks a bounded failed create: it terminated with
// the expected code/phase, emitted no ready or binding history, and keeps no
// active operation or executable binding.
export function assertFailedCreateEvidence(
  { operation, agent, events },
  { agentID, requestID, phase, errorCode },
) {
  const op = requireOperation(operation, agentID, "create");
  assert.equal(op.request_id, requestID, "create request identity");
  assert.equal(op.state, "failed", "create must be durable failed");
  assert.equal(op.phase, phase, "create must fail in the expected phase");
  assert.equal(
    op.error_code,
    errorCode,
    "create must carry the expected failure code",
  );
  assert.equal(agent?.agent_id, agentID, "failed Agent identity");
  assert.equal(agent.failure_stage, phase, "visible Agent failure stage");
  assert.equal(agent.failure_code, errorCode, "visible Agent failure code");
  requireEventPage(events, agentID);
  oneEvent(events, "agent_create_requested", requestID);
  const failed = oneEvent(events, "agent_build_failed", requestID);
  assert.equal(failed.data?.failure_code, errorCode, "failure audit code");
  assert.equal(failed.data?.failure_stage, phase, "failure audit stage");
  neverReady(events);
  assert(
    !agent.active_operation_request_id,
    "failed create must own no active operation",
  );
  assert(
    !agent.executable_execution_revision,
    "failed create must have no executable binding",
  );
}

// assertCancellationEvidence checks a committed cancellation: the original
// operation ended as lifecycle_cancelled, exactly one deterministic child
// delete was requested and completed, and the proxy proof shows the real
// held effect was observed, never a fabricated absence.
export function assertCancellationEvidence(
  { operation, events, proxy },
  { agentID, requestID, childRequestID, runtimeRequestID },
) {
  const op = requireOperation(operation, agentID, "create");
  assert.equal(op.request_id, requestID, "cancelled operation identity");
  assert.equal(
    op.state,
    "failed",
    "committed cancellation ends the operation failed",
  );
  assert.equal(
    op.error_code,
    "lifecycle_cancelled",
    "cancellation code is required",
  );
  requireEventPage(events, agentID);
  assert.equal(
    childRequestID,
    cancelDeleteRequestID(requestID),
    "deterministic cancellation child",
  );
  oneEvent(events, "agent_create_requested", requestID);
  const cancelled = oneEvent(events, "agent_lifecycle_cancelled", requestID);
  assert.equal(
    cancelled.data?.failure_code,
    "lifecycle_cancelled",
    "cancellation audit code",
  );
  oneEvent(events, "agent_delete_requested", childRequestID);
  oneEvent(events, "agent_deleted", childRequestID);
  neverReady(events);
  assert(
    typeof runtimeRequestID === "string" && runtimeRequestID,
    "original Runtime child identity required",
  );
  assert.equal(proxy?.agent_id, agentID, "selected proxy Agent identity");
  assert.equal(
    proxy.request_id,
    runtimeRequestID,
    "selected proxy Runtime request identity",
  );
  const held = proxy.records;
  assert(Array.isArray(held), "proxy receipts are required");
  assert(
    held.length > 0,
    "the proxy must have observed the real held initialize effect",
  );
  for (const record of held) {
    assert.equal(record.agent_id, agentID, "proxy receipt Agent identity");
    assert.equal(
      record.request_id,
      runtimeRequestID,
      "proxy receipt Runtime request identity",
    );
    assert.equal(
      record.status,
      200,
      "only genuine completed initialize receipts count",
    );
    assert(
      typeof record.target_revision === "string" && record.target_revision,
      "physical Runtime target identity",
    );
    assert.equal(
      record.delivery,
      "caller_disconnected",
      "heartbeat cancellation must disconnect the held request",
    );
  }
}

// assertDeleteCleanupEvidence requires a completed normal delete plus real
// physical proof: empty containers AND volumes, and an Egress allocation that
// is closed/quarantined/released — never a bare event claim.
export function assertDeleteCleanupEvidence(
  { operation, events, physical, egress },
  { agentID, requestID },
) {
  const op = requireOperation(operation, agentID, "delete");
  assert.equal(op.request_id, requestID, "delete request identity");
  assert.equal(op.state, "completed", "delete must reach durable completed");
  requireEventPage(events, agentID);
  oneEvent(events, "agent_delete_requested", requestID);
  oneEvent(events, "agent_deleted", requestID);
  assert(
    Array.isArray(physical?.containers) && physical.containers.length === 0,
    "cleanup requires empty containers",
  );
  assert(
    Array.isArray(physical?.volumes) && physical.volumes.length === 0,
    "cleanup requires empty volumes",
  );
  assert(
    egress && typeof egress === "object",
    "authoritative egress state is required",
  );
  assert.equal(egress.keys_absent, true, "all tunnel keys must be gone");
  assert.equal(
    egress.attachment_safe,
    true,
    "no active or endpoint-bearing attachment may survive",
  );
  assert(
    egress.allocation_state === null ||
      egress.allocation_state === "quarantined",
    "allocation must be absent or quarantined, never active",
  );
  if (egress.allocation_state === "quarantined") {
    assert.equal(
      egress.attachment_state,
      "closed",
      "a quarantined allocation requires a closed attachment",
    );
  }
}

// assertGCProtectedAgent proves the ready control Agent survived with the same
// physical identities — GC must never touch a non-eligible Agent.
export function assertGCProtectedAgent(before, after) {
  assert(before && after, "control Agent snapshots are required");
  const identity = (snapshot) => {
    const agent = snapshot.agent;
    const physical = snapshot.physical;
    assert(
      typeof agent?.agent_id === "string" && agent.agent_id,
      "control Agent identity required",
    );
    assert.equal(agent.readiness, "ready", "control Agent must remain ready");
    assert.equal(agent.lifecycle_state, "created");
    assert.equal(agent.desired_state, "enabled");
    assert(
      !agent.active_operation_request_id,
      "control Agent must have no lifecycle mutation",
    );
    assert(
      typeof agent.executable_execution_revision === "string" &&
        agent.executable_execution_revision,
      "control Agent executable identity required",
    );
    assert.equal(
      physical?.containers?.length,
      1,
      "control Agent must retain one real container",
    );
    assert(
      typeof physical.containers[0].Id === "string" &&
        physical.containers[0].Id,
      "Docker inspect Id is required",
    );
    assert(
      Array.isArray(physical.volumes) && physical.volumes.length === 4,
      "all four named Runtime storage identities are required",
    );
    assert(
      physical.volumes.every((name) => typeof name === "string" && name),
      "storage identities required",
    );
    assert.equal(
      new Set(physical.volumes).size,
      4,
      "storage identities must be distinct",
    );
    requireEventPage(snapshot.events, agent.agent_id);
    assert(
      !snapshot.events.some((event) =>
        [
          "agent_gc_scheduled",
          "agent_delete_requested",
          "agent_deleted",
        ].includes(event.event_type),
      ),
      "GC must not admit or delete the ready control Agent",
    );
    return {
      agent: agent.agent_id,
      execution: agent.executable_execution_revision,
      container: physical.containers[0].Id,
      volumes: [...physical.volumes].sort(),
    };
  };
  assert.deepEqual(
    identity(after),
    identity(before),
    "GC changed a ready Agent's physical or executable identities",
  );
}

export function assertGCEvidence(
  { operation, events },
  { agentID, createRequestID },
) {
  const op = requireOperation(operation, agentID, "create");
  assert.equal(op.request_id, createRequestID);
  assert.equal(op.state, "failed");
  assert.equal(op.phase, "runtime_initialize");
  assert.equal(op.error_code, "phase_deadline_exceeded");
  requireEventPage(events, agentID);
  oneEvent(events, "agent_create_requested", createRequestID);
  const failed = oneEvent(events, "agent_build_failed", createRequestID);
  assert.equal(failed.data?.failure_code, "phase_deadline_exceeded");
  assert.equal(failed.data?.failure_stage, "runtime_initialize");
  neverReady(events);
  const deleteID = gcDeleteRequestID(createRequestID);
  const scheduled = oneEvent(events, "agent_gc_scheduled", deleteID);
  assert.equal(scheduled.event_id, gcScheduledEventID(createRequestID));
  assert.equal(scheduled.data?.create_request_id, createRequestID);
  assert.equal(scheduled.data?.delete_request_id, deleteID);
  oneEvent(events, "agent_delete_requested", deleteID);
  oneEvent(events, "agent_deleted", deleteID);
}
