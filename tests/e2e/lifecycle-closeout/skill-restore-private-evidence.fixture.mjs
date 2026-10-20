import { createHash } from "node:crypto";
import {
  foundationConnectionFixture,
  principal,
  setup,
} from "./foundation-connection.fixture.mjs";
import { stage4Databases as databases } from "./restore-evidence.mjs";
import { restoreTransportFixture } from "./restore-private-transport.fixture.mjs";
const { openFoundationConnection } =
  await import("./foundation-connection.mjs");
const clean = {
  topology: "passed",
  strict_trace: "passed",
  error_spans: 0,
  warning_count: 0,
  warnings: [],
};

export async function skillRestorePrivateEvidenceFixture(t) {
  const f = await foundationConnectionFixture(t);
  f.release();
  const states = ["agent", "peer", "agent", "peer"].map((agent, n) => ({
    agent: {
      agent_id: agent,
      owner_user_id: principal.user_id,
      executable_execution_revision: "revision-" + n,
    },
    container: { Id: "runtime-" + n },
    volume: "workspace-" + agent,
    skillVolume: "skills-" + agent,
  }));
  const connections = [],
    logins = [],
    delegations = [];
  const open = async (n, agent = "agent") => {
    f.browser.cookies.set("antnest_session", "restore-session-" + n);
    const session_digest = createHash("sha256")
      .update(f.browser.accessToken)
      .digest("hex");
    if (!logins[n - 1])
      logins.push({
        principal,
        status: 200,
        trace_id: String(n).repeat(32),
        session_digest,
      });
    const client = f.register(
      await openFoundationConnection(agent, f.browser, {
        ...f.options,
        preserve() {},
      }),
    );
    delegations.push({
      login_index: n - 1,
      session_digest,
      connection_trace_id: client.connectionTraceID,
    });
    return client;
  };
  const prompt = (client, sessionId, phase, toolName) =>
    client.request(
      "prompt",
      {
        sessionId,
        prompt: [{ type: "text", text: phase }],
      },
      60000,
      { kind: "ordinary", phase, toolName },
    );
  let client = await open(1);
  const session = (await client.request("new", setup)).sessionId;
  const untouched = (await client.request("new", setup)).sessionId;
  await prompt(client, session, "c5-before-backup", "bash");
  await client.request("load", { sessionId: session, ...setup });
  await client.closeAndWait();
  connections.push(client.snapshot());
  client = await open(2);
  await client.request("load", { sessionId: session, ...setup });
  await prompt(client, untouched, "c5-after-restore", "read");
  await client.closeAndWait();
  connections.push(client.snapshot());
  const sessions = [session, untouched];
  for (const [agent, phase] of [
    ["peer", "c5-after-restore-peer"],
    ["agent", "c5-after-peer-volume-loss"],
  ]) {
    client = await open(2, agent);
    const sessionId = (await client.request("new", setup)).sessionId;
    sessions.push(sessionId);
    await prompt(client, sessionId, phase, "read");
    await client.closeAndWait();
    connections.push(client.snapshot());
  }
  const runs = [0, 2, 3, 2].map((stateIndex, i) => ({
    run_id: "run-" + i,
    agent_id: states[stateIndex].agent.agent_id,
    session_id: sessions[i],
    state: "completed",
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state: "settled",
    execution_snapshot: {
      executionRevision: states[stateIndex].agent.executable_execution_revision,
    },
  }));
  let serial = 0;
  const requests = connections.flatMap((connection, i) =>
    [connection.initialization, ...connection.evidence].map((row) => ({
      ...clean,
      trace_id: (++serial).toString(16).padStart(32, "a"),
      method: row.method,
      request_id: row.requestId,
      connection_trace_id: connection.connectionTraceID,
      session_id: row.sessionId,
      runs: row.kind === "ordinary" ? 1 : 0,
      runtime_tool_calls: row.kind === "ordinary" ? 1 : 0,
      ...(row.kind === "ordinary" ? { run_id: runs[i].run_id } : {}),
      diagnostic_inventory_verified: true,
      raw_error_inventory: [],
      owned_error_spans: [],
    })),
  );
  const models = connections.map((connection) =>
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
  const lifecycle = [
    ["agent", "create"],
    ["peer", "create"],
    ["agent", "disable"],
    ["peer", "disable"],
    ["agent", "enable"],
    ["peer", "enable"],
    ["peer", "disable"],
    ["agent", "delete"],
    ["peer", "delete"],
  ].map(([agentID, kind], i) => ({
    kind,
    agentID,
    requestID: "request-" + i,
    traceID: "trace-" + i,
  }));
  const history = [
    {
      sessionId: session,
      update: {
        sessionUpdate: "tool_call",
        text: "c5-before-backup completed",
      },
    },
  ];
  const transport = restoreTransportFixture();
  const plan = {
    databases,
    volumes: [
      "workspace-agent",
      "workspace-peer",
      "skills-agent",
      "skills-peer",
      "retained-skill-set",
    ],
  };
  const key = "original-enable-key",
    requestID =
      "lifecycle-" +
      createHash("sha256")
        .update(principal.organization_id + "\0" + key)
        .digest("hex");
  return {
    peer_agent_id: "peer",
    restored_preset_skill: "skill",
    registry_offline_enable: true,
    restored_agents: 2,
    independent_skill_volumes: true,
    offline_missing_skill_volume_blocked: true,
    unaffected_peer_run: true,
    profile: "offline-skill-restore",
    project: transport.project,
    agent_id: "agent",
    operations: 9,
    completed_runs: 4,
    model_requests: 8,
    restored_tool_calls: 3,
    history_events: history.length,
    history_replay_model_calls: 0,
    event_history_preserved: true,
    execution_audits_preserved: true,
    deleted_before_teardown: true,
    original_acp_ciphertext_read: true,
    file_metadata_preserved: true,
    database_count: 8,
    persistent_volumes: 5,
    encryption_keys: 3,
    database_fingerprints: Object.fromEntries(
      databases.map((db) => [db, "a".repeat(64)]),
    ),
    replaced_postgres: true,
    permission_drift_probes: 2,
    private_cleanup_completed: true,
    private_collection_errors: [],
    private_connections: connections,
    private_skill_restore: {
      frozen_skill: { skill_id: "skill", version: 1 },
      skill_files: states.map((s) => ({
        agent_id: s.agent.agent_id,
        container_id: s.container.Id,
        volume: s.skillVolume,
        path: "/skills/code-review/SKILL.md",
        content: "Stage 4 immutable preset version 1.",
      })),
      recovery_before: plan,
      recovery_after: structuredClone(plan),
      registry_stopped: [
        {
          Id: "registry",
          Config: {
            Labels: {
              "com.docker.compose.project": transport.project,
              "com.docker.compose.service": "skill-registry",
            },
          },
          State: {
            Running: false,
            Status: "exited",
            ExitCode: 0,
            OOMKilled: false,
            Error: "",
          },
        },
      ],
      blocked_enable: {
        request: {
          agent_id: "peer",
          method: "POST",
          path: "/api/admin/agents/peer/enable",
          body: "{}",
          idempotency_key: key,
          timeout_ms: 5000,
        },
        outcome: "http",
        status: 503,
        trace_id: "c".repeat(32),
        raw_text: JSON.stringify({
          code: "dependency_unavailable",
          retryable: true,
        }),
      },
      missing_volume: {
        queries: [
          {
            request: {
              method: "GET",
              path: "/api/admin/agent-skill-preparations/by-idempotency-key",
              idempotency_key: key,
            },
            status: 200,
            trace_id: "d".repeat(32),
            body: {
              request_id: requestID,
              agent_id: "peer",
              kind: "enable",
              state: "retry_wait",
              error_code: "skill_preparation_unavailable",
            },
          },
        ],
        agent: { agent_id: "peer", activation_state: "disabled" },
        resources: { containers: [], volumes: ["workspace-peer"] },
        volume_query: { name: "skills-peer", lines: [] },
      },
      creation_principal: encodeURIComponent(
        JSON.stringify([principal.organization_id, "admin"]),
      ),
      logins,
      delegations,
      states,
      runs,
      preserved_runs: Array.from({ length: 3 }, () => structuredClone(runs[0])),
      histories: [history, structuredClone(history)],
      before_model: models[0],
      after_model: models.slice(1).flat(),
      provider_requests: models.flat(),
      lifecycle_admissions: lifecycle,
      pre_restore_connections: [structuredClone(connections[0])],
      transport_before: transport,
      transport_after: structuredClone(transport),
    },
    request_traces: requests,
    traces: lifecycle.map((row) => ({
      ...clean,
      kind: row.kind,
      agent_id: row.agentID,
      request_id: row.requestID,
      trace_id: row.traceID,
    })),
  };
}
