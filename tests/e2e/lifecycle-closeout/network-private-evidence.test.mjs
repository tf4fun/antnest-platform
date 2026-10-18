import assert from "node:assert/strict";
import test from "node:test";
import {
  foundationConnectionFixture,
  principal,
} from "./foundation-connection.fixture.mjs";
const { openFoundationConnection } =
  await import("./foundation-connection.mjs");

const url = new URL("./network-private-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const phases = ["allowed", "held-a", "held-b", "denied", "restored", "private"];
const clean = {
  topology: "passed",
  strict_trace: "passed",
  error_spans: 0,
  warning_count: 0,
  warnings: [],
};
async function fixture(t) {
  assert.equal(typeof implementation.networkPrivateAdmission, "function");
  const f = await foundationConnectionFixture(t);
  f.release();
  const connections = [],
    probes = [];
  for (const [i, phase] of phases.entries()) {
    const agentId = phase === "held-b" ? "b" : "a";
    const client = f.register(
      await openFoundationConnection(agentId, f.browser, {
        ...f.options,
        preserve() {},
      }),
    );
    const input = { phase, nonce: String(i) };
    const sessionId = (
      await client.request(
        "new",
        { cwd: "/workspace", mcpServers: [] },
        15000,
        { phase },
      )
    ).sessionId;
    await client.request(
      "prompt",
      { sessionId, prompt: [{ type: "text", text: JSON.stringify(input) }] },
      65000,
      { kind: "ordinary", phase, toolName: "bash" },
    );
    await client.closeAndWait();
    connections.push(client.snapshot());
    probes.push({
      phase,
      agent_id: agentId,
      session_id: sessionId,
      run_id: `run-${i}`,
      connection_trace_id: client.connectionTraceID,
      input,
    });
  }
  let serial = 0;
  const requests = connections.flatMap((c, i) =>
    [c.initialization, ...c.evidence].map((r) => ({
      ...clean,
      trace_id: `request-${serial++}`,
      method: r.method,
      request_id: r.requestId,
      connection_trace_id: c.connectionTraceID,
      session_id: r.sessionId,
      runs: r.kind === "ordinary" ? 1 : 0,
      runtime_tool_calls: r.kind === "ordinary" ? 1 : 0,
      ...(r.kind === "ordinary" ? { run_id: probes[i].run_id } : {}),
      diagnostic_inventory_verified: true,
      raw_error_inventory: [],
      owned_error_spans: [],
    })),
  );
  const policies = [
    ["a", "allow_all"],
    ["b", "allow_all"],
    ["a", "deny_all"],
    ["a", "allow_all"],
  ].map(([agentID, action], i) => ({
    agentID,
    action,
    traceID: `policy-${i}`,
    status: 200,
    path: `/api/admin/agents/${agentID}/network-policy`,
    options: {
      method: "PUT",
      body: { action, expected_resource_version: i + 1 },
      headers: {
        "Idempotency-Key": `key-${i}`,
        "X-Antnest-Expected-Principal": encodeURIComponent(
          JSON.stringify(["organization", "admin"]),
        ),
      },
    },
    response: { action, resource_version: i + 2 },
  }));
  return {
    profile: "lifecycle-real-network",
    agents: 2,
    operations: 4,
    model_requests: 12,
    completed_runs: 6,
    old_connection_revoked: true,
    other_agent_same_connection_preserved: true,
    unsolicited_denied_push_blocked: true,
    runtime_unchanged: true,
    deleted_before_teardown: true,
    runtimes_cleanly_exited: 2,
    trace_producers_stopped: 7,
    private_cleanup_completed: true,
    private_connections: connections,
    private_collection_errors: [],
    private_network: {
      principal,
      creation_principal: encodeURIComponent(
        JSON.stringify(["organization", "admin"]),
      ),
      agents: ["a", "b"].map((id) => ({
        id,
        initial: { agent: { agent_id: id, owner_user_id: "owner" } },
      })),
      probes,
      held: ["before-deny", "after-stale-cas"].map((phase) => ({
        phase,
        probes: probes.slice(1, 3).map((p) => ({
          phase: p.phase,
          agent_id: p.agent_id,
          session_id: p.session_id,
          connection_trace_id: p.connection_trace_id,
          settled: false,
        })),
      })),
      provider_requests: probes.flatMap((p, i) =>
        ["tool", "reply"].map((stage) => ({
          phase: p.phase,
          stage,
          trace_id: requests[i * 3 + 2].trace_id,
        })),
      ),
      policies,
      stale_cas: {
        path: policies[1].path,
        status: 409,
        options: {
          ...structuredClone(policies[1].options),
          body: {
            action: "deny_all",
            expected_resource_version:
              policies[1].response.resource_version - 1,
          },
          headers: {
            ...policies[1].options.headers,
            "Idempotency-Key": "new-stale-key",
          },
        },
        response: { code: "resource_version_conflict" },
      },
      replay: {
        path: policies[2].path,
        options: structuredClone(policies[2].options),
        status: 200,
        response: structuredClone(policies[2].response),
      },
    },
    request_traces: requests,
    policy_traces: [
      ["a", "allow_all"],
      ["b", "allow_all"],
      ["a", "deny_all"],
      ["a", "allow_all"],
    ].map(([agent_id, action], i) => ({
      ...clean,
      trace_id: `policy-${i}`,
      agent_id,
      action,
    })),
    traces: [
      ["a", "create"],
      ["b", "create"],
      ["a", "delete"],
      ["b", "delete"],
    ].map(([agent_id, kind], i) => ({
      ...clean,
      trace_id: `lifecycle-${i}`,
      request_id: `lifecycle-request-${i}`,
      agent_id,
      kind,
    })),
  };
}

test("Network gate binds six initialized connections, all original Runs/Providers and independent lifecycle/policy evidence", async (t) => {
  const report = await fixture(t);
  const provider = report.private_network.provider_requests;
  [provider[3], provider[4]] = [provider[4], provider[3]];
  const result = implementation.networkPrivateAdmission(report);
  assert.deepEqual(result.inventory, {
    connections: 6,
    initializations: 6,
    business_requests: 12,
    runs: 6,
    provider_requests: 12,
    runtime_tool_calls: 6,
    policy_writes: 4,
    lifecycle_admissions: 4,
  });
  assert.equal(result.strict_exit, 0);
  assert.equal(result.accepted_exit, 0);
});
for (const [name, mutate] of [
  ["missing initialization", (r) => r.request_traces.shift()],
  [
    "duplicate initialize",
    (r) =>
      r.private_connections[0].requests.push(
        r.private_connections[0].requests[0],
      ),
  ],
  [
    "foreign owner",
    (r) =>
      (r.private_network.principal = {
        ...r.private_network.principal,
        user_id: "admin",
      }),
  ],
  [
    "foreign organization",
    (r) =>
      (r.private_network.principal = {
        ...r.private_network.principal,
        organization_id: "other",
      }),
  ],
  [
    "foreign session",
    (r) => (r.private_network.probes[0].session_id = "other"),
  ],
  ["foreign wire request", (r) => (r.request_traces[2].request_id = "other")],
  [
    "foreign trace connection",
    (r) => (r.request_traces[2].connection_trace_id = "other"),
  ],
  ["foreign trace session", (r) => (r.request_traces[2].session_id = "other")],
  ["foreign Run", (r) => (r.request_traces[2].run_id = "other")],
  [
    "duplicate Run",
    (r) =>
      (r.private_network.probes[1].run_id = r.private_network.probes[0].run_id),
  ],
  [
    "foreign Provider",
    (r) => (r.private_network.provider_requests[0].trace_id = "other"),
  ],
  ["missing Provider", (r) => r.private_network.provider_requests.pop()],
  [
    "serialized held requests",
    (r) => (r.private_network.held[0].probes[0].settled = true),
  ],
  [
    "foreign held connection",
    (r) => (r.private_network.held[1].probes[0].connection_trace_id = "other"),
  ],
  ["missing stale CAS observation", (r) => r.private_network.held.pop()],
  ["missing stale CAS", (r) => delete r.private_network.stale_cas],
  ["stale CAS non-409", (r) => (r.private_network.stale_cas.status = 200)],
  [
    "stale CAS reused key",
    (r) =>
      (r.private_network.stale_cas.options.headers["Idempotency-Key"] =
        r.private_network.policies[1].options.headers["Idempotency-Key"]),
  ],
  [
    "stale CAS current version",
    (r) => r.private_network.stale_cas.options.body.expected_resource_version++,
  ],
  ["missing replay", (r) => delete r.private_network.replay],
  [
    "changed replay key",
    (r) =>
      (r.private_network.replay.options.headers["Idempotency-Key"] = "other"),
  ],
  [
    "changed replay body",
    (r) => (r.private_network.replay.options.body.action = "allow_all"),
  ],
  [
    "changed replay response",
    (r) => r.private_network.replay.response.resource_version++,
  ],
  ["missing policy", (r) => r.policy_traces.pop()],
  ["foreign policy", (r) => (r.policy_traces[2].agent_id = "b")],
  ["missing lifecycle", (r) => r.traces.pop()],
  ["unjoined client", (r) => (r.private_connections[0].closed = false)],
  ["unfinished exporter", (r) => (r.private_cleanup_completed = false)],
  [
    "trace archive error",
    (r) => r.private_collection_errors.push("original archive failure"),
  ],
  [
    "foreign prompt input",
    (r) => (r.private_network.probes[0].input.nonce = "other"),
  ],
  ["extra trace", (r) => r.request_traces.push(r.request_traces[0])],
])
  test(`Network gate rejects ${name}`, async (t) => {
    const report = await fixture(t);
    mutate(report);
    assert.throws(() => implementation.networkPrivateAdmission(report));
  });

test("Network preserves reviewed diagnostics as strict failures and rejects unknown/busy allowances", async (t) => {
  const report = await fixture(t),
    trace = report.request_traces[0];
  const error = { trace_id: trace.trace_id, span_id: "diagnostic" };
  Object.assign(trace, {
    strict_trace: "failed",
    error_spans: 1,
    raw_error_inventory: [error],
    owned_error_spans: [
      { ...error, reason: "completed-initialize-mcp-read-disconnect" },
    ],
  });
  assert.equal(implementation.networkPrivateAdmission(report).strict_exit, 2);
  assert.equal(implementation.networkPrivateAdmission(report).accepted_exit, 0);
  for (const reason of ["unknown-internal-error", "managed-busy-rejection"]) {
    trace.owned_error_spans[0].reason = reason;
    assert.equal(
      implementation.networkPrivateAdmission(report).accepted_exit,
      1,
    );
  }
  trace.owned_error_spans[0].reason =
    "completed-initialize-mcp-read-disconnect";
  report.policy_traces[0].error_spans = 1;
  report.policy_traces[0].strict_trace = "failed";
  assert.equal(implementation.networkPrivateAdmission(report).accepted_exit, 1);
});

test("Network public summary excludes original raw bodies and identity receipts", async (t) => {
  const report = await fixture(t),
    before = structuredClone(report);
  const result = implementation.networkPublicResult(report);
  for (const key of [
    "private_connections",
    "private_network",
    "private_collection_errors",
  ])
    assert.equal(result[key], undefined);
  assert.deepEqual(report, before);
  assert.deepEqual(result.request_traces, report.request_traces);
});

test("Network accepts an unchanged initial policy assignment and rejects unrelated version advancement", async (t) => {
  const report = await fixture(t),
    first = report.private_network.policies[0];
  first.response.resource_version =
    first.options.body.expected_resource_version;
  assert.equal(implementation.networkPrivateAdmission(report).accepted_exit, 0);
  first.response.resource_version += 2;
  assert.throws(() => implementation.networkPrivateAdmission(report));
});
