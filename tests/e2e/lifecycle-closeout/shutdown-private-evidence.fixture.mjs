import { createHash } from "node:crypto";
import {
  foundationConnectionFixture,
  principal,
  setup,
} from "./foundation-connection.fixture.mjs";
import { shutdownPrivateTraceFixture } from "./shutdown-private-trace.fixture.mjs";
import { inspectShutdownPrivateWatchTrace } from "./shutdown-private-trace.mjs";
import { shutdownResolutionFixture } from "./shutdown-resolution-fixtures.mjs";
import {
  assertStopped,
  assertRestarted,
  inspectShutdownTrace,
} from "./shutdown-evidence.mjs";
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
export async function shutdownPrivateEvidenceFixture(
  t,
  { publicCancellation = false } = {},
) {
  const f = await foundationConnectionFixture(t, { emptySessions: true });
  const connections = [];
  let client = f.register(
    await openFoundationConnection("agent", f.browser, {
      ...f.options,
      preserve() {},
    }),
  );
  const { sessionId } = await client.request("new", setup);
  await client.closeAndWait();
  connections.push(client.snapshot());
  client = f.register(
    await openFoundationConnection("agent", f.browser, {
      ...f.options,
      preserve() {},
    }),
  );
  await client.request("load", { ...setup, sessionId });
  await client.closeAndWait();
  connections.push(client.snapshot());
  const session_digest = createHash("sha256")
      .update(f.browser.accessToken)
      .digest("hex"),
    transport = restoreTransportFixture();
  const privateTrace = shutdownPrivateTraceFixture("b".repeat(32));
  privateTrace.expected.session_digest = session_digest;
  privateTrace.receipt.session_digest = session_digest;
  privateTrace.expected.stop.project = transport.project;
  for (const row of [
    ...privateTrace.expected.stop.before,
    ...privateTrace.expected.stop.after,
  ])
    row.project = transport.project;
  const stateWatches = [
    privateTrace.receipt,
    structuredClone(privateTrace.receipt),
  ];
  const reopened = stateWatches[1];
  reopened.traceID = "4".repeat(32);
  reopened.clientSpanID = "5".repeat(16);
  reopened.terminal_events = [];
  reopened.closure = {
    kind: "local-close",
    traceID: reopened.traceID,
    clientSpanID: reopened.clientSpanID,
    observedAt: 4000,
    receivedEvents: 1,
  };
  reopened.body_outcome = "cancelled";
  const raw = Buffer.from(
    `event: workspace_state\ndata: ${JSON.stringify(reopened.events[0])}\n\n`,
  );
  reopened.raw_body_base64 = raw.toString("base64");
  reopened.body_bytes = raw.length;
  const publicTrace = shutdownResolutionFixture("rpc");
  if (publicCancellation)
    publicTrace.root.tags.push(
      { key: "error", value: true },
      { key: "otel.status_description", value: "handler_aborted" },
      { key: "antnest.http.request_cancelled", value: true },
    );
  publicTrace.expected.stop = structuredClone(privateTrace.expected.stop);
  const publicWatches = [
    {
      traceID: publicTrace.trace.traceID,
      events: [{ agent_id: "agent", sequence: 1 }],
      closure: publicTrace.expected.closure,
      joined: true,
      transport_diagnostics: [],
    },
    {
      traceID: "6".repeat(32),
      events: [{ agent_id: "agent", sequence: 1 }],
      closure: {
        kind: "local-close",
        traceID: "6".repeat(32),
        observedAt: 4000,
        receivedEvents: 1,
      },
      joined: true,
      transport_diagnostics: [],
    },
  ];
  const state = {
    agent: {
      agent_id: "agent",
      owner_user_id: principal.user_id,
      configuration: { model: "stable" },
      runtime: { id: "same-runtime" },
      executable_execution_revision: "same-execution",
    },
    container: {
      Id: "runtime",
      Image: "sha256:" + "9".repeat(64),
      State: { StartedAt: new Date(0).toISOString() },
      RestartCount: 0,
      Config: { Hostname: "runtime" },
      Mounts: [{ Destination: "/workspace", Name: "workspace" }],
    },
    volume: "workspace",
  };
  const stop = privateTrace.expected.stop,
    restarted = stop.after.map((row) => ({
      ...row,
      running: true,
      health: "healthy",
      started: new Date(3000).toISOString(),
    }));
  const remote = { code: 1001, reason: "", at: 2401, localClose: false };
  const lifecycle = ["create", "delete"].map((kind, i) => ({
    kind,
    agentID: "agent",
    requestID: "request-" + kind,
    traceID: String(i + 7).repeat(32),
  }));
  let index = 0;
  const requests = connections.flatMap((connection) =>
    [connection.initialization, ...connection.evidence].map((row) => ({
      ...clean,
      trace_id: (++index).toString(16).padStart(32, "f"),
      method: row.method,
      request_id: row.requestId,
      connection_trace_id: connection.connectionTraceID,
      session_id: row.sessionId,
      runs: 0,
      runtime_tool_calls: 0,
      diagnostic_inventory_verified: true,
      raw_error_inventory: [],
      owned_error_spans: [],
    })),
  );
  return {
    profile: "shutdown",
    project: transport.project,
    agent_id: "agent",
    operations: 2,
    stopped: assertStopped(stop.project, stop.before, stop.after),
    restarted: assertRestarted(stop.project, stop.before, restarted),
    restarted_inventory: restarted,
    stop_window: privateTrace.expected.stopWindow,
    stop_observation: stop,
    acp_remote_close: remote,
    temporal_membership: {
      initial: { address: "127.0.0.1", roles: 4, bootstrap_retries: 0 },
      restarted: { address: "127.0.0.1", roles: 4, bootstrap_retries: 0 },
    },
    watch_closures: [publicWatches[0].closure, privateTrace.receipt.closure],
    watches_closed_by_server: 2,
    acp_close_code: 1001,
    same_session_recovered: true,
    workspace: "retained",
    runtime: "unchanged",
    execution_audits: 0,
    model_requests: 0,
    event_history_preserved: true,
    deleted_before_teardown: true,
    private_cleanup_completed: true,
    private_collection_errors: [],
    private_connections: connections,
    private_state_watches: stateWatches,
    request_traces: requests,
    watch_traces: [
      {
        ...inspectShutdownTrace(publicTrace.trace, publicTrace.expected, []),
        topology: "passed",
        kind: "event_watch",
      },
      inspectShutdownPrivateWatchTrace(
        privateTrace.trace,
        privateTrace.expected,
        [],
      ),
    ],
    traces: lifecycle.map((row) => ({
      ...clean,
      kind: row.kind,
      agent_id: row.agentID,
      request_id: row.requestID,
      trace_id: row.traceID,
    })),
    private_shutdown: {
      platform_inventory: structuredClone({
        initial: stop.before,
        stopped: stop.after,
        restarted,
      }),
      workspace: {
        path: "/workspace/.c5-stop-sentinel",
        before: "original-workspace-bytes",
        after: "original-workspace-bytes",
      },
      deletion: {
        resources: { containers: [], volumes: [] },
        agent: { agent_id: "agent", lifecycle_state: "deleted" },
      },
      membership_logs: Object.fromEntries(
        ["initial", "restarted"].map((phase) => [
          phase,
          [6933, 6934, 6935, 6939]
            .map((port) =>
              JSON.stringify({
                msg: "Membership heartbeat upserted successfully",
                address: "127.0.0.1",
                port,
              }),
            )
            .join("\n"),
        ]),
      ),
      remote_acp_connection: connections[0].connectionTraceID,
      creation_principal: encodeURIComponent(
        JSON.stringify([principal.organization_id, "admin"]),
      ),
      logins: [
        { status: 200, trace_id: "9".repeat(32), principal, session_digest },
      ],
      delegations: [
        { kind: "state", trace_id: stateWatches[0].traceID },
        { kind: "acp", trace_id: connections[0].connectionTraceID },
        { kind: "acp", trace_id: connections[1].connectionTraceID },
        { kind: "state", trace_id: stateWatches[1].traceID },
      ].map((row) => ({ ...row, principal, session_digest })),
      states: [state, structuredClone(state)],
      histories: [
        { events: [{ agent_id: "agent", sequence: 1 }] },
        { events: [{ agent_id: "agent", sequence: 1 }] },
      ],
      idle: [0, 1].map(() => ({
        audits: { items: [], next_cursor: null },
        model: { requests: [], errors: [] },
      })),
      final_model: { requests: [], errors: [] },
      public_watches: publicWatches,
      lifecycle_admissions: lifecycle,
      transport_before: transport,
      transport_after: structuredClone(transport),
      stop,
      stop_window: privateTrace.expected.stopWindow,
      remote_acp_close: remote,
    },
  };
}
