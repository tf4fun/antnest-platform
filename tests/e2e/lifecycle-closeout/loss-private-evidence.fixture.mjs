import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  foundationConnectionFixture,
  principal,
  setup,
} from "./foundation-connection.fixture.mjs";
const { openFoundationConnection } =
  await import("./foundation-connection.mjs");
const stateDependencies = registerHooks({
  resolve(specifier, context, next) {
    return next(
      specifier,
      specifier === "ajv/dist/2020.js"
        ? {
            ...context,
            parentURL: new URL(
              "../../../services/agent-acp-service/package.json",
              import.meta.url,
            ).href,
          }
        : context,
    );
  },
});
let readPrivateExecutionState;
try {
  ({ readPrivateExecutionState } =
    await import("../../support/private-acp-execution-state.mjs"));
} finally {
  stateDependencies.deregister();
}

export const lossCaseSummary = (mode) => ({
  mode,
  agent_id: mode,
  loss_reason: mode === "live" ? "runtime_exited" : "runtime_missing",
  completed_prompts: 2,
  denied_prompts: 1,
  history_replay_model_calls: 0,
  same_session: true,
  exact_workspace_bytes: true,
  controller_restart_stable: true,
  producer_kind: mode === "live" ? "runtime_deleted" : "runtime_missing",
  producer_sequence: mode === "live" ? 1 : 2,
  current_inspect_loss_audit: true,
  normal_runtime_exit: 0,
  execution_audits_preserved: true,
});
const clean = {
  topology: "passed",
  strict_trace: "passed",
  error_spans: 0,
  warning_count: 0,
  warnings: [],
};
export async function lossPrivateEvidenceFixture(t) {
  const f = await foundationConnectionFixture(t, {
    denyPrompt: (params) => params.prompt[0].text.endsWith("-denied"),
  });
  f.release();
  const connections = [],
    agents = [],
    receipts = [],
    confirmations = [],
    admissions = [];
  for (const mode of ["live", "cold"]) {
    const initial = {
      agent: {
        agent_id: mode,
        owner_user_id: principal.user_id,
        desired_state: "enabled",
        lifecycle_state: "created",
        activation_state: "enabled",
        runtime_state: "available",
        executable_execution_revision: mode + "-e1",
        last_successful_execution_revision: mode + "-e1",
        aggregate_sequence: 2,
        configuration: { template: { template_id: "t", revision: 1 } },
        runtime: { runtime_revision: mode + "-r1" },
      },
      container: {
        Id: mode + "-old",
        Config: { Labels: { "io.antnest.runtime-generation": "1" } },
      },
      volume: mode + "-workspace",
    };
    const replacement = structuredClone(initial);
    Object.assign(replacement.agent, {
      executable_execution_revision: mode + "-e2",
      last_successful_execution_revision: mode + "-e2",
      aggregate_sequence: 4,
      runtime: { runtime_revision: mode + "-r2" },
    });
    replacement.container.Id = mode + "-new";
    const open = async () =>
      f.register(
        await openFoundationConnection(mode, f.browser, {
          ...f.options,
          preserve() {},
        }),
      );
    let client = await open();
    const sessionId = (await client.request("new", setup)).sessionId;
    const run = (phase, agent) => ({
      run_id: mode + "-" + phase,
      agent_id: mode,
      session_id: sessionId,
      state: "completed",
      terminal_class: "completed",
      executor_state: "quiescent",
      tool_effect_state: "settled",
      execution_snapshot: {
        executionRevision: agent.executable_execution_revision,
      },
    });
    const prompt = async (client, phase, toolName) =>
      client.request(
        "prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: "c5-" + mode + "-" + phase }],
        },
        60000,
        { kind: "ordinary", phase: "c5-" + mode + "-" + phase, toolName },
      );
    const load = async () => client.request("load", { sessionId, ...setup });
    await prompt(client, "before", "bash");
    await load();
    await client.closeAndWait();
    connections.push(client.snapshot());
    client = await open();
    await load();
    Object.assign(f.state, {
      agent_id: mode,
      availability: "offline",
      active_session_id: null,
      unavailable_reason: "agent_unavailable",
    });
    await readPrivateExecutionState(mode, f.browser, {
      ...f.options,
      receipts,
      endpoint: f.origin + "/rpc/agent-acp/get-agent-execution-state",
    });
    confirmations.push({
      mode,
      agent_id: mode,
      connection_trace_id: client.connectionTraceID,
      connection_closed: client.snapshot().closed,
      receipt_index: receipts.length - 1,
    });
    await assert.rejects(
      client.request(
        "prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: "c5-" + mode + "-denied" }],
        },
        15000,
        { rejection: "agent_unavailable" },
      ),
      (error) =>
        error.code === -32020 &&
        error.data.code === "agent_unavailable" &&
        error.data.retryable === false,
    );
    await client.closeAndWait();
    connections.push(client.snapshot());
    client = await open();
    await load();
    await prompt(client, "after", "read");
    await client.closeAndWait();
    connections.push(client.snapshot());
    agents.push({
      id: mode,
      mode,
      initial,
      replacement,
      session_id: sessionId,
      before_run: run("before", initial.agent),
      after_run: run("after", replacement.agent),
      stopped_runtime: {
        ...initial.container,
        State: { Running: false, ExitCode: 0, OOMKilled: false },
      },
    });
    for (const kind of ["create", "rebuild", "delete"])
      admissions.push({
        kind,
        agentID: mode,
        requestID: mode + "-" + kind,
        traceID: mode + "-lifecycle-" + kind,
        ...(kind === "rebuild" ? { missingSourceGeneration: 1 } : {}),
      });
  }
  let serial = 0;
  const requests = connections.flatMap((connection, i) =>
    [connection.initialization, ...connection.evidence].map((row) => {
      const traceID = (++serial).toString(16).padStart(32, "a");
      const ordinary = row.kind === "ordinary",
        denial = row.rejection === "agent_unavailable";
      const claims = denial
        ? ["rpc", "application"].map((span_id) => ({
            trace_id: traceID,
            span_id,
            reason: "loss-unavailable-rejection",
          }))
        : [];
      return {
        ...clean,
        trace_id: traceID,
        method: row.method,
        request_id: row.requestId,
        connection_trace_id: connection.connectionTraceID,
        session_id: row.sessionId,
        runs: ordinary ? 1 : 0,
        runtime_tool_calls: ordinary ? 1 : 0,
        ...(ordinary
          ? {
              run_id:
                agents[Math.floor(i / 3)][
                  row.phase.endsWith("before") ? "before_run" : "after_run"
                ].run_id,
            }
          : {}),
        ...(denial
          ? {
              rejection: row.rejection,
              no_execution: true,
              strict_trace: "failed",
              error_spans: 2,
            }
          : {}),
        diagnostic_inventory_verified: true,
        raw_error_inventory: claims.map(({ trace_id, span_id }) => ({
          trace_id,
          span_id,
        })),
        owned_error_spans: claims,
      };
    }),
  );
  const providers = connections.flatMap((connection) =>
    connection.evidence
      .filter((r) => r.kind === "ordinary")
      .flatMap((row) =>
        ["tool", "reply"].map((stage) => ({
          phase: row.phase,
          stage,
          trace_id: requests.find(
            (r) =>
              r.connection_trace_id === connection.connectionTraceID &&
              r.request_id === row.requestId,
          ).trace_id,
        })),
      ),
  );
  return {
    profile: "runtime-loss",
    operations: 6,
    cases: ["live", "cold"].map(lossCaseSummary),
    completed_runs: 4,
    denied_prompts: 2,
    model_requests: 8,
    deleted_before_teardown: true,
    private_cleanup_completed: true,
    private_collection_errors: [],
    private_connections: connections,
    private_state_receipts: receipts,
    private_loss: {
      principal,
      creation_principal: encodeURIComponent(
        JSON.stringify([principal.organization_id, "admin"]),
      ),
      agents,
      confirmations,
      provider_requests: providers,
      lifecycle_admissions: admissions,
    },
    request_traces: requests,
    traces: admissions.map((row) => ({
      ...clean,
      kind: row.kind,
      agent_id: row.agentID,
      request_id: row.requestID,
      trace_id: row.traceID,
      ...(row.kind === "rebuild" ? { platform_absence_probes: 1 } : {}),
    })),
  };
}
