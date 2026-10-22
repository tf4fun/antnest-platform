import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const present = (value) => {
  assert(typeof value === "string" && value.length > 0);
  return value;
};
const timestamp = (value) => {
  present(value);
  assert(Number.isFinite(Date.parse(value)), "missing persisted timestamp");
};
const opaque = (hex) => {
  assert.match(hex ?? "", /^(?:[0-9a-f]{2}){1,800}$/u);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(hex, "hex"),
  );
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
// The Controller's existing immutable command and tuple use Go encoding/json.
const goJSON = (value) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

// These are raw database inventories, including retired ACP cycles and every
// Rebuild for this disposable Agent. Filtering by the expected request/barrier
// before admission could hide duplicate or manually initiated recovery.
export function assertAutomaticRecoveryEvidence(data, expected) {
  for (const collection of ["cycles", "receipts", "rebuilds"]) {
    assert(Array.isArray(data[collection]), `missing ${collection} inventory`);
    assert.equal(data[collection].length, 1, `expected one ${collection} row`);
  }
  const cycle = data.cycles[0],
    receipt = data.receipts[0];
  const source = expected.source,
    policy = expected.policy;
  for (const key of ["organization_id", "agent_id"]) present(expected[key]);
  for (const key of [
    "runtime_revision",
    "runtime_execution_id",
    "template_id",
    "execution_revision",
  ])
    present(source[key]);
  assert(
    Number.isSafeInteger(source.template_revision) &&
      source.template_revision > 0,
  );
  assert.equal(policy.organization_id, expected.organization_id);
  assert.equal(policy.mode, "auto");
  assert(Number.isSafeInteger(policy.revision) && policy.revision > 0);
  assert(
    Number.isSafeInteger(policy.cooldown_ms) &&
      policy.cooldown_ms >= 60000 &&
      policy.cooldown_ms <= 86400000,
  );
  for (const row of [cycle, receipt]) {
    for (const key of ["organization_id", "agent_id"])
      assert.equal(row[key], expected[key]);
    assert.equal(row.runtime_revision, source.runtime_revision);
    assert.equal(
      row.runtime_execution_hex,
      Buffer.from(source.runtime_execution_id, "utf8").toString("hex"),
    );
    opaque(row.runtime_execution_hex);
  }
  const barrier = opaque(cycle.barrier_hex);
  assert.equal(receipt.barrier_hex, cycle.barrier_hex);
  for (const key of ["created_at", "retired_at"]) timestamp(cycle[key]);
  assert(Date.parse(cycle.retired_at) >= Date.parse(cycle.created_at));
  const requestID =
    "rebuild_" +
    digest(
      "runtime-barrier-recovery\0" +
        goJSON([expected.organization_id, expected.agent_id, barrier]),
    ).slice(0, 32);
  assert.equal(receipt.request_id, requestID);
  assert.equal(data.rebuilds[0].request_id, requestID);
  const fingerprint = digest(
    goJSON({
      RequestID: requestID,
      OrganizationID: expected.organization_id,
      ActorPrincipalID: "agent-controller",
      AgentID: expected.agent_id,
      TemplateID: source.template_id,
      TemplateRevision: source.template_revision,
    }),
  );
  for (const [key, value] of Object.entries({
    reason: "runtime_barrier_required",
    actor_principal_id: "agent-controller",
    template_id: source.template_id,
    template_revision: source.template_revision,
    source_template_id: source.template_id,
    source_template_revision: source.template_revision,
    target_template_id: source.template_id,
    target_template_revision: source.template_revision,
    source_execution_revision_id: source.execution_revision,
    source_runtime_revision: source.runtime_revision,
    policy_revision: policy.revision,
    policy_mode: "auto",
    policy_cooldown_ms: policy.cooldown_ms,
    kind: "rebuild",
    state: "completed",
    phase: "completed",
    request_fingerprint: fingerprint,
    operation_fingerprint: fingerprint,
    cooldown_request_id: requestID,
    cooldown_exact: true,
    requested_events: 1,
    requested_reason: "runtime_barrier_required",
  }))
    assert.equal(receipt[key], value, `invalid automatic recovery ${key}`);
  for (const key of ["source_spec_revision_id", "target_spec_revision_id"])
    present(receipt[key]);
  for (const key of ["accepted_at", "cooldown_until", "started_at"])
    timestamp(receipt[key]);
  // Preserve exact PostgreSQL precision for equality; JS millisecond parsing is
  // only a basic timestamp check. Arithmetic is independently proved by SQL.
  for (const key of [
    "operation_created_at",
    "cooldown_accepted_at",
    "requested_at",
  ])
    assert.equal(receipt[key], receipt.accepted_at, `changed ${key}`);
  assert.equal(receipt.saved_cooldown_until, receipt.cooldown_until);
  assert(Date.parse(receipt.cooldown_until) > Date.parse(receipt.accepted_at));
  return receipt;
}
