import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./health-private-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture() {
  assert.equal(typeof implementation.healthPrivateAdmission, "function");
  const initial = {
    agent_id: "agent",
    lifecycle_state: "created",
    activation_state: "enabled",
    desired_state: "enabled",
    runtime_state: "available",
    executable_execution_revision: "exec",
    configuration: { template: { template_id: "template", revision: 1 } },
    runtime: { runtime_revision: "runtime", runtime_execution_id: "process" },
  };
  const phases = [
    "unhealthy",
    "recovered",
    "restarted",
    "restarted",
    "restarted",
  ];
  const reads = phases.map((phase) => ({
    phase,
    agentId: "agent",
    method: "POST",
    path: "/rpc/agent-acp/get-agent-execution-state",
    status: 200,
    rawBody: JSON.stringify({
      agent_id: "agent",
      access_allowed: true,
      configuration_revision: "a".repeat(64),
      availability: phase === "recovered" ? "ready" : "offline",
      active_session_id: null,
      unavailable_reason: phase === "recovered" ? null : "agent_unavailable",
    }),
  }));
  const observations = phases.map((phase, receipt_index) => ({
    phase,
    receipt_index,
    agent: {
      ...structuredClone(initial),
      runtime_state: phase === "unhealthy" ? "unhealthy" : "available",
      executable_execution_revision: phase === "restarted" ? null : "exec",
    },
  }));
  return {
    profile: "runtime-health",
    agent_id: "agent",
    operations: 3,
    execution_audits: 0,
    model_requests: 0,
    unhealthy_closes_acp_access: true,
    same_process_recovery_preserves_binding: true,
    healthy_restart_requires_rebuild: true,
    explicit_rebuild_recovers: true,
    workspace_preserved: true,
    deleted_before_teardown: true,
    private_state_closed: true,
    private_health_state: { initial, reads, observations },
    traces: ["create", "rebuild", "delete"].map((kind, i) => ({
      kind,
      agent_id: "agent",
      trace_id: String(i + 1).repeat(32),
      request_id: "request-" + i,
      topology: "passed",
      strict_trace: "passed",
      error_spans: 0,
      warnings: [],
      warning_count: 0,
    })),
  };
}

test("Health admits its own three lifecycle operations and five distinct private confirmations", () => {
  const f = fixture(),
    original = JSON.stringify(f);
  const report = implementation.healthPrivateAdmission(f);
  assert.deepEqual(report, {
    strict_exit: 0,
    accepted_exit: 0,
    inventory: {
      lifecycle_admissions: 3,
      state_reads: 5,
      confirmed_observations: 5,
      acp_connections: 0,
      runs: 0,
      model_requests: 0,
    },
  });
  assert.equal(JSON.stringify(f), original);
  const publicResult = implementation.healthPublicResult(f);
  assert.equal(publicResult.private_health_state, undefined);
  assert.equal(publicResult.private_state_closed, undefined);
  assert(!JSON.stringify(publicResult).includes("rawBody"));
  assert.deepEqual(publicResult.traces, f.traces);
});

test("Health retains a variable number of convergence reads with increasing confirmation indexes", () => {
  const f = fixture();
  f.private_health_state.reads.splice(
    0,
    0,
    structuredClone(f.private_health_state.reads[0]),
  );
  f.private_health_state.observations.forEach((o) => o.receipt_index++);
  assert.equal(
    implementation.healthPrivateAdmission(f).inventory.state_reads,
    6,
  );
});

for (const patch of [
  { availability: "bogus" },
  { unavailable_reason: [] },
  { active_session_id: "unrecorded-run" },
])
  test(`Health validates unconfirmed convergence reads: ${JSON.stringify(patch)}`, () => {
    const f = fixture();
    const extra = structuredClone(f.private_health_state.reads[0]);
    extra.rawBody = JSON.stringify({ ...JSON.parse(extra.rawBody), ...patch });
    f.private_health_state.reads.unshift(extra);
    f.private_health_state.observations.forEach((o) => o.receipt_index++);
    assert.throws(() => implementation.healthPrivateAdmission(f));
  });

