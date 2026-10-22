import assert from "node:assert/strict";
import test from "node:test";
import { lossPrivateEvidenceFixture } from "./loss-private-evidence.fixture.mjs";
const url = new URL("./loss-private-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function fixture(t) {
  assert.equal(typeof implementation.lossPrivateAdmission, "function");
  return lossPrivateEvidenceFixture(t);
}
test("Loss admits complete real private wire, original state and four same-Session Runs while retaining denial failures", async (t) => {
  const result = await fixture(t),
    before = JSON.stringify(result);
  const admitted = implementation.lossPrivateAdmission(result);
  assert.equal(admitted.strict_exit, 2);
  assert.equal(admitted.accepted_exit, 0);
  assert.deepEqual(admitted.inventory, {
    connections: 6,
    initializations: 6,
    business_requests: 14,
    runs: 4,
    provider_requests: 8,
    runtime_tool_calls: 4,
    lifecycle_admissions: 6,
    confirmed_offline_observations: 2,
  });
  assert.equal(JSON.stringify(result), before);
  const additionalProbe = structuredClone(result);
  additionalProbe.traces[1].platform_absence_probes = 2;
  assert.equal(
    implementation.lossPrivateAdmission(additionalProbe).accepted_exit,
    0,
  );
  assert.equal(typeof implementation.lossPublicResult, "function");
  const publicResult = implementation.lossPublicResult(result);
  assert.equal(
    implementation.lossPublicResult({
      ...result,
      private_business: { original: "private" },
    }).private_business,
    undefined,
  );
  assert.deepEqual(publicResult.cases, result.cases);
  for (const field of [
    "private_loss",
    "private_connections",
    "private_state_receipts",
    "private_collection_errors",
    "private_cleanup_completed",
  ])
    assert.equal(publicResult[field], undefined);
  assert.equal(JSON.stringify(result), before);
});
test("Loss rejects missing, foreign or substituted inventory and failed cleanup", async (t) => {
  const original = await fixture(t);
  implementation.lossPrivateAdmission(original);
  for (const mutate of [
    (r) => r.private_connections.pop(),
    (r) => r.request_traces.shift(),
    (r) => (r.private_connections[1].closed = false),
    (r) =>
      (r.private_connections[1].evidence[1].rejectionReceipt.retryable = false),
    (r) =>
      (r.private_connections[1].raw_frames =
        r.private_connections[1].raw_frames.filter((f) => !f.error)),
    (r) => (r.private_loss.principal.user_id = "admin"),
    (r) => (r.private_loss.principal.organization_id = "foreign"),
    (r) => (r.private_loss.agents[1].id = r.private_loss.agents[0].id),
    (r) =>
      (r.private_loss.agents[0].after_run.run_id =
        r.private_loss.agents[0].before_run.run_id),
    (r) =>
      (r.private_loss.agents[0].after_run.execution_snapshot.executionRevision =
        "old"),
    (r) => (r.private_loss.agents[0].stopped_runtime.State.ExitCode = 137),
    (r) => (r.private_loss.agents[0].replacement.volume = "foreign"),
    (r) => (r.private_loss.confirmations[0].connection_closed = true),
    (r) => (r.private_loss.confirmations[0].receipt_index = 1),
    (r) => (r.private_state_receipts[0].path = "/api/app/agents/live/state"),
    (r) => {
      const s = JSON.parse(r.private_state_receipts[0].rawBody);
      delete s.configuration_revision;
      r.private_state_receipts[0].rawBody = JSON.stringify(s);
    },
    (r) => {
      const s = JSON.parse(r.private_state_receipts[0].rawBody);
      s.availability = "ready";
      s.unavailable_reason = null;
      r.private_state_receipts[0].rawBody = JSON.stringify(s);
    },
    (r) => (r.private_loss.provider_requests[0].trace_id = "foreign"),
    (r) => (r.private_loss.provider_requests[0].phase = "c5-cold-before"),
    (r) => r.private_loss.provider_requests.pop(),
    (r) => (r.traces[1].platform_absence_probes = 0),
    (r) => (r.private_loss.lifecycle_admissions[1].missingSourceGeneration = 2),
    (r) => (r.traces[1].request_id = "foreign"),
    (r) => (r.request_traces[2].run_id = "foreign"),
    (r) => (r.request_traces[2].runtime_tool_calls = 0),
    (r) => (r.request_traces[6].no_execution = false),
    (r) => (r.private_cleanup_completed = false),
    (r) => r.private_collection_errors.push("original failure"),
    (r) => (r.cases[0].controller_restart_stable = false),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => implementation.lossPrivateAdmission(changed));
  }
});
test("Loss retains raw strict failures and rejects unclaimed internal, old missing-source and unrelated busy diagnostics", async (t) => {
  const original = await fixture(t);
  for (const mutate of [
    (r) => {
      r.traces[1].platform_probe_errors = 1;
      r.traces[1].strict_trace = "failed";
      r.traces[1].error_spans = 1;
    },
    (r) => r.traces[0].warnings.push("unknown internal warning"),
    (r) =>
      (r.request_traces[6].owned_error_spans[0].reason =
        "managed-busy-rejection"),
    (r) => r.request_traces[6].raw_error_inventory.pop(),
    (r) => (r.request_traces[6].strict_trace = "passed"),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(
      implementation.lossPrivateAdmission(changed).accepted_exit,
      0,
    );
  }
});
test("Loss initialization cannot carry a refusal on a successful wire receipt", async (t) => {
  const original = await fixture(t);
  for (const mutate of [
    (r) => {
      r.private_connections[0].initialization.rejection = "agent_unavailable";
    },
    (r) => {
      r.private_connections[0].initialization.rejectionReceipt = {
        rpcCode: -32020,
        code: "agent_unavailable",
        retryable: false,
      };
    },
    (r) => {
      r.request_traces[0].rejection = "agent_unavailable";
    },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => implementation.lossPrivateAdmission(changed));
  }
});
