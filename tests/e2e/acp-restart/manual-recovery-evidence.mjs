import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertRecoveryEvidence } from "./automatic-recovery-evidence.mjs";

const timestamp = (value) =>
  assert(typeof value === "string" && Number.isFinite(Date.parse(value)));
const present = (value) =>
  assert(typeof value === "string" && value.length > 0);
const inventory = (data, name, count) => {
  assert(Array.isArray(data[name]), `missing ${name} inventory`);
  assert.equal(data[name].length, count, `unexpected ${name} inventory`);
  return data[name][0];
};
export function recoveryResourceID(kind, expected, barrier) {
  const tuple = JSON.stringify([
    expected.organization_id,
    expected.agent_id,
    barrier,
  ]).replace(
    /[<>&\u2028\u2029]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return (
    kind +
    "_" +
    createHash("sha256")
      .update("runtime-barrier-recovery\0" + tuple)
      .digest("hex")
      .slice(0, 32)
  );
}
function validateExpected(expected) {
  for (const field of ["organization_id", "agent_id", "actor_principal_id"])
    present(expected[field]);
  assert.notEqual(expected.actor_principal_id, "agent-controller");
  const { policy, source } = expected;
  assert(["manual", "notify"].includes(policy.mode));
  assert.equal(policy.organization_id, expected.organization_id);
  assert(Number.isSafeInteger(policy.revision) && policy.revision > 0);
  assert(
    Number.isSafeInteger(policy.cooldown_ms) &&
      policy.cooldown_ms >= 60000 &&
      policy.cooldown_ms <= 86400000,
  );
  for (const field of [
    "runtime_revision",
    "runtime_execution_id",
    "template_id",
    "execution_revision",
  ])
    present(source[field]);
  assert(
    Number.isSafeInteger(source.template_revision) &&
      source.template_revision > 0,
  );
}
function originalCycle(data, expected) {
  const cycle = inventory(data, "cycles", 1);
  for (const field of ["organization_id", "agent_id"])
    assert.equal(cycle[field], expected[field]);
  assert.equal(cycle.runtime_revision, expected.source.runtime_revision);
  assert.equal(
    cycle.runtime_execution_hex,
    Buffer.from(expected.source.runtime_execution_id, "utf8").toString("hex"),
  );
  assert.match(cycle.barrier_hex ?? "", /^(?:[0-9a-f]{2}){1,800}$/u);
  new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(cycle.barrier_hex, "hex"),
  );
  timestamp(cycle.created_at);
  return cycle;
}
function notifications(data, expected, cycle) {
  const notice = inventory(
    data,
    "notifications",
    expected.policy.mode === "notify" ? 1 : 0,
  );
  if (!notice) return;
  const barrier = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(cycle.barrier_hex, "hex"),
  );
  for (const [field, value] of Object.entries({
    organization_id: expected.organization_id,
    agent_id: expected.agent_id,
    barrier_hex: cycle.barrier_hex,
    runtime_revision: expected.source.runtime_revision,
    policy_revision: expected.policy.revision,
    event_id: recoveryResourceID("notification", expected, barrier),
    journal_agent_id: expected.agent_id,
    event_type: "agent_runtime_barrier_required",
    schema_version: 1,
    operation_request_id: "",
  }))
    assert.equal(notice[field], value, `invalid notification ${field}`);
  assert.deepEqual(notice.data, {
    organization_id: expected.organization_id,
    runtime_revision: expected.source.runtime_revision,
    reason: "runtime_barrier_required",
    policy_revision: expected.policy.revision,
  });
  timestamp(notice.occurred_at);
}

// A persisted observation proves the worker has evaluated this exact policy
// and binding. A short sleep with zero operations is not equivalent evidence.
export function assertPendingRecoveryEvidence(data, expected) {
  validateExpected(expected);
  const cycle = originalCycle(data, expected);
  assert.equal(cycle.retired_at, null);
  for (const name of ["receipts", "rebuilds", "starts"])
    inventory(data, name, 0);
  const observation = inventory(data, "observations", 1);
  for (const [field, value] of Object.entries({
    organization_id: expected.organization_id,
    agent_id: expected.agent_id,
    barrier_hex: cycle.barrier_hex,
    runtime_execution_hex: cycle.runtime_execution_hex,
    runtime_revision: cycle.runtime_revision,
    policy_revision: expected.policy.revision,
    policy_mode: expected.policy.mode,
    policy_cooldown_ms: expected.policy.cooldown_ms,
  }))
    assert.equal(observation[field], value, `invalid observation ${field}`);
  assert(
    Number.isSafeInteger(observation.observation_revision) &&
      observation.observation_revision > 0,
  );
  timestamp(observation.observed_at);
  notifications(data, expected, cycle);
  return cycle;
}

export function assertManualRecoveryEvidence(data, expected) {
  validateExpected(expected);
  const receipt = assertRecoveryEvidence(data, expected, {
    mode: expected.policy.mode,
    actor: expected.actor_principal_id,
  });
  assert.equal(receipt.manual, true);
  const start = inventory(data, "starts", 1);
  assert.deepEqual(start, {
    request_id: receipt.request_id,
    started_at: receipt.started_at,
  });
  notifications(data, expected, originalCycle(data, expected));
  return receipt;
}
