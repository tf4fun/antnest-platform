import assert from "node:assert/strict";
export function assertUnacknowledged(sync, held) {
  assert.equal(sync.revision, held.revision);
  assert(
    sync.applied_revision < held.applied_revision,
    "lost reply was recorded as acknowledged",
  );
}
export function assertReceipts(held, records, { requireTrace = true } = {}) {
  assert.equal(held.delivery, "held");
  assert.equal(held.status, 200);
  assert(records.length >= 2, "missing delivered retry");
  assert.equal(records[0].receipt_id, held.receipt_id);
  assert.deepEqual(
    records.map((r) => r.delivery),
    ["dropped", ...records.slice(1).map(() => "delivered")],
  );
  assert.equal(new Set(records.map((r) => r.receipt_id)).size, records.length);
  if (requireTrace) {
    assert.equal(
      new Set(records.map((r) => r.traceparent)).size,
      records.length,
      "same HTTP attempt counted twice",
    );
  } else {
    for (const record of records)
      assert(
        typeof record.receipt_id === "string" &&
          record.receipt_id.trim().length > 0,
        "original HTTP attempt receipt ID required",
      );
  }
  for (const [index, record] of records.entries()) {
    if (record.method === "get-execution-digest") {
      assert(index > 0);
      assert.equal(held.method, "apply-execution-delta");
      assert.equal(record.organization_id, held.organization_id);
      assert.equal(record.schema_version, 2);
      assert.equal(record.revision, held.applied_revision);
      assert.equal(record.applied_revision, held.applied_revision);
      assert.equal(record.recovery_of, held.receipt_id);
      assert.equal(record.status, 200);
      for (const field of ["digest", "request_hash", "response_hash"])
        assert.match(record[field], /^[a-f0-9]{64}$/u);
      continue;
    }
    for (const key of [
      "method",
      "organization_id",
      "revision",
      "base_revision",
      "minimum_revision",
      "applied_revision",
      "agent_id",
      "operation_id",
      "mode",
      "deadline_at",
      "outcome",
      "request_hash",
      "response_hash",
      "status",
    ])
      assert.equal(record[key], held[key], `changed receipt ${key}`);
  }
  assert.match(held.request_hash, /^[a-f0-9]{64}$/);
  assert.match(held.response_hash, /^[a-f0-9]{64}$/);
  if (held.method === "settle-agent") assert.equal(held.outcome, "settled");
}
