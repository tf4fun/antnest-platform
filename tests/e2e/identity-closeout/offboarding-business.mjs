import assert from "node:assert/strict";
import { assertDisabled } from "./offboarding-evidence.mjs";

// Original public and owning-service receipts establish the completed Disable.
// No Span, source Trace, or summary flag substitutes for these responses.
export function inspectOffboardingBusiness(original) {
  const {
    agentID,
    organizationID,
    ownerUserID,
    reason,
    agent,
    runtime,
    before,
    events,
    privateEvents,
    operation,
  } = original;
  assertDisabled(agent, runtime, agentID);
  assert(Array.isArray(before) && Array.isArray(events));
  assert.equal(new Set(events.map((row) => row.event_id)).size, events.length);
  assert.deepEqual(
    events.filter((row) => before.some((old) => old.event_id === row.event_id)),
    before,
  );
  const added = events.filter(
    (row) => !before.some((old) => old.event_id === row.event_id),
  );
  const revoked = added.filter(
    (row) => row.event_type === "agent_owner_revoked",
  );
  const disabled = added.filter((row) => row.event_type === "agent_disabled");
  assert.equal(revoked.length, 1);
  assert.equal(disabled.length, 1);
  const causes = privateEvents.events.filter(
    (row) => row.event_id === revoked[0].event_id,
  );
  assert.equal(causes.length, 1);
  const cause = causes[0];
  assert.equal(cause.event_type, "agent_owner_revoked");
  assert.equal(cause.agent_id, agentID);
  assert.equal(cause.data.reason, reason);
  assert.equal(
    cause.data.organization_id,
    reason === "user_deactivated" ? "" : organizationID,
  );
  if (ownerUserID !== undefined)
    assert.equal(cause.data.owner_user_id, ownerUserID);
  assert(
    typeof cause.data.owner_user_id === "string" && cause.data.owner_user_id,
  );
  const sequence = cause.data.identity_revocation_sequence;
  assert(Number.isSafeInteger(sequence) && sequence > 0);
  assert.equal(operation.kind, "disable");
  assert.equal(operation.agent_id, agentID);
  assert.equal(operation.request_id, disabled[0].operation_request_id);
  assert.equal(operation.state, "completed");
  return {
    business: "passed",
    agent_id: agentID,
    request_id: operation.request_id,
    owner_revocation_sequence: sequence,
  };
}