for (const patch of [
  { error_spans: 1 },
  { resolve_source_error_spans: 1 },
  { platform_probe_errors: 1 },
  { warning_count: 1, warnings: ["unknown internal warning"] },
  {
    warning_count: 1,
    warnings: [
      "clock skew adjustment disabled; not applying calculated delta of 500µs",
    ],
  },
  { topology: "unknown" },
  { strict_trace: "unknown" },
])
  test(`Health rejects inconsistent passing diagnostics: ${JSON.stringify(patch)}`, () => {
    const f = fixture();
    Object.assign(f.traces[0], patch);
    assert.equal(implementation.healthPrivateAdmission(f).accepted_exit, 1);
  });

for (const [name, mutate] of [
  ["missing lifecycle operation", (f) => f.traces.pop()],
  [
    "foreign lifecycle Agent",
    (f) => {
      f.traces[0].agent_id = "foreign";
    },
  ],
  [
    "duplicate trace",
    (f) => {
      f.traces[1].trace_id = f.traces[0].trace_id;
    },
  ],
  [
    "duplicate request",
    (f) => {
      f.traces[1].request_id = f.traces[0].request_id;
    },
  ],
  ["missing confirmation", (f) => f.private_health_state.observations.pop()],
  [
    "reused receipt",
    (f) => {
      f.private_health_state.observations[4].receipt_index = 3;
    },
  ],
  [
    "phase mismatch",
    (f) => {
      f.private_health_state.reads[0].phase = "recovered";
    },
  ],
  [
    "foreign state",
    (f) => {
      f.private_health_state.reads[0].agentId = "foreign";
    },
  ],
  [
    "failed read",
    (f) => {
      f.private_health_state.reads[0].status = 503;
    },
  ],
  [
    "retired path",
    (f) => {
      f.private_health_state.reads[0].path = "/api/app/agents/agent/state";
    },
  ],
  [
    "unconfirmed revision",
    (f) => {
      f.private_health_state.observations[0].agent.runtime.runtime_revision =
        "foreign";
    },
  ],
  [
    "missing configuration",
    (f) => {
      const row = f.private_health_state.reads[0],
        state = JSON.parse(row.rawBody);
      delete state.configuration_revision;
      row.rawBody = JSON.stringify(state);
    },
  ],
  [
    "unfinished cleanup",
    (f) => {
      f.private_state_closed = false;
    },
  ],
  [
    "model execution",
    (f) => {
      f.model_requests = 1;
    },
  ],
  [
    "Run execution",
    (f) => {
      f.execution_audits = 1;
    },
  ],
  [
    "missing workspace proof",
    (f) => {
      f.workspace_preserved = false;
    },
  ],
])
  test(`Health admission rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => implementation.healthPrivateAdmission(f));
  });

test("Health retains strict clock diagnostics and admits only the existing reviewed lifecycle policy", () => {
  const f = fixture();
  Object.assign(f.traces[0], {
    strict_trace: "failed",
    warning_count: 1,
    warnings: [
      "clock skew adjustment disabled; not applying calculated delta of 500µs",
    ],
  });
  const raw = JSON.stringify(f);
  assert.equal(implementation.healthPrivateAdmission(f).strict_exit, 2);
  assert.equal(implementation.healthPrivateAdmission(f).accepted_exit, 0);
  assert.equal(JSON.stringify(f), raw);
  for (const patch of [
    { error_spans: 1 },
    { warnings: ["unknown internal warning"] },
    { platform_probe_errors: 1 },
    { topology: "failed" },
    { rejection: "agent_busy", no_execution: true, runs: 0, error_spans: 2 },
    { restart_error_spans: 3 },
  ]) {
    const rejected = structuredClone(f);
    Object.assign(rejected.traces[0], patch);
    assert.equal(
      implementation.healthPrivateAdmission(rejected).accepted_exit,
      1,
    );
  }
});

test("Health preserves precisely attributed preparation retry diagnostics", () => {
  const f = fixture(),
    trace = f.traces[0];
  Object.assign(trace, {
    strict_trace: "failed",
    error_spans: 1,
    inspector_diagnostics: {
      strict_trace: "passed",
      warnings: [],
      warning_count: 0,
    },
    lifecycle_error_span_ids: ["prepare"],
    lifecycle_error_claims: [
      {
        trace_id: trace.trace_id,
        span_id: "prepare",
        reason: "skill-preparation-retry",
      },
    ],
  });
  assert.equal(implementation.healthPrivateAdmission(f).strict_exit, 2);
  assert.equal(implementation.healthPrivateAdmission(f).accepted_exit, 0);
  trace.lifecycle_error_claims[0].trace_id = "foreign";
  assert.equal(implementation.healthPrivateAdmission(f).accepted_exit, 1);
});
