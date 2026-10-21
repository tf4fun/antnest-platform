import assert from "node:assert/strict";
import {
  inspectLoadMeasurement,
  inspectLoadWire,
} from "../e2e/edge-gateway/resolve-cache-load.mjs";
import {
  inspectOwnerDrain,
  inspectLoadOwnerRestoration,
} from "../e2e/edge-gateway/resolve-cache-owner-drain.mjs";

const loadSchema = "resolve-cache-load-business/v1";

// This receipt proves HTTP capacity and the actual owning container lifecycle.
// Resolve RPC counts, refreshes and SDK cleanup require separate diagnostics.
export function createLoadBusinessReceipt({
  wire,
  ownerLifecycle,
  ownerScope,
}) {
  inspectLoadWire(wire, { requireTrace: false });
  const measurement = structuredClone(wire);
  for (const row of measurement.requests) delete row.body;
  return assertLoadBusinessReceipt({
    schema: loadSchema,
    status: "passed",
    owner_scope: structuredClone(ownerScope),
    exchanges: wire.requests.length,
    elapsed_ms: wire.completed_at - wire.started_at,
    measurement,
    owner_lifecycle: structuredClone(ownerLifecycle),
  });
}

export function assertLoadBusinessReceipt(receipt) {
  assert.equal(receipt?.schema, loadSchema);
  assert.equal(receipt.status, "passed");
  const { measurement, owner_lifecycle: owner, owner_scope: scope } = receipt;
  inspectLoadMeasurement(measurement, { requireTrace: false });
  for (const row of measurement.requests)
    assert(
      !Object.hasOwn(row, "body"),
      "private response body in public receipt",
    );
  assert.equal(receipt.exchanges, 100);
  assert.equal(
    receipt.elapsed_ms,
    measurement.completed_at - measurement.started_at,
  );
  for (const field of ["organization_id", "user_id", "agent_id"])
    assert(
      typeof scope?.[field] === "string" && scope[field].length > 0,
      `load owner ${field} missing`,
    );
  assert.equal(scope.agent_id, measurement.agent_id);
  assert.equal(owner?.agent_id, measurement.agent_id);
  inspectOwnerDrain(owner);
  inspectLoadOwnerRestoration(owner);
  assert.equal(owner.restored, true);
  assert.deepEqual(owner.failures, []);
  assert(
    measurement.completed_at <= owner.requested_at,
    "drain overlaps the measured load",
  );
  for (const state of Object.values(owner.baseline))
    assert(
      state.at <= measurement.started_at,
      "participant baseline followed load dispatch",
    );
  return receipt;
}
