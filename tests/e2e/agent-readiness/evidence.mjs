import assert from "node:assert/strict";
import { readinessProof, publicationProof } from "./readiness-proof.mjs";
import {
  assertAgentDeleted,
  assertAgentReady,
} from "../../support/verification/agent-state.mjs";
import { assertRuntimeStorage } from "../lifecycle-closeout/failure.mjs";

const present = (value) =>
  assert(
    typeof value === "string" && value.length > 0,
    "missing original identity",
  );
function modelReply(model, phase) {
  assert.deepEqual(model.errors, []);
  const matches = model.requests.filter((request) => request.phase === phase);
  assert.equal(
    matches.length,
    1,
    "one model request per original Prompt required",
  );
  assert.equal(matches[0].stage, "reply");
}

export function inspectRound(row) {
  assert(Number.isSafeInteger(row.index) && row.index >= 1 && row.index <= 100);
  assert.equal(row.phase, `readiness-${row.index}`);
  present(row.principalId);
  const proof = readinessProof(row.events, row);
  publicationProof(row.publication, proof, row);
  const { bound } = proof;
  for (const attempt of [row.delayed.before, row.delayed.after]) {
    for (const field of [
      "id",
      "path",
      "organizationId",
      "revision",
      "requestSha256",
      "receivedAt",
      "delayStartedAt",
      "bindings",
    ])
      assert.deepEqual(
        attempt[field],
        row.publication[field],
        `delayed ${field} changed`,
      );
    for (const field of [
      "forwardedAt",
      "upstreamCompletedAt",
      "completedAt",
      "appliedRevision",
      "status",
    ])
      assert.equal(attempt[field], null);
    assert.equal(attempt.cancelled, false);
    assert(!attempt.error);
  }
  const binding = (agent) => {
    assert.equal(agent.agent_id, row.agentId);
    assert.equal(
      agent.executable_execution_revision,
      bound.data.execution_revision_id,
    );
    assert.equal(agent.runtime.runtime_revision, bound.data.runtime_revision);
  };
  binding(row.delayed.agent);
  assert.equal(row.delayed.agent.readiness, "preparing");
  assert(
    !row.delayed.events.some((event) => event.event_type === "agent_ready"),
    "ready was published before forwarding",
  );
  assert.deepEqual(
    row.delayed.events.filter((event) => event.event_type === "runtime_bound"),
    [bound],
  );
  binding(row.currentAgent);
  assertAgentReady(row.currentAgent);
  assert.deepEqual(
    row.actions.map((action) => action.name),
    ["ready_observed", "initialize_started", "new_started", "prompt_started"],
  );
  let previous = -Infinity;
  for (const action of row.actions) {
    assert(Number.isFinite(action.at) && action.at >= previous);
    previous = action.at;
  }
  const connection = row.connection;
  assert.equal(connection.version, 1);
  assert.equal(connection.agent_id, row.agentId);
  assert.equal(connection.closed, true);
  assert.equal(connection.initialization.method, "initialize");
  assert.equal(connection.initialization.outcome, "succeeded");
  assert.equal(connection.initialization.agentId, row.agentId);
  assert.deepEqual(
    connection.evidence.map((entry) => entry.method),
    ["session/new", "session/prompt"],
  );
  const [created, prompt] = connection.evidence;
  const all = [connection.initialization, created, prompt];
  assert.deepEqual(
    connection.requests.map((entry) => entry.method),
    ["initialize", "session/new", "session/prompt"],
  );
  const ids = all.map((entry) => String(entry.requestId));
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(
    connection.requests.map((entry) => String(entry.requestId)),
    ids,
  );
  for (const entry of [created, prompt]) {
    assert.equal(entry.outcome, "succeeded");
    assert.equal(
      String(entry.requestReceipt.requestId),
      String(entry.requestId),
    );
  }
  assert.deepEqual(created.requestReceipt.params, {
    cwd: "/workspace",
    mcpServers: [],
  });
  const sessionId = created.requestReceipt.result.sessionId;
  present(sessionId);
  assert.equal(created.sessionId, sessionId);
  assert.equal(prompt.sessionId, sessionId);
  assert.deepEqual(prompt.requestReceipt.params, {
    sessionId,
    prompt: [{ type: "text", text: row.phase }],
  });
  assert.equal(prompt.requestReceipt.result.stopReason, "end_turn");
  const { run, runList } = row;
  assert.equal(runList.next_cursor, null);
  assert.equal(runList.items.length, 1);
  for (const field of [
    "run_id",
    "agent_id",
    "session_id",
    "principal_id",
    "state",
  ])
    assert.equal(runList.items[0][field], run[field]);
  present(run.run_id);
  assert.equal(run.agent_id, row.agentId);
  assert.equal(run.session_id, sessionId);
  assert.equal(run.principal_id, row.principalId);
  assert.deepEqual(run.input, prompt.requestReceipt.params.prompt);
  assert.equal(
    run.execution_snapshot.executionRevision,
    bound.data.execution_revision_id,
  );
  for (const [field, value] of Object.entries({
    state: "completed",
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state: "none",
    stop_reason: "end_turn",
    error_class: null,
  }))
    assert.equal(run[field], value);
  modelReply(row.model, row.phase);
  const physical = row.resources.before;
  assertRuntimeStorage(physical, row.agentId);
  const [container] = physical.containers;
  present(container.Id);
  assert.equal(container.State.Running, true);
  assert.equal(container.State.Health.Status, "healthy");
  const labels = container.Config.Labels,
    status = row.resources.runtimeStatus;
  assert.equal(labels["io.antnest.managed"], "runtime");
  present(labels["io.antnest.runtime-controller-scope"]);
  assert.equal(labels["io.antnest.agent-id"], row.agentId);
  assert.equal(status.agent_id, row.agentId);
  assert.equal(status.status, "ready");
  assert.equal(
    status.generation,
    Number(labels["io.antnest.runtime-generation"]),
  );
  assert(Number.isSafeInteger(status.generation) && status.generation > 0);
  present(row.currentAgent.runtime.runtime_execution_id);
  assert.equal(
    status.execution_id,
    row.currentAgent.runtime.runtime_execution_id,
  );
  assert.equal(row.deleted.operation.kind, "delete");
  assert.equal(row.deleted.operation.agent_id, row.agentId);
  assert.equal(row.deleted.operation.state, "completed");
  present(row.deleted.operation.request_id);
  assert.equal(row.deleted.agent.agent_id, row.agentId);
  assertAgentDeleted(row.deleted.agent);
  assert.deepEqual(row.resources.after, { containers: [], volumes: [] });
  return { agent: row.agentId, session: sessionId, run: run.run_id };
}

export function inspectBatch({ rounds, model }) {
  assert.equal(rounds.length, 100, "100 executed rounds required");
  assert.deepEqual(
    rounds.map((round) => round.index),
    Array.from({ length: 100 }, (_, index) => index + 1),
  );
  rounds.forEach(inspectRound);
  for (const select of [
    (r) => r.agentId,
    (r) => r.operationId,
    (r) => r.phase,
    (r) => r.run.run_id,
    (r) => r.run.session_id,
    (r) => r.deleted.operation.request_id,
  ])
    assert.equal(
      new Set(rounds.map(select)).size,
      100,
      "reused original identity",
    );
  assert.equal(model.requests.length, 100);
  assert.deepEqual(model.errors, []);
  rounds.forEach((round) => modelReply(model, round.phase));
  return {
    status: "business_passed",
    fresh_agents: 100,
    first_prompts: 100,
    completed_runs: 100,
    model_replies: 100,
    runtime_cleanup: 100,
    publication_delay_ms: 2000,
  };
}
