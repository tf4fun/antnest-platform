import assert from "node:assert/strict";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";
import { privateACPStrictOutcome } from "../observability/private-acp-inventory.mjs";
import { foundationTraceExitCode } from "./foundation-evidence.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";
import { assertNetworkOwner } from "./network-private-session.mjs";

const phases = ["allowed", "held-a", "held-b", "denied", "restored", "private"];
const unique = (values) => {
  assert(values.every((v) => typeof v === "string" && v.length > 0));
  assert.equal(
    new Set(values).size,
    values.length,
    "duplicate Network identity",
  );
};
export function networkPublicResult(result) {
  const {
    private_connections,
    private_network,
    private_collection_errors,
    ...summary
  } = result;
  return summary;
}

export function networkPrivateAdmission(result) {
  assert.equal(result.profile, "lifecycle-real-network");
  for (const [key, count] of Object.entries({
    agents: 2,
    operations: 4,
    model_requests: 12,
    completed_runs: 6,
    runtimes_cleanly_exited: 2,
    trace_producers_stopped: 7,
  }))
    assert.equal(result[key], count, key);
  for (const flag of [
    "old_connection_revoked",
    "other_agent_same_connection_preserved",
    "unsolicited_denied_push_blocked",
    "runtime_unchanged",
    "deleted_before_teardown",
    "private_cleanup_completed",
  ])
    assert.equal(result[flag], true, flag);
  assert.deepEqual(result.private_collection_errors, []);
  const work = result.private_network,
    connections = result.private_connections;
  assert.equal(work.agents.length, 2);
  work.agents.forEach((agent) =>
    assertNetworkOwner(work.principal, work.creation_principal, agent),
  );
  const agents = work.agents.map((agent) => agent.id);
  unique(agents);
  assert.equal(connections.length, 6);
  connections.forEach(checkPrivateACPConnection);
  unique(connections.map((c) => c.connectionTraceID));
  unique(connections.map((c) => c.clientSpanID));
  const probes = work.probes;
  assert.deepEqual(
    probes.map((p) => p.phase),
    phases,
  );
  unique(probes.map((p) => p.session_id));
  unique(probes.map((p) => p.run_id));
  const rows = [];
  for (const [i, connection] of connections.entries()) {
    const probe = probes[i],
      agentId = probe.phase === "held-b" ? agents[1] : agents[0];
    assert.equal(connection.version, 1);
    assert.equal(connection.agentId, agentId);
    assert.deepEqual(
      [probe.agent_id, probe.connection_trace_id],
      [agentId, connection.connectionTraceID],
    );
    const [created, prompted] = connection.evidence;
    assert.deepEqual(
      connection.evidence.map((r) => r.method),
      ["session/new", "session/prompt"],
    );
    for (const row of connection.evidence) {
      assert.equal(row.outcome, "succeeded");
      assert.equal(row.rejection, undefined);
      assert.equal(row.sessionId, probe.session_id);
      assert.equal(row.phase, probe.phase);
      assert.deepEqual(row.requestReceipt, {
        requestId: row.requestId,
        params: row.requestParams,
        result: row.requestResult,
      });
      const wire = connection.raw_frames.find(
        (f) => String(f.id) === row.requestId && Object.hasOwn(f, "result"),
      );
      assert.deepEqual(wire.result, row.requestResult);
    }
    assert.equal(created.inputSessionID, null);
    assert.deepEqual(created.requestParams, {
      cwd: "/workspace",
      mcpServers: [],
    });
    assert.equal(created.requestResult.sessionId, probe.session_id);
    assert.equal(prompted.inputSessionID, probe.session_id);
    assert.equal(prompted.kind, "ordinary");
    assert.equal(prompted.toolName, "bash");
    assert.equal(prompted.requestResult.stopReason, "end_turn");
    assert.equal(probe.input.phase, probe.phase);
    assert.deepEqual(prompted.requestParams, {
      sessionId: probe.session_id,
      prompt: [{ type: "text", text: JSON.stringify(probe.input) }],
    });
    rows.push(connection.initialization, ...connection.evidence);
  }
  assert.deepEqual(
    work.held.map((h) => h.phase),
    ["before-deny", "after-stale-cas"],
  );
  for (const held of work.held)
    assert.deepEqual(
      held.probes,
      probes.slice(1, 3).map((p) => ({
        phase: p.phase,
        agent_id: p.agent_id,
        session_id: p.session_id,
        connection_trace_id: p.connection_trace_id,
        settled: false,
      })),
    );
  const requests = result.request_traces;
  assert.equal(requests.length, 18);
  for (const [i, row] of rows.entries()) {
    const trace = requests[i];
    assert.equal(trace.topology, "passed");
    assert.deepEqual(
      [
        trace.method,
        trace.request_id,
        trace.connection_trace_id,
        trace.session_id,
      ],
      [row.method, row.requestId, row.connectionTraceID, row.sessionId],
    );
    assert.equal(trace.runs, row.kind === "ordinary" ? 1 : 0);
    assert.equal(trace.runtime_tool_calls, row.kind === "ordinary" ? 1 : 0);
    assert.equal(trace.rejection, undefined);
    if (row.kind === "ordinary")
      assert.equal(trace.run_id, probes[Math.floor(i / 3)].run_id);
  }
  assert.equal(work.provider_requests.length, 12);
  for (const [i, probe] of probes.entries())
    assert.deepEqual(
      work.provider_requests
        .filter((r) => r.phase === probe.phase)
        .map(({ phase, stage, trace_id }) => ({ phase, stage, trace_id })),
      ["tool", "reply"].map((stage) => ({
        phase: probe.phase,
        stage,
        trace_id: requests[i * 3 + 2].trace_id,
      })),
    );
  const policies = work.policies;
  assert.deepEqual(
    policies.map((p) => [p.agentID, p.action]),
    [
      [agents[0], "allow_all"],
      [agents[1], "allow_all"],
      [agents[0], "deny_all"],
      [agents[0], "allow_all"],
    ],
  );
  unique(policies.map((p) => p.options.headers["Idempotency-Key"]));
  for (const policy of policies) {
    assert.equal(policy.status, 200);
    assert.equal(policy.options.method, "PUT");
    assert.equal(
      policy.path,
      `/api/admin/agents/${policy.agentID}/network-policy`,
    );
    assert.equal(
      policy.options.headers["X-Antnest-Expected-Principal"],
      work.creation_principal,
    );
    assert.equal(policy.options.body.action, policy.action);
    assert.equal(policy.response.action, policy.action);
    assert(Number.isSafeInteger(policy.options.body.expected_resource_version));
    assert(
      [
        policy.options.body.expected_resource_version,
        policy.options.body.expected_resource_version + 1,
      ].includes(policy.response.resource_version),
    );
  }
  const stale = work.stale_cas,
    replay = work.replay;
  assert.equal(stale.path, policies[1].path);
  assert.equal(stale.status, 409);
  assert.equal(stale.response.code, "resource_version_conflict");
  assert.equal(stale.options.method, "PUT");
  assert.equal(
    stale.options.headers["X-Antnest-Expected-Principal"],
    work.creation_principal,
  );
  assert(
    typeof stale.options.headers["Idempotency-Key"] === "string" &&
      stale.options.headers["Idempotency-Key"].length > 0,
  );
  assert(
    !policies.some(
      (p) =>
        p.options.headers["Idempotency-Key"] ===
        stale.options.headers["Idempotency-Key"],
    ),
  );
  assert.deepEqual(stale.options.body, {
    action: "deny_all",
    expected_resource_version: policies[1].response.resource_version - 1,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.path, policies[2].path);
  assert.deepEqual(replay.options, policies[2].options);
  assert.deepEqual(replay.response, policies[2].response);
  assert.equal(result.policy_traces.length, 4);
  result.policy_traces.forEach((trace, i) =>
    assert.deepEqual(
      [trace.trace_id, trace.agent_id, trace.action],
      [policies[i].traceID, policies[i].agentID, policies[i].action],
    ),
  );
  assert.deepEqual(
    result.traces.map((t) => [t.agent_id, t.kind]),
    [
      [agents[0], "create"],
      [agents[1], "create"],
      [agents[0], "delete"],
      [agents[1], "delete"],
    ],
  );
  unique(result.traces.map((t) => t.request_id));
  unique(
    [...requests, ...result.policy_traces, ...result.traces].map(
      (t) => t.trace_id,
    ),
  );
  const privateDiagnostics = privateACPStrictOutcome(
    requests,
    new Set([
      "completed-initialize-mcp-read-disconnect",
      "completed-runtime-tool-http-disconnect",
    ]),
  );
  const ordinary = [...result.traces, ...result.policy_traces];
  const accepted =
    ordinary.every(
      (trace) =>
        trace.topology === "passed" &&
        ["passed", "failed"].includes(trace.strict_trace) &&
        (trace.strict_trace !== "passed" ||
          ((trace.error_spans ?? 0) === 0 &&
            (trace.warning_count ?? 0) === 0 &&
            (trace.warnings ?? []).length === 0)) &&
        trace.rejection === undefined &&
        (trace.restart_error_spans ?? 0) === 0 &&
        (trace.resolve_source_error_spans ?? 0) === 0 &&
        (trace.expected_transport_faults ?? 0) === 0,
    ) && clockWarningsOnly(ordinary);
  const strict = foundationTraceExitCode(ordinary);
  return {
    strict_exit:
      strict === 1 || privateDiagnostics.exit_code === 1
        ? 1
        : Math.max(strict, privateDiagnostics.exit_code),
    accepted_exit: accepted && privateDiagnostics.accepted ? 0 : 1,
    private_diagnostics: privateDiagnostics,
    inventory: {
      connections: 6,
      initializations: 6,
      business_requests: 12,
      runs: 6,
      provider_requests: 12,
      runtime_tool_calls: 6,
      policy_writes: 4,
      lifecycle_admissions: 4,
    },
  };
}
