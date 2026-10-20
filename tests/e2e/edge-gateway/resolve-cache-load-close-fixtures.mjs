import { fields } from "../observability/trace-fixtures.mjs";
import { loadParticipantServices } from "./resolve-cache-owner-drain.mjs";

// Model the real protocol boundaries, independently of the inspector: the
// watch is cancelled before the UI starts its separate SDK close operation.
export function addLoadCleanup(f) {
  const instance = fields({ "service.instance.id": "fixture-original-acp" });
  const process = { serviceName: "agent-acp-service", tags: instance };
  for (const trace of f.traces.values())
    if (trace.processes.acp) trace.processes.acp = structuredClone(process);
  const first = f.traces.get(f.wire.requests[0].trace_id);
  const span = (
    trace,
    spanID,
    processID,
    operationName,
    startTime,
    duration,
    tags,
    references = [],
  ) => ({
    traceID: trace.traceID,
    spanID,
    processID,
    operationName,
    startTime,
    duration,
    tags: fields(tags),
    references,
    logs: [],
  });
  const health = {
    traceID: "e".repeat(32),
    processes: { acp: structuredClone(process) },
    spans: [],
  };
  health.spans.push(
    span(health, "health", "acp", "HTTP GET /status", 995000, 1000, {
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/status",
      "antnest.listener": "control",
      "http.response.status_code": 200,
    }),
  );
  const close = {
    traceID: "d".repeat(32),
    processes: {
      ui: { serviceName: "agent-ui" },
      acp: structuredClone(process),
    },
    spans: [],
  };
  close.spans.push(
    span(
      close,
      "close",
      "ui",
      "agent_ui.acp.close",
      7995000,
      25000,
      {
        "span.kind": "internal",
        "antnest.ui.acp.close.trigger": "requested",
        "antnest.ui.acp.close.outcome": "closed",
      },
      [{ refType: "FOLLOWS_FROM", traceID: first.traceID, spanID: "ui" }],
    ),
  );
  close.spans.push(
    span(
      close,
      "delete",
      "acp",
      "HTTP DELETE /v1/acp",
      8000000,
      10000,
      {
        "span.kind": "server",
        "http.request.method": "DELETE",
        "http.route": "/v1/acp",
        "antnest.listener": "workspace",
        "http.response.status_code": 202,
      },
      [{ refType: "CHILD_OF", traceID: close.traceID, spanID: "close" }],
    ),
  );
  for (const [id, method, route, ended, extra] of [
    ["private-get", "GET", "/v1/acp", 8011000, {}],
    [
      "private-watch",
      "POST",
      "/rpc/agent-acp/watch-agent-execution-state",
      7996000,
      {
        "rpc.system.name": "json-over-http",
        "rpc.service": "agent-acp",
        "rpc.method": "watch_agent_execution_state",
        "antnest.organization.id": "organization",
        "antnest.agent.id": f.agentID,
      },
    ],
  ]) {
    const start = first.spans.find((s) => s.spanID === "ui").startTime + 500;
    first.spans.push(
      span(
        first,
        id,
        "acp",
        `HTTP ${method} ${route}`,
        start,
        ended - start,
        {
          "span.kind": "server",
          "http.request.method": method,
          "http.route": route,
          "antnest.listener": "workspace",
          "http.response.status_code": 200,
          error: true,
          "otel.status_code": "ERROR",
          "error.type": "stream_interrupted",
          "antnest.outcome": "disconnected",
          ...extra,
        },
        [{ refType: "CHILD_OF", traceID: first.traceID, spanID: "ui" }],
      ),
    );
  }
  f.traces.set(health.traceID, health);
  f.traces.set(close.traceID, close);
  f.archivedTraceIDs.add(health.traceID);
  f.archivedTraceIDs.add(close.traceID);
  const baseline = {};
  const project = "fixture-owned-project";
  for (const [index, service] of loadParticipantServices.entries()) {
    const id = (index + 1).toString(16).repeat(64);
    baseline[service] = {
      id,
      service,
      project,
      image: "sha256:" + id,
      configuration_sha256: "a".repeat(64),
      restart_count: 0,
      running: true,
      restarting: false,
      oom_killed: false,
      exit_code: 0,
      health: "healthy",
      started_at: "2026-10-14T00:00:00Z",
      finished_at: "0001-01-01T00:00:00Z",
      at: 0,
      observed_at_ms: Date.parse("2026-10-14T00:00:00Z"),
    };
  }
  const before = structuredClone(baseline),
    after = structuredClone(baseline);
  for (const service of loadParticipantServices) {
    Object.assign(before[service], {
      at: 6500,
      observed_at_ms: baseline[service].observed_at_ms + 6500,
    });
    Object.assign(after[service], {
      at: 7600,
      observed_at_ms: baseline[service].observed_at_ms + 7600,
    });
  }
  Object.assign(after["agent-ui"], {
    running: false,
    finished_at: "2026-10-14T00:00:07.400Z",
  });
  f.ownerLifecycle = {
    project,
    agent_id: f.agentID,
    baseline,
    before,
    after,
    requested_at: 7000,
    stopped_at: 7500,
    requested_at_ms: baseline["agent-ui"].observed_at_ms + 7000,
    forced_drain: false,
    log_checked: true,
    log_sha256: "b".repeat(64),
    restored: false,
    acp_clock: {
      container_id: baseline["agent-acp-service"].id,
      listener: "control",
      method: "GET",
      path: "/status",
      started_at: 1,
      received_at: 5,
      status: 200,
      ready: true,
      body_complete: true,
      body_bytes: 18,
      body_sha256: "c".repeat(64),
      server_date: new Date(0).toUTCString(),
    },
  };
  f.ownerScope = {
    organization_id: "organization",
    user_id: "owner-user",
    agent_id: f.agentID,
  };
  f.cleanupSearches = { close: [close], delete: [close], health: [health] };
  Object.assign(f, { close, health });
  return f;
}
