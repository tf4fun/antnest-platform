import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { workspaceBusinessFixture } from "./protocol-business.fixture.mjs";
import { workspaceProtocolBusiness } from "./protocol-business.mjs";
import { workspaceStateTraceFixture } from "./private-http-trace.fixture.mjs";
import { workspaceAuthorityTraceFixture } from "./private-authority-trace.fixture.mjs";

const clone = (value) => structuredClone(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const traceID = (value) => value.toString(16).padStart(32, "0");
const spanID = (value) => value.toString(16).padStart(16, "0");
const requestKey = (row) => `${row.connectionTraceID}/${row.requestId}`;
const annotationFields = new Set([
  "connectionTraceID",
  "requestId",
  "method",
  "sessionId",
  "kind",
  "phase",
  "toolName",
  "rejection",
  "runId",
  "run",
  "runtime",
  "probe",
  "label",
]);
const frame = (state) =>
  "event: workspace_state\ndata: " + JSON.stringify(state) + "\n\n";

// This is a structural inventory-gate fixture, not production Trace evidence.
// Its diagnostic claims, hashes and three-sample receipts are controlled JSON;
// no Jaeger queries, archive files, CLIENT exports or owning Trace gates run.
export async function workspacePrivateEvidenceFixture() {
  const f = workspaceBusinessFixture();
  const owner = f.work.owner();
  const principal = { organization_id: "org", user_id: "owner" };
  const sessionDigest = hash(owner.accessToken);
  const logins = [],
    bindings = [];
  let initialAgent;
  const login = f.work.login;
  f.work.login = (browser, response, agent, agentID) => {
    const result = login(browser, response, agent, agentID);
    initialAgent = clone(agent);
    logins.push({
      status: response.status,
      trace_id: response.traceID,
      principal: clone(result),
      session_digest: sessionDigest,
    });
    return result;
  };
  const binding = f.work.binding;
  f.work.binding = async (observed) => {
    const result = await binding(observed);
    const generation = Number(
      observed.container.Config.Labels["io.antnest.runtime-generation"],
    );
    bindings.push({
      observed: clone(observed),
      status: {
        agent_id: "agent",
        generation,
        execution_id: `process-${generation}`,
        status: "ready",
        test_features: [],
      },
      binding: clone(result),
    });
    return result;
  };
  const businessResult = await workspaceProtocolBusiness(f.input, f.work);
  const held = await Promise.all(f.state.held);
  const observations = f.observations.map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .filter(([field]) => annotationFields.has(field))
        .map(([field, value]) => [field, clone(value)]),
    ),
  );
  const annotations = new Map(
    observations.map((row) => [requestKey(row), row]),
  );
  const requestIDs = new Map(
    f.requests.map((row, index) => [requestKey(row), traceID(0x1000 + index)]),
  );
  const phaseIDs = new Map(
    observations
      .filter((row) => row.phase)
      .map((row) => [row.phase, requestIDs.get(requestKey(row))]),
  );
  function rebindProviders(value) {
    if (!value || typeof value !== "object") return;
    if (phaseIDs.has(value.phase) && typeof value.model_span_id === "string")
      value.trace_id = phaseIDs.get(value.phase);
    for (const child of Object.values(value)) rebindProviders(child);
  }
  function completeEvents(value) {
    if (!value || typeof value !== "object") return;
    if (value.event_type === "agent_owner_revoked") {
      value.agent_id = "agent";
    }
    if (value.event_type === "agent_disabled") {
      value.agent_id = "agent";
    }
    for (const child of Object.values(value)) completeEvents(child);
  }
  const business = clone(f.state.business);
  const providers = clone(f.state.providers);
  const offboarding = clone(f.state.offboarding);
  rebindProviders(business);
  rebindProviders(providers);
  completeEvents(business);
  completeEvents(offboarding);

  function rawRow(original) {
    const row = {
      boundary: "private-acp",
      transport: "websocket",
      protocolVersion: 1,
      agentId: "agent",
      connectionTraceID: original.connectionTraceID,
      clientSpanID: original.clientSpanID,
      method: original.method,
      requestId: original.requestId,
      inputSessionID: original.inputSessionID,
      outcome: original.outcome === "completed" ? "succeeded" : "failed",
    };
    if (original.method === "initialize") {
      row.initializationResult = clone(original.requestResult);
      return row;
    }
    row.sessionId = original.sessionId;
    row.requestParams = clone(original.requestParams);
    if (row.outcome === "succeeded")
      row.requestResult = clone(original.requestResult);
    else {
      row.failure =
        original.failure ?? `Error: ${original.response.error.message}`;
      if (original.rejectionReceipt) {
        row.rejectionReceipt = clone(original.rejectionReceipt);
        row.failureCode = original.response.error.code;
        row.failureData = clone(original.response.error.data);
      }
    }
    return row;
  }
  const notifications = f.clients.flatMap((client) =>
    client.notificationReceipts.map((row) => ({
      boundary: "private-acp",
      transport: "websocket",
      protocolVersion: 1,
      ...clone(row),
      version: 1,
    })),
  );
  const connections = f.clients.map((client) => {
    const rows = client.requests.map(rawRow);
    const close =
      client.index === 5
        ? clone(client.snapshot().close_receipt)
        : {
            code: 1000,
            reason: "",
            at: 1000 + client.index,
            localClose: true,
          };
    const disconnects = client.disconnectReceipts.map((receipt) => {
      const row = rows.find((item) => item.requestId === receipt.requestId);
      return {
        boundary: row.boundary,
        transport: row.transport,
        protocolVersion: row.protocolVersion,
        agentId: row.agentId,
        connectionTraceID: row.connectionTraceID,
        clientSpanID: row.clientSpanID,
        requestId: row.requestId,
        method: row.method,
        inputSessionID: row.inputSessionID,
        sessionId: row.sessionId,
        phase: receipt.phase,
        started_at: close.at - 1,
        close: clone(close),
        original_local_close_error: true,
        response_absent: true,
      };
    });
    return {
      agentId: "agent",
      version: 1,
      connectionTraceID: client.connectionTraceID,
      clientSpanID: client.clientSpanID,
      closed: client.closed,
      evidence_errors: [],
      initialization: rows[0],
      evidence: rows.slice(1),
      requests: rows.map((row) => ({
        requestId: row.requestId,
        method: row.method,
        ...(row.inputSessionID !== null
          ? { sessionId: row.inputSessionID }
          : {}),
      })),
      raw_frames: [
        ...client.requests
          .filter((row) => row.response)
          .map((row) => clone(row.response)),
        ...client.updates.map((update) => ({
          method: "session/update",
          params: clone(update),
        })),
      ],
      updates: clone(client.updates),
      notifications: notifications
        .filter((row) => row.connectionTraceID === client.connectionTraceID)
        .map(clone),
      deliberate_disconnects: disconnects,
      close_receipt: close,
    };
  });

  const watchWindows = [];
  const stateWatches = f.watches.map((watch, index) => {
    const remote = index === 1;
    const receipt = clone(
      workspaceStateTraceFixture(
        "private_state_watch",
        remote ? "revocation" : "local-close",
      ).receipt,
    );
    Object.assign(receipt, {
      agentId: "agent",
      principal: clone(principal),
      session_digest: sessionDigest,
      traceID: watch.traceID,
      clientSpanID: watch.clientSpanID,
      events: clone(watch.states),
      closure: {
        ...clone(watch.closure),
        clientSpanID: watch.clientSpanID,
        receivedEvents: watch.states.length,
      },
      joined: watch.closed,
      body_outcome: watch.bodyOutcome,
      terminal_events: [],
      errors: [],
    });
    if (remote) receipt.revocation_start = clone(f.state.revocationBegin);
    else receipt.revocation_start = null;
    const raw = Buffer.from(receipt.events.map(frame).join(""));
    receipt.raw_body_base64 = raw.toString("base64");
    receipt.body_bytes = raw.length;
    watchWindows.push({
      traceID: watch.traceID,
      mode: remote ? "revocation" : "local-close",
      window: remote
        ? {
            start: receipt.revocation_start.observedAt,
            end: receipt.closure.observedAt + 1,
          }
        : clone(watch.stopWindow),
      ...(remote
        ? {
            revocationStart: clone(receipt.revocation_start),
            revocationTraceID: f.state.revocation.traceID,
          }
        : {}),
    });
    return receipt;
  });
  const stateReceipt = clone(
    workspaceStateTraceFixture("private_state").receipt,
  );
  const initialState = clone(f.watches[0].states[0]);
  const stateRaw = Buffer.from(JSON.stringify(initialState));
  Object.assign(stateReceipt, {
    agentId: "agent",
    principal: clone(principal),
    session_digest: sessionDigest,
    traceID: traceID(0x2000),
    clientSpanID: spanID(0x2000),
    raw_body_base64: stateRaw.toString("base64"),
    body_bytes: stateRaw.length,
  });

  let reportSequence = 0,
    spanSequence = 0x5000;
  function report(identity, claimReasons = [], transport = "http", sources) {
    const sequence = ++reportSequence;
    const owned = claimReasons.map((reason) => ({
      trace_id: identity.trace_id,
      span_id: spanID(++spanSequence),
      reason,
    }));
    const sourceIDs = [...new Set(sources ?? [identity.trace_id])].sort();
    const snapshotHash = hash(
      JSON.stringify({ structural_fixture: sourceIDs }),
    );
    return {
      topology: "passed",
      strict_trace: owned.length ? "failed" : "passed",
      error_spans: owned.length,
      warning_count: 0,
      warnings: [],
      diagnostic_inventory_verified: true,
      raw_error_inventory: owned.map(({ trace_id, span_id }) => ({
        trace_id,
        span_id,
      })),
      owned_error_spans: owned,
      neutral_diagnostics: [],
      time_observations: [],
      ...identity,
      complete_source_receipt: {
        version: 1,
        transport,
        stable_samples: 3,
        source_trace_ids: sourceIDs,
        source_snapshot_sha256: snapshotHash,
        samples: [1, 2, 3].map((attempt) => ({
          attempt,
          snapshot_sha256: snapshotHash,
          source_snapshot_sha256: snapshotHash,
          source_trace_ids: clone(sourceIDs),
          queries: sourceIDs.map((id, index) => {
            const raw = JSON.stringify({
              structural_fixture: true,
              trace_id: id,
            });
            return {
              attempt,
              url: `http://jaeger.fixture/api/traces/${id}`,
              file: `query-${String(sequence * 100 + attempt * 10 + index).padStart(4, "0")}.raw`,
              status: 200,
              outcome: "complete",
              body_complete: true,
              bytes: Buffer.byteLength(raw),
              sha256: hash(raw),
            };
          }),
        })),
      },
    };
  }
  const requestTraces = connections.flatMap((connection) =>
    [connection.initialization, ...connection.evidence].map((row) => {
      const note = annotations.get(requestKey(row));
      const phase = note?.phase;
      const rejection = row.rejectionReceipt?.code;
      const claims =
        phase === "c4-cancel"
          ? [
              "workspace-prompt-disconnect",
              "workspace-run-unresolved",
              ...Array(5).fill("workspace-tool-cancelled"),
            ]
          : phase === "c4-offline"
            ? ["workspace-prompt-disconnect"]
            : rejection
              ? Array(2).fill(
                  rejection === "agent_busy"
                    ? "managed-busy-rejection"
                    : rejection === "runtime_barrier_required"
                      ? "progress-barrier-rejection"
                      : "command-rejection",
                )
              : [];
      const id = requestIDs.get(requestKey(row));
      const result = report(
        {
          trace_id: id,
          kind:
            phase === "c4-cancel"
              ? "cancelled"
              : phase
                ? "ordinary"
                : "request",
          method: row.method,
          request_id: row.requestId,
          connection_trace_id: row.connectionTraceID,
          session_id: row.sessionId,
          agent_id: row.agentId,
          runs: phase ? 1 : 0,
          runtime_tool_calls: phase ? 1 : 0,
          model_requests: phase === "c4-cancel" ? 1 : phase ? 2 : 0,
          ...(phase ? { phase, run_id: note.runId, persistence: true } : {}),
          ...(phase && phase !== "c4-rebuilt"
            ? { disconnect_verified: true }
            : {}),
          ...(rejection
            ? {
                rejection,
                no_execution: true,
                ...(rejection === "runtime_barrier_required"
                  ? { barrier_rejection: true }
                  : {}),
              }
            : {}),
          source_trace_ids: [connection.connectionTraceID],
        },
        claims,
        "websocket",
        [id, connection.connectionTraceID],
      );
      delete result.topology;
      if (rejection === "runtime_barrier_required") {
        for (const key of [
          "runs",
          "runtime_tool_calls",
          "no_execution",
          "rejection",
        ])
          delete result[key];
        result.sql_spans = 5;
      } else if (rejection === "agent_busy") {
        delete result.model_requests;
        delete result.runtime_tool_calls;
      }
      return result;
    }),
  );
  const watchTraces = stateWatches.map((receipt, index) => {
    const result = report(
      {
        kind: "private_state_watch",
        trace_id: receipt.traceID,
        client_span_id: receipt.clientSpanID,
        server_span_id: spanID(++spanSequence),
        agent_id: "agent",
        sql_spans: 2,
        closure: clone(receipt.closure),
        remote_closure_verified: index === 1,
        source_trace_ids: [],
      },
      index === 0 ? ["workspace-private-watch-local-close"] : [],
    );
    if (index === 0) {
      result.server_span_id = result.owned_error_spans[0].span_id;
    }
    return result;
  });
  const stateTraces = [
    report({
      kind: "private_state",
      trace_id: stateReceipt.traceID,
      client_span_id: stateReceipt.clientSpanID,
      server_span_id: spanID(++spanSequence),
      agent_id: "agent",
      sql_spans: 2,
      source_trace_ids: [],
    }),
  ];

  const authorityScopes = [],
    authorityTraces = [];
  const resources = [
    ["state", 1, stateReceipt],
    ["watch", 1, stateWatches[0]],
    ["connection", 1, connections[0]],
    ["connection", 2, connections[1]],
    ["connection", 3, connections[2]],
    ["watch", 2, stateWatches[1]],
    ["connection", 4, connections[3]],
    ["connection", 5, connections[4]],
    ["denied-connection", 6, undefined],
  ];
  for (const [kind, index, resource] of resources) {
    const denied = kind === "denied-connection";
    const scope = {
      operation_id: authorityScopes.length + 1,
      kind,
      index,
    };
    const receipt = clone(
      workspaceAuthorityTraceFixture(denied ? 401 : 200).receipt,
    );
    const original = f.state.deniedConnections[0];
    Object.assign(receipt, {
      agentId: "agent",
      principal: clone(principal),
      session_digest: sessionDigest,
      traceID: denied ? original.traceID : traceID(0x3000 + scope.operation_id),
      clientSpanID: denied
        ? original.clientSpanID
        : spanID(0x3000 + scope.operation_id),
      request_body: { profile: "workspace", agent_id: "agent" },
    });
    const body = denied
      ? clone(original.body)
      : {
          caller_context: "workspace-cct-private-fixture",
          principal: clone(principal),
        };
    const raw = Buffer.from(JSON.stringify(body) + "\n");
    receipt.raw_body_base64 = raw.toString("base64");
    receipt.body_bytes = raw.length;
    if (denied) {
      receipt.request_started_at = original.startedAt;
      receipt.response_received_at = original.startedAt + 1;
      receipt.response_completed_at = original.startedAt + 2;
    }
    authorityScopes.push({ ...scope, receipts: [receipt] });
    if (resource) {
      resource.authority_scope = scope.operation_id;
      resource.authority = [clone(receipt)];
    }
    const result = report(
      {
        kind: "workspace_identity",
        trace_id: receipt.traceID,
        client_span_id: receipt.clientSpanID,
        server_span_id: spanID(++spanSequence),
        agent_id: "agent",
        status: receipt.status,
        sql_spans: 1,
        authority_scope: clone(scope),
        original_session_verified: true,
        source_trace_ids: [],
      },
      denied
        ? [
            "workspace-identity-denied-client",
            "workspace-identity-denied-server",
          ]
        : [],
    );
    if (denied) {
      result.raw_error_inventory[0].span_id = receipt.clientSpanID;
      result.owned_error_spans[0].span_id = receipt.clientSpanID;
      result.server_span_id = result.owned_error_spans[1].span_id;
    }
    authorityTraces.push(result);
  }
  const notificationTraces = notifications.map((receipt) =>
    report(
      {
        kind: "notification",
        trace_id: traceID(0x4000),
        method: receipt.method,
        agent_id: receipt.agentId,
        connection_trace_id: receipt.connectionTraceID,
        session_id: receipt.sessionId,
        notification_index: receipt.index,
        cancellation_requested: true,
        sql_spans: 5,
        model_requests: 0,
        source_trace_ids: [receipt.connectionTraceID],
      },
      [],
      "websocket",
      [traceID(0x4000), receipt.connectionTraceID],
    ),
  );
  for (const report of notificationTraces) delete report.topology;
  const lifecycle = f.state.lifecycle.map(({ expectation, ...row }, index) => ({
    ...clone(row),
    ...clone(expectation),
    ...(["create", "rebuild"].includes(row.kind)
      ? { skillPreparation: true }
      : {}),
    terminal: { request_id: row.requestID, kind: row.kind, state: "completed" },
    replayTraceID: traceID(0x6000 + index),
  }));
  const clean = {
    topology: "passed",
    strict_trace: "passed",
    error_spans: 0,
    warning_count: 0,
    warnings: [],
  };
  const result = {
    ...businessResult,
    profile: "workspace-protocol",
    project: f.input.config.project,
    agent_id: "agent",
    operations: lifecycle.length,
    completed_prompts: 2,
    cancel_recovery: "explicit_rebuild",
    private_cleanup_completed: true,
    private_collection_errors: [],
    private_connections: connections,
    private_state_watches: stateWatches,
    private_state_receipts: [stateReceipt],
    private_authority_receipts: authorityScopes,
    private_notifications: clone(notifications),
    private_disconnects: connections.flatMap((connection) =>
      clone(connection.deliberate_disconnects),
    ),
    request_traces: requestTraces,
    watch_traces: watchTraces,
    state_traces: stateTraces,
    authority_traces: authorityTraces,
    notification_traces: notificationTraces,
    offboarding_traces: [
      {
        ...clone(clean),
        kind: "disable",
        trace_id: offboarding.sourceID,
        source_trace_id: offboarding.sourceID,
        request_id: offboarding.requestID,
        agent_id: offboarding.agentID,
        settlement_outcome: offboarding.settlementOutcome,
        owner_revocation: clone(offboarding.ownerRevocation.event),
        disabled_event: clone(offboarding.disabledEvent),
        gateway_ancestry: true,
      },
    ],
    traces: lifecycle.map((row) => ({
      ...clone(clean),
      kind: row.kind,
      trace_id: row.traceID,
      request_id: row.requestID,
      agent_id: row.agentID,
      ...(row.settlementOutcome
        ? { settlement_outcome: row.settlementOutcome }
        : {}),
    })),
    private_workspace: {
      creation_principal: f.input.principal,
      logins,
      initial_agent: initialAgent,
      observations,
      bindings,
      business,
      watch_windows: watchWindows,
      denied_connections: [
        { agentID: "agent", after: f.state.revocationBegin.observedAt },
      ],
      offboarding: [offboarding],
      lifecycle_admissions: lifecycle,
      held_results: held.map((value) =>
        value.error
          ? { error: inspect(value.error, { depth: 8 }) }
          : { value: clone(value.value) },
      ),
      final_model: { requests: providers, errors: [] },
    },
  };
  Object.defineProperty(result, "workspaceErrors", { value: [] });
  delete result.offboarding_traces[0].topology;
  return result;
}
