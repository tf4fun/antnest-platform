import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { inspectFoundationBusinessEvidence } from "./foundation-business.mjs";
import { foundationPrivateAdmission } from "./foundation-private-evidence.mjs";

const lifecycleKinds = [
  "create",
  "create",
  "delete",
  "rebuild",
  "disable",
  "enable",
  "delete",
  "create",
  "delete",
];
const nonempty = (value, message) =>
  assert(typeof value === "string" && value.trim().length > 0, message);

function inspectStateReceipts(work, original) {
  const agentID = original.agent_id;
  const sessionID = original.private_connections[0].evidence[0].sessionId;
  assert(
    Array.isArray(work.private_state_receipts) &&
      work.private_state_receipts.length > 0,
    "original Foundation state receipts required",
  );
  let drained = false;
  for (const receipt of work.private_state_receipts) {
    assert.deepEqual(
      [receipt.agentId, receipt.method, receipt.path, receipt.status],
      [agentID, "POST", "/rpc/agent-acp/get-agent-execution-state", 200],
      "Foundation state receipt scope changed",
    );
    assert.equal(typeof receipt.rawBody, "string");
    const state = JSON.parse(receipt.rawBody);
    assert.equal(state.agent_id, agentID);
    assert.equal(state.access_allowed, true);
    assert.match(state.configuration_revision, /^[a-f0-9]{64}$/u);
    assert.equal(state.availability, "busy");
    assert.equal(state.active_session_id, sessionID);
    assert([null, "agent_unavailable"].includes(state.unavailable_reason));
    if (state.unavailable_reason === "agent_unavailable") drained = true;
  }
  assert(drained, "original Foundation drain state was not observed");
}

function inspectRunIdentities(work, original) {
  assert.deepEqual(work.private_connections, original.private_connections);
  const [first, second] = original.private_connections;
  const prompts = [first.evidence[2], second.evidence[1]];
  const audit = original.audits.find(
    (row) => row.session_id === prompts[0].sessionId,
  );
  const runIDs = prompts.map((prompt) => {
    const saved = audit.all.find(({ run }) =>
      isDeepStrictEqual(run.input, prompt.requestParams.prompt),
    );
    return saved.run.run_id;
  });
  assert.deepEqual(work.run_ids, runIDs, "original Foundation Run IDs changed");
  assert.equal(new Set(work.run_ids).size, 2);
}

function inspectLifecycles(result, agentID) {
  assert.equal(result.operations, 9);
  assert.deepEqual(result.lifecycle_kinds, lifecycleKinds);
  const admissions = result.private_lifecycle_admissions;
  assert(Array.isArray(admissions) && admissions.length === 9);
  assert.deepEqual(
    admissions.map((row) => row.kind),
    lifecycleKinds,
  );
  const noiseAgent = admissions[1].agentID;
  const failedAgent = admissions[7].agentID;
  nonempty(noiseAgent, "original cursor interleaving Agent required");
  nonempty(failedAgent, "original failed-start Agent required");
  assert.equal(new Set([agentID, noiseAgent, failedAgent]).size, 3);
  const agents = [
    agentID,
    noiseAgent,
    noiseAgent,
    agentID,
    agentID,
    agentID,
    agentID,
    failedAgent,
    failedAgent,
  ];
  const requests = new Set();
  for (const [index, admission] of admissions.entries()) {
    nonempty(admission.requestID, "original lifecycle request ID required");
    assert(
      !requests.has(admission.requestID),
      "duplicate lifecycle request ID",
    );
    requests.add(admission.requestID);
    assert.equal(admission.agentID, agents[index]);
    assert.equal(admission.runtimeStartupFailure === true, index === 7);
    assert(
      admission.outcome === undefined || admission.outcome === "completed",
      "unexpected Foundation lifecycle outcome",
    );
    const terminal = admission.terminal;
    assert.equal(terminal.kind, admission.kind);
    assert.equal(terminal.agent_id, admission.agentID);
    assert.equal(terminal.request_id, admission.requestID);
    // This scenario observes a failing Runtime after provisioning completed.
    // Its Create operation is not a failed provisioning command.
    assert.equal(terminal.state, "completed");
  }
  const observations = result.private_observations;
  assert(
    Array.isArray(observations) && observations.length > 0,
    "independent persisted observation receipts required",
  );
  const events = new Set();
  for (const observation of observations) {
    nonempty(observation.event_id, "persisted observation identity required");
    assert(
      !events.has(observation.event_id),
      "duplicate persisted observation",
    );
    events.add(observation.event_id);
    assert.equal(observation.agent_id, failedAgent);
    assert.equal(observation.business, "passed");
  }
  assert.equal(result.replay_observation_events, observations.length);
  return observations.length;
}

export async function admitFoundationBusiness(result, { traceDiagnostics }) {
  assert.equal(result.profile, "lifecycle-foundation-and-startup-failure");
  const work = result.active_run_rebuild;
  const original = work.private_business;
  const counts = inspectFoundationBusinessEvidence(original);
  assert.equal(work.completed_prompts, 2);
  assert.equal(work.denied_prompts, 2);
  assert.equal(work.cleanup_completed, true);
  assert.equal(work.same_session_after_rebuild, true);
  assert.equal(work.physical_tool_effects_exact, true);
  const restart = work.controller_restart;
  assert.equal(restart.nonterminal_phase, "drain");
  assert.equal(restart.graceful, true);
  assert.equal(restart.exit_code, 0);
  assert.equal(restart.process_restart_verified, true);
  assert.equal(result.network_cas_changes, 2);
  assert.equal(result.workspace_preserved_and_removed, true);
  assert.equal(result.idle_restart_replay, true);
  assert.equal(result.failed_runtime_deleted_before_teardown, true);
  inspectRunIdentities(work, original);
  inspectStateReceipts(work, original);
  const observationEvents = inspectLifecycles(result, original.agent_id);

  // The caller owns the shared diagnostic budget. Keep every business gate
  // above it, and let its parent cancellation and actual callback join propagate.
  let strictExit = 2;
  await traceDiagnostics.run("foundation-strict-admission", () => {
    const strict = foundationPrivateAdmission(result);
    strictExit = strict.strict_exit;
    if (strict.strict_exit !== 0 || strict.accepted_exit !== 0) {
      throw new Error(
        "Foundation strict Trace admission reported diagnostics",
        {
          cause: strict,
        },
      );
    }
    return strict;
  });
  return {
    accepted_exit: 0,
    strict_exit: strictExit,
    business: {
      ...counts,
      lifecycle_admissions: 9,
      observation_events: observationEvents,
    },
    trace_diagnostics: traceDiagnostics.summary(),
  };
}
