import { createHash } from "node:crypto";
import {
  foundationConnectionFixture,
  principal,
  setup,
} from "./foundation-connection.fixture.mjs";
import { databases } from "./restore-evidence.mjs";
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

export async function restorePrivateEvidenceFixture(t) {
  const f = await foundationConnectionFixture(t);
  f.release();
  const states = [1, 2].map((n) => ({
    agent: {
      agent_id: "agent",
      owner_user_id: principal.user_id,
      executable_execution_revision: "revision-" + n,
    },
    container: { Id: "runtime-" + n },
    volume: "workspace",
  }));
  const connections = [],
    logins = [],
    delegations = [];
  const open = async (n) => {
    f.browser.cookies.set("antnest_session", "restore-session-" + n);
    const session_digest = createHash("sha256")
      .update(f.browser.accessToken)
      .digest("hex");
    logins.push({
      principal,
      status: 200,
      trace_id: String(n).repeat(32),
      session_digest,
    });
    const client = f.register(
      await openFoundationConnection("agent", f.browser, {
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
  const runs = states.map((state, i) => ({
    run_id: "run-" + i,
    agent_id: "agent",
    session_id: i ? untouched : session,
    state: "completed",
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state: "settled",
    execution_snapshot: {
      executionRevision: state.agent.executable_execution_revision,
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
  const lifecycle = ["create", "disable", "enable", "delete"].map((kind) => ({
    kind,
    agentID: "agent",
    requestID: "request-" + kind,
    traceID: "trace-" + kind,
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
  return {
    profile: "offline-restore",
    project: transport.project,
    agent_id: "agent",
    operations: 4,
    completed_runs: 2,
    model_requests: 4,
    restored_tool_calls: 1,
    history_events: history.length,
    history_replay_model_calls: 0,
    event_history_preserved: true,
    execution_audits_preserved: true,
    deleted_before_teardown: true,
    original_acp_ciphertext_read: true,
    file_metadata_preserved: true,
    database_count: 7,
    persistent_volumes: 2,
    encryption_keys: 3,
    database_fingerprints: Object.fromEntries(
      databases.map((db) => [db, "a".repeat(64)]),
    ),
    replaced_postgres: true,
    permission_drift_probes: 2,
    private_cleanup_completed: true,
    private_collection_errors: [],
    private_connections: connections,
    private_restore: {
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
      after_model: models[1],
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
