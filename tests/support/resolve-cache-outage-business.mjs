import assert from "node:assert/strict";
import {
  inspectOutageWindow,
  inspectFreshConsumerWindow,
} from "../e2e/edge-gateway/resolve-cache-outage.mjs";
import { inspectRecoveryWindow } from "../e2e/edge-gateway/resolve-cache-recovery.mjs";
import { inspectOutageRejectionBusiness } from "../e2e/edge-gateway/resolve-cache-rejection-business.mjs";
import { inspectRecoveryRebuild } from "../e2e/edge-gateway/resolve-cache-rebuild.mjs";
import { inspectOutageBusinessResources } from "../e2e/edge-gateway/resolve-cache-resource-business.mjs";

const schema = "resolve-cache-outage-business/v1";
// Keep original business observations, excluding collector trees, clock probes,
// precomputed admission flags and unrelated process diagnostics.
const fields = [
  "policy_revision",
  "transport",
  "project",
  "settings",
  "agent_id",
  "session_id",
  "run_id",
  "intent_id",
  "http",
  "identity",
  "session_deadlines",
  "consumer_restarts",
  "consumer_configuration",
  "runtime",
  "stream",
  "prompt",
  "cancel",
  "audit_before",
  "audit",
  "model_started",
  "model_cancelled",
  "model_observations",
  "run_storage",
  "cold_agent",
  "cold_agent_setup",
  "rejections",
  "recovery_preparation",
  "recovery",
  "ui_drain",
  "failure",
  "finalization_errors",
];

function inspect(evidence) {
  assert.equal(evidence?.policy_revision, 4);
  assert.equal(evidence.transport, "http-sse");
  const outage = inspectOutageWindow(evidence, { requireTrace: false });
  const consumers = inspectFreshConsumerWindow(evidence, {
    requireTrace: false,
  });
  const rejections = inspectOutageRejectionBusiness(evidence);
  const preparation = inspectRecoveryRebuild(evidence);
  const recovery = inspectRecoveryWindow(evidence, { requireTrace: false });
  const resources = inspectOutageBusinessResources(evidence);
  return {
    outage,
    consumers,
    rejections,
    rebuild: {
      status: "passed",
      request_id: preparation.operation.body.request_id,
      runtime_revision: preparation.runtime.runtime_revision,
      runtime_execution_id: preparation.runtime.runtime_execution_id,
      generation: preparation.runtime.container.generation,
    },
    recovery,
    resources,
  };
}

export function createOutageBusinessReceipt(evidence) {
  const raw = structuredClone(
    Object.fromEntries(
      fields
        .filter((key) => Object.hasOwn(evidence, key))
        .map((key) => [key, evidence[key]]),
    ),
  );
  return { schema, status: "passed", evidence: raw, checks: inspect(raw) };
}

export function assertOutageBusinessReceipt(receipt) {
  assert.equal(receipt?.schema, schema);
  assert.equal(receipt.status, "passed");
  assert.deepEqual(
    receipt.checks,
    inspect(receipt.evidence),
    "outage checks differ from original business observations",
  );
  return receipt;
}
