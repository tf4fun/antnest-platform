import assert from "node:assert/strict";
import { createRequire } from "node:module";
import schema from "../../../contracts/agent-acp/agent-execution-state.schema.json" with { type: "json" };
import { inspectLossBusinessEvidence } from "./loss-business.mjs";
import { lossPrivateAdmission } from "./loss-private-evidence.mjs";
import { assertReplacement } from "./loss-evidence.mjs";
const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const validateState = new (require("ajv/dist/2020.js").Ajv2020)({
  strict: false,
}).compile(schema);
const nonempty = (value) => assert(typeof value === "string" && value.trim());

export async function admitLossBusiness(result, { traceDiagnostics }) {
  assert.equal(result.profile, "runtime-loss");
  assert.equal(result.private_cleanup_completed, true);
  assert.equal(result.deleted_before_teardown, true);
  assert.deepEqual(result.private_collection_errors, []);
  const counts = inspectLossBusinessEvidence(result.private_business);
  const work = result.private_loss;
  assert.deepEqual(work.agents, result.private_business.agents);
  assert.deepEqual(
    result.private_connections,
    result.private_business.private_connections,
  );
  for (const [field, count] of Object.entries({
    operations: 6,
    completed_runs: 4,
    denied_prompts: 2,
    model_requests: 8,
  }))
    assert.equal(result[field], count);
  assert.equal(result.cases.length, 2);
  for (const [index, agent] of work.agents.entries()) {
    assertReplacement(agent.initial, agent.replacement);
    assert.equal(agent.stopped_runtime.Id, agent.initial.container.Id);
    assert.deepEqual(
      agent.stopped_runtime.Config.Labels,
      agent.initial.container.Config.Labels,
    );
    assert.deepEqual(
      [
        agent.stopped_runtime.State.Running,
        agent.stopped_runtime.State.ExitCode,
        agent.stopped_runtime.State.OOMKilled,
      ],
      [false, 0, false],
    );
    const row = result.cases[index];
    assert.equal(row.mode, agent.mode);
    assert.equal(row.agent_id, agent.id);
    assert.equal(row.loss_reason, index ? "runtime_missing" : "runtime_exited");
    assert.equal(
      row.producer_kind,
      index ? "runtime_missing" : "runtime_deleted",
    );
    assert(
      Number.isSafeInteger(row.producer_sequence) && row.producer_sequence > 0,
    );
    for (const [field, expected] of Object.entries({
      completed_prompts: 2,
      denied_prompts: 1,
      history_replay_model_calls: 0,
      normal_runtime_exit: 0,
      same_session: true,
      exact_workspace_bytes: true,
      controller_restart_stable: true,
      current_inspect_loss_audit: true,
      execution_audits_preserved: true,
    }))
      assert.equal(row[field], expected);
  }
  const reads = result.private_state_receipts;
  assert(Array.isArray(reads) && reads.length >= 2);
  for (const read of reads) {
    assert.deepEqual(
      [read.method, read.path, read.status],
      ["POST", "/rpc/agent-acp/get-agent-execution-state", 200],
    );
    const state = JSON.parse(read.rawBody);
    assert(validateState(state));
    assert.equal(state.agent_id, read.agentId);
    assert(work.agents.some((agent) => agent.id === read.agentId));
    assert.equal(state.access_allowed, true);
  }
  assert.equal(work.confirmations.length, 2);
  let previous = -1;
  for (const [index, confirmation] of work.confirmations.entries()) {
    const agent = work.agents[index],
      offset = confirmation.receipt_index;
    assert(
      Number.isSafeInteger(offset) &&
        offset > previous &&
        offset < reads.length,
    );
    previous = offset;
    assert.deepEqual(
      [
        confirmation.mode,
        confirmation.agent_id,
        confirmation.connection_closed,
      ],
      [agent.mode, agent.id, false],
    );
    assert.equal(reads[offset].agentId, agent.id);
    const state = JSON.parse(reads[offset].rawBody);
    assert.equal(state.availability, "offline");
    assert.equal(state.unavailable_reason, "agent_unavailable");
    assert.equal(state.active_session_id, null);
  }
  const admissions = work.lifecycle_admissions;
  assert.equal(admissions.length, 6);
  assert.deepEqual(
    admissions.map((row) => [row.agentID, row.kind]),
    work.agents.flatMap((agent) =>
      ["create", "rebuild", "delete"].map((kind) => [agent.id, kind]),
    ),
  );
  const requests = new Set();
  for (const [index, admission] of admissions.entries()) {
    nonempty(admission.requestID);
    assert(!requests.has(admission.requestID));
    requests.add(admission.requestID);
    const terminal = admission.terminal;
    assert.deepEqual(
      [terminal.agent_id, terminal.request_id, terminal.kind, terminal.state],
      [admission.agentID, admission.requestID, admission.kind, "completed"],
    );
    if (admission.kind === "rebuild") {
      const generation = Number(
        work.agents[Math.floor(index / 3)].initial.container.Config.Labels[
          "io.antnest.runtime-generation"
        ],
      );
      assert(Number.isSafeInteger(generation) && generation > 0);
      assert.equal(admission.missingSourceGeneration, generation);
    } else assert.equal(admission.missingSourceGeneration, undefined);
  }
  let strictExit = 2;
  await traceDiagnostics.run("loss-strict-admission", () => {
    const strict = lossPrivateAdmission(result);
    strictExit = strict.strict_exit;
    if (strict.strict_exit !== 0 || strict.accepted_exit !== 0)
      throw new Error("Loss strict Trace admission reported diagnostics", {
        cause: strict,
      });
    return strict;
  });
  return {
    accepted_exit: 0,
    strict_exit: strictExit,
    business: { ...counts, lifecycle_admissions: 6 },
    trace_diagnostics: traceDiagnostics.summary(),
  };
}
