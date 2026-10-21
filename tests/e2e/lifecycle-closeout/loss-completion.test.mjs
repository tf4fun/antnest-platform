import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { lossBusinessFixture } from "./loss-business.fixture.mjs";
const url = new URL("./loss-completion.mjs", import.meta.url);
const { admitLossBusiness } = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function original() {
  const business = lossBusinessFixture();
  const work = { ...business, confirmations: [], lifecycle_admissions: [] };
  const reads = [];
  for (const [index, agent] of work.agents.entries()) {
    agent.stopped_runtime = structuredClone(agent.initial.container);
    agent.stopped_runtime.State = {
      Running: false,
      ExitCode: 0,
      OOMKilled: false,
    };
    reads.push({
      agentId: agent.id,
      method: "POST",
      path: "/rpc/agent-acp/get-agent-execution-state",
      status: 200,
      rawBody: JSON.stringify({
        agent_id: agent.id,
        access_allowed: true,
        configuration_revision: "a".repeat(64),
        availability: "offline",
        active_session_id: null,
        unavailable_reason: "agent_unavailable",
      }),
    });
    work.confirmations.push({
      mode: agent.mode,
      agent_id: agent.id,
      receipt_index: index,
      connection_closed: false,
    });
    for (const kind of ["create", "rebuild", "delete"]) {
      const requestID = agent.id + "-" + kind;
      work.lifecycle_admissions.push({
        agentID: agent.id,
        kind,
        requestID,
        terminal: {
          agent_id: agent.id,
          kind,
          request_id: requestID,
          state: "completed",
        },
        ...(kind === "rebuild" ? { missingSourceGeneration: 1 } : {}),
      });
    }
  }
  return {
    profile: "runtime-loss",
    private_business: business,
    private_loss: work,
    private_connections: business.private_connections,
    private_state_receipts: reads,
    private_collection_errors: [],
    private_cleanup_completed: true,
    operations: 6,
    completed_runs: 4,
    denied_prompts: 2,
    model_requests: 8,
    deleted_before_teardown: true,
    cases: work.agents.map((agent, index) => ({
      mode: agent.mode,
      agent_id: agent.id,
      loss_reason: index ? "runtime_missing" : "runtime_exited",
      producer_kind: index ? "runtime_missing" : "runtime_deleted",
      producer_sequence: index + 1,
      completed_prompts: 2,
      denied_prompts: 1,
      history_replay_model_calls: 0,
      normal_runtime_exit: 0,
      same_session: true,
      exact_workspace_bytes: true,
      controller_restart_stable: true,
      current_inspect_loss_audit: true,
      execution_audits_preserved: true,
    })),
    traces: [],
    request_traces: [],
  };
}
function diagnostics(t) {
  const directory = mkdtempSync(join(tmpdir(), "loss-completion-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return createTraceDiagnostics({ directory, budgetMs: 0 });
}
test("Loss admits original business, terminal lifecycles, runtime stop and private offline state without collected Trace", async (t) => {
  assert.equal(typeof admitLossBusiness, "function");
  const result = await admitLossBusiness(original(), {
    traceDiagnostics: diagnostics(t),
  });
  assert.equal(result.accepted_exit, 0);
  assert.equal(result.business.runs, 4);
  assert.equal(result.business.persisted_tools, 4);
  assert.equal(result.business.lifecycle_admissions, 6);
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.equal(result.trace_diagnostics.checks[0].status, "not_collected");
});
test("Loss cannot waive incomplete business, Runtime cleanup, private state or lifecycle receipts", async (t) => {
  assert.equal(typeof admitLossBusiness, "function");
  for (const mutate of [
    (r) => {
      r.private_business.agents[0].audit.all.pop();
    },
    (r) => {
      r.private_cleanup_completed = false;
    },
    (r) => {
      r.deleted_before_teardown = false;
    },
    (r) => {
      r.private_collection_errors.push("original failure");
    },
    (r) => {
      r.private_loss.agents[0].stopped_runtime.State.Running = true;
    },
    (r) => {
      r.private_loss.agents[0].stopped_runtime.State.ExitCode = 137;
    },
    (r) => {
      r.private_loss.agents[0].stopped_runtime.Id = "foreign";
    },
    (r) => {
      r.private_loss.lifecycle_admissions[0].terminal.state = "running";
    },
    (r) => {
      r.private_loss.lifecycle_admissions[1].missingSourceGeneration = 2;
    },
    (r) => {
      r.private_loss.lifecycle_admissions[2].requestID = "foreign";
    },
    (r) => {
      r.private_state_receipts[0].status = 503;
    },
    (r) => {
      r.private_loss.confirmations[0].receipt_index = 1;
    },
    (r) => {
      r.private_loss.confirmations[0].connection_closed = true;
    },
    (r) => {
      r.cases[0].exact_workspace_bytes = false;
    },
    (r) => {
      r.cases[1].controller_restart_stable = false;
    },
  ]) {
    const evidence = original();
    mutate(evidence);
    await assert.rejects(() =>
      admitLossBusiness(evidence, { traceDiagnostics: diagnostics(t) }),
    );
  }
});
