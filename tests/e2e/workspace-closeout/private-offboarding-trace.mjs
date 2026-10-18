import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";

function publicEvent(event, type, expected) {
  assert(event, "original Workspace public event required");
  assert(typeof event.event_id === "string" && event.event_id.length > 0);
  assert.equal(event.event_type, type);
  assert.equal(event.agent_id, expected.agentID);
  assert.equal(event.trace_id, expected.sourceID);
  assert.equal(event.schema_version, 1);
  assert.equal(
    event.data,
    undefined,
    "public event cannot invent a private payload",
  );
  for (const field of ["global_sequence", "aggregate_sequence"])
    assert(Number.isSafeInteger(event[field]) && event[field] > 0);
  assert(Number.isFinite(Date.parse(event.occurred_at)));
}

export function inspectWorkspaceOffboardingTrace(
  traces,
  expected,
  secrets = [],
) {
  assert.equal(expected.settlementOutcome, "settled");
  assert.equal(expected.traceID, expected.sourceID);
  const sources = traces.filter((trace) => trace.traceID === expected.sourceID);
  assert.equal(
    sources.length,
    1,
    "original Workspace revocation source required",
  );
  const owner = expected.ownerRevocation;
  assert(owner, "original Workspace owner event required");
  assert.equal(owner.reason, "user_deactivated");
  assert.equal(owner.organizationID, "");
  assert(typeof owner.ownerUserID === "string" && owner.ownerUserID.length > 0);
  const event = owner.event;
  publicEvent(event, "agent_owner_revoked", expected);
  const tree = traceTopology(sources[0]);
  const schedules = sources[0].spans.filter(
    (span) =>
      tree.service(span) === "agent-controller" &&
      span.operationName === "agent_controller.identity_offboarding.disable" &&
      tag(span, "agent.id") === expected.agentID,
  );
  assert.equal(schedules.length, 1);
  const schedule = schedules[0],
    sequence = tag(schedule, "identity.revocation.sequence"),
    identity = tree.parent(schedule);
  assert(Number.isSafeInteger(sequence) && sequence > 0);
  assert.equal(tree.service(identity), "identity-service");
  for (const [field, value] of Object.entries({
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/rpc/identity/set-user-active",
    "http.response.status_code": 200,
    "rpc.method": "set_user_active",
    "antnest.outcome": "success",
  }))
    assert.equal(
      tag(identity, field),
      value,
      "Workspace revocation source differs",
    );
  const receipts = sources[0].spans.filter(
    (span) =>
      tree.service(span) === "agent-controller" &&
      span.operationName === "agent_controller.identity_offboarding.receive" &&
      tree.parent(span) === identity,
  );
  assert.equal(receipts.length, 1);
  assert.equal(tag(receipts[0], "identity.revocation.sequence"), sequence);
  // Controller derives this public ID from the revocation sequence and Agent.
  // Public aggregate/global sequences are event order, not Identity sequence.
  const eventID =
    "event_" +
    createHash("sha256")
      .update(`identity-revocation\0${sequence}\0${expected.agentID}`)
      .digest("hex")
      .slice(0, 32);
  assert.equal(
    event.event_id,
    eventID,
    "owner event belongs to another revocation",
  );
  const disabled = expected.disabledEvent;
  publicEvent(disabled, "agent_disabled", expected);
  assert.notEqual(disabled.event_id, event.event_id);
  for (const field of ["global_sequence", "aggregate_sequence"])
    assert(
      disabled[field] > event[field],
      "Disable must follow its owner event",
    );
  for (const [field, value] of Object.entries({
    event_type: "agent_disabled",
    agent_id: expected.agentID,
    trace_id: expected.sourceID,
    operation_request_id: expected.requestID,
  }))
    assert.equal(
      disabled[field],
      value,
      "Workspace Disable event identity differs",
    );
  const result = inspectLifecycle(
    sources[0],
    {
      kind: "disable",
      offboarding: true,
      traceID: expected.sourceID,
      requestId: expected.requestID,
      agentId: expected.agentID,
      settlementOutcome: expected.settlementOutcome,
    },
    secrets,
  );
  return {
    ...result,
    source_trace_id: expected.sourceID,
    settlement_outcome: expected.settlementOutcome,
    owner_revocation: structuredClone(event),
    revocation_sequence: sequence,
    disabled_event: structuredClone(disabled),
    phases: result.activities.map((activity) => activity.phase),
    gateway_ancestry: true,
  };
}
