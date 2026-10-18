import { fields } from "../observability/trace-fixtures.mjs";
import { applicationServices } from "./deployment.mjs";

export const stateWatchPath = "/rpc/agent-acp/watch-agent-execution-state";
export function shutdownPrivateTraceFixture(traceID = "a".repeat(32)) {
  const clientID = "b".repeat(16),
    serverID = "c".repeat(16);
  const state = {
    agent_id: "agent",
    access_allowed: true,
    configuration_revision: "d".repeat(64),
    availability: "ready",
    active_session_id: null,
    unavailable_reason: null,
  };
  const terminal = {
    code: "execution_state_unavailable",
    message: "Agent execution state is unavailable",
    retryable: true,
  };
  const raw = Buffer.from(
    `event: workspace_state\ndata: ${JSON.stringify(state)}\n\nevent: workspace_error\ndata: ${JSON.stringify(terminal)}\n\n`,
  );
  const before = [...applicationServices, "temporal", "postgres"].map(
    (name) => ({
      id: name + "-container",
      name,
      project: "shutdown-fixture",
      image: "sha256:" + "1".repeat(64),
      hostname: name + "-host",
      running: true,
      health: "healthy",
      exit: 0,
      oom: false,
      error: "",
      started: new Date(0).toISOString(),
      finished: new Date(0).toISOString(),
      ...(name === "agent-acp-service"
        ? {
            process: {
              pid: 1,
              hostname: name + "-host",
              argv: ["node", "dist/main.js"],
            },
          }
        : {}),
    }),
  );
  const after = before.map((row) => ({
    ...row,
    running: false,
    finished: new Date(2400).toISOString(),
  }));
  const principal = { organization_id: "organization", user_id: "owner" };
  const receipt = {
    agentId: "agent",
    principal,
    session_digest: "e".repeat(64),
    method: "POST",
    path: stateWatchPath,
    request_body: {},
    traceID,
    clientSpanID: clientID,
    status: 200,
    content_type: "text/event-stream",
    response_trace_id: null,
    events: [state],
    terminal_events: [terminal],
    closure: {
      kind: "transport-end",
      traceID,
      clientSpanID: clientID,
      observedAt: 2401,
      receivedEvents: 1,
    },
    body_outcome: "eof",
    body_bytes: raw.length,
    raw_body_base64: raw.toString("base64"),
    joined: true,
    errors: [],
  };
  const trace = {
    traceID,
    processes: {
      host: {
        serviceName: "antnest-private-acp-client",
        tags: fields({
          "host.name": "test-host",
          "process.pid": 99,
          "service.instance.id": "test-host:99",
        }),
      },
      acp: {
        serviceName: "agent-acp-service",
        tags: fields({
          "host.name": "agent-acp-service-host",
          "process.pid": 1,
          "service.instance.id": "agent-acp-service-host:1",
        }),
      },
    },
    spans: [],
  };
  const span = (
    spanID,
    processID,
    operationName,
    parent,
    startTime,
    duration,
    tags,
  ) => ({
    traceID,
    spanID,
    processID,
    operationName,
    startTime,
    duration,
    references: parent
      ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
      : [],
    tags: fields(tags),
    logs: [],
  });
  const client = span(
    clientID,
    "host",
    "HTTP POST agent-acp-workspace",
    undefined,
    1000000,
    1401000,
    {
      "span.kind": "client",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "http.response.body.size": raw.length,
      "antnest.protocol.version": "v1",
      "antnest.outcome": "eof",
      "antnest.http.body.outcome": "eof",
    },
  );
  const server = span(
    serverID,
    "acp",
    "HTTP POST " + stateWatchPath,
    clientID,
    1001000,
    1398000,
    {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": stateWatchPath,
      "http.response.status_code": 200,
      "rpc.service": "agent-acp",
      "rpc.method": "watch_agent_execution_state",
      "rpc.system.name": "json-over-http",
      "antnest.listener": "workspace",
      "antnest.agent.id": "agent",
      "antnest.organization.id": "organization",
      error: true,
      "otel.status_code": "ERROR",
      "error.type": "Error",
      "antnest.outcome": "error",
      "antnest.operation.phase": "agent.execution_state",
      "antnest.stream.termination": "process-shutdown",
    },
  );
  server.logs = [
    {
      timestamp: 2398000,
      fields: fields({
        event: "antnest.error",
        "antnest.error.stage": "agent.execution_state",
        "antnest.operation.phase": "agent.execution_state",
        "antnest.error.type": "Error",
        "antnest.error.message": "Error: unregistered message omitted",
        "antnest.error.cause_types": "[]",
        "antnest.error.causes": JSON.stringify([
          { type: "Error", message: "Error: unregistered message omitted" },
        ]),
      }),
    },
  ];
  const sql = span("f".repeat(16), "acp", "SELECT", serverID, 1002000, 1000, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.query.text": "SELECT $1",
  });
  const readiness = span(
    "7".repeat(16),
    "acp",
    "postgres.ready",
    serverID,
    1001100,
    500,
    {
      "span.kind": "internal",
      "db.system.name": "postgresql",
    },
  );
  const readinessSQL = span(
    "8".repeat(16),
    "acp",
    "SELECT",
    readiness.spanID,
    1001200,
    300,
    {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": "SELECT",
      "db.query.text": "SELECT 1",
    },
  );
  trace.spans.push(client, server, readiness, readinessSQL, sql);
  const expected = {
    kind: "private_state_watch",
    traceID,
    clientSpanID: clientID,
    agentID: "agent",
    principal: structuredClone(principal),
    session_digest: receipt.session_digest,
    receipt,
    closure: receipt.closure,
    stopWindow: { start: 1000, end: 3500 },
    stop: {
      liveAt: 1999,
      startedAt: 2000,
      completedAt: 2500,
      project: "shutdown-fixture",
      before,
      after,
    },
  };
  return {
    trace,
    expected,
    client,
    server,
    sql,
    receipt,
    readiness,
    readinessSQL,
  };
}
