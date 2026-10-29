import assert from "node:assert/strict";

const id = (value) =>
  assert(
    typeof value === "string" &&
      value.length <= 200 &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value),
    "invalid proof identity",
  );
const revision = (value) =>
  assert(Number.isSafeInteger(value) && value > 0, "invalid proof revision");
const bindingKeys = [
  "organization_id",
  "agent_spec_revision_id",
  "execution_revision_id",
  "runtime_revision",
  "ready_after_revision",
];

export function readinessProof(
  events,
  { agentId, operationId, organizationId },
) {
  [agentId, operationId, organizationId].forEach(id);
  const one = (type) => {
    const matches = events.filter((event) => event.event_type === type);
    assert.equal(matches.length, 1, `one ${type} required`);
    const [event] = matches;
    assert.equal(event.schema_version, 2);
    assert.equal(event.agent_id, agentId);
    if (type === "runtime_bound" || event.operation_request_id !== undefined)
      assert.equal(event.operation_request_id, operationId);
    id(event.event_id);
    revision(event.global_sequence);
    revision(event.aggregate_sequence);
    const keys = [
      ...bindingKeys,
      ...(type === "agent_ready" ? ["applied_revision"] : []),
    ];
    assert.deepEqual(Object.keys(event.data).sort(), keys.sort());
    for (const key of bindingKeys.slice(0, 4)) id(event.data[key]);
    assert.equal(event.data.organization_id, organizationId);
    revision(event.data.ready_after_revision);
    return event;
  };
  const bound = one("runtime_bound"),
    ready = one("agent_ready");
  for (const key of bindingKeys)
    assert.equal(ready.data[key], bound.data[key], `ready changed ${key}`);
  revision(ready.data.applied_revision);
  assert(ready.data.applied_revision >= bound.data.ready_after_revision);
  assert(ready.global_sequence > bound.global_sequence);
  assert(ready.aggregate_sequence > bound.aggregate_sequence);
  assert.notEqual(ready.event_id, bound.event_id);
  return { bound, ready };
}

export function publicationProof(
  attempt,
  { bound, ready },
  { agentId, organizationId },
) {
  const delta = attempt.path === "/rpc/agent-acp/apply-execution-delta";
  assert(
    delta || attempt.path === "/rpc/agent-acp/apply-execution-snapshot",
    "unexpected publication path",
  );
  if (delta) {
    assert.equal(attempt.schemaVersion, 2);
    assert(
      Number.isSafeInteger(attempt.baseRevision) && attempt.baseRevision >= 1,
      "delta requires a safe base revision",
    );
    assert(attempt.baseRevision < attempt.revision, "delta base must be stale");
  }
  assert.equal(attempt.organizationId, organizationId);
  revision(attempt.revision);
  assert(attempt.revision >= bound.data.ready_after_revision);
  assert.equal(attempt.appliedRevision, ready.data.applied_revision);
  assert(attempt.appliedRevision >= attempt.revision);
  assert.equal(attempt.status, 200);
  assert.equal(attempt.cancelled, false);
  assert(!attempt.error);
  assert.match(attempt.requestSha256, /^[a-f0-9]{64}$/);
  let prior = -Infinity;
  for (const field of [
    "receivedAt",
    "delayStartedAt",
    "forwardedAt",
    "upstreamCompletedAt",
    "completedAt",
  ]) {
    assert(
      Number.isFinite(attempt[field]) && attempt[field] >= prior,
      `unjoined or unordered ${field}`,
    );
    prior = attempt[field];
  }
  assert(
    attempt.forwardedAt - attempt.delayStartedAt >= 2000,
    "publication did not actually wait 2 seconds before forwarding",
  );
  const bindings = attempt.bindings.filter(
    (binding) => binding.agent_id === agentId,
  );
  assert.equal(bindings.length, 1);
  const [binding] = bindings;
  assert.equal(binding.accepting_runs, true);
  assert.equal(binding.agent_spec_revision, bound.data.agent_spec_revision_id);
  assert.equal(binding.execution_revision, bound.data.execution_revision_id);
  assert.equal(binding.runtime_revision, bound.data.runtime_revision);
}
