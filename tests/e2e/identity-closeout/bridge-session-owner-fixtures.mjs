import { bridgeSessionCauseFixture } from "./bridge-session-cause-fixtures.mjs";
import { sessionTraceBase } from "./bridge-session-trace-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { loadParticipantServices } from "../edge-gateway/resolve-cache-owner-drain.mjs";

export function sessionOwnerFixture() {
  const first = bridgeSessionCauseFixture(),
    second = bridgeSessionCauseFixture();
  // Distinct raw requests and observations share the same authenticated owner.
  const remap = new Map(
    [...second.collection.traces.keys()].map((id, index) => [
      id,
      String(index + 1).repeat(32),
    ]),
  );
  const seen = new WeakSet();
  const rename = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && remap.has(item))
        value[key] = remap.get(item);
      else rename(item);
    }
  };
  rename(second.expected);
  for (const trace of second.collection.traces.values()) {
    rename(trace);
    for (const span of trace.spans) {
      span.startTime += 100;
      for (const event of span.logs ?? []) event.timestamp += 100;
    }
  }
  second.expected.protocolVersion = 2;
  second.expected.credentialScope = "00000000-0000-4000-8000-000000000002";
  second.expected.checkpoint.stream.credential_scope =
    second.expected.credentialScope;
  second.expected.cause.credentialScope = second.expected.credentialScope;
  second.expected.denial.credentialScope = second.expected.credentialScope;
  second.expected.sessionId = second.expected.checkpoint.sessionId =
    "session-2";
  second.expected.checkpoint.stream.path =
    second.expected.checkpoint.stream.path.replace("session-1", "session-2");
  second.expected.denial.path = second.expected.denial.path.replace(
    "session-1",
    "session-2",
  );
  first.ui.spanID = "1".repeat(16);
  second.ui.spanID = "2".repeat(16);
  const traces = new Map(
    [
      ...first.collection.traces.values(),
      ...second.collection.traces.values(),
    ].map((trace) => [trace.traceID, trace]),
  );
  const acp = {
    serviceName: "agent-acp-service",
    tags: fields({
      "host.name": "acp-fixture-host",
      "process.pid": 2,
      "service.instance.id": "original-acp-process",
    }),
  };
  for (const origin of [first, second])
    origin.trace.processes.acp = structuredClone(acp);
  const add = (trace, id, processID, name, startMS, endMS, tags, refs = []) => {
    const span = {
      traceID: trace.traceID,
      spanID: id.repeat(16),
      processID,
      operationName: name,
      startTime: (sessionTraceBase + startMS) * 1000,
      duration: (endMS - startMS) * 1000,
      tags: fields(tags),
      references: refs,
      logs: [],
    };
    trace.spans.push(span);
    return span;
  };
  const parent = (trace, span, refType = "CHILD_OF") => [
    { refType, traceID: trace.traceID, spanID: span.spanID },
  ];
  const initialize = add(
    first.trace,
    "3",
    "acp",
    "HTTP POST /v1/acp",
    81,
    86,
    {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/v1/acp",
      "http.response.status_code": 200,
      "antnest.listener": "workspace",
      "rpc.system.name": "jsonrpc",
      "rpc.service": "acp",
      "rpc.method": "initialize",
      "antnest.protocol.version": "v1",
      "antnest.agent.id": "agent-1",
      "antnest.request.id": "initialize-1",
    },
    parent(first.trace, first.ui),
  );
  const interrupted = {
    error: true,
    "otel.status_code": "ERROR",
    "error.type": "stream_interrupted",
    "antnest.outcome": "disconnected",
  };
  const streams = [first, second].map((origin, index) =>
    add(
      origin.trace,
      String(index + 4),
      "acp",
      "HTTP GET /v1/acp",
      90 + index,
      7221 + index,
      {
        "span.kind": "server",
        "http.request.method": "GET",
        "http.route": "/v1/acp",
        "http.response.status_code": 200,
        "antnest.listener": "workspace",
        ...interrupted,
      },
      parent(origin.trace, origin.ui),
    ),
  );
  const watch = add(
    first.trace,
    "6",
    "acp",
    "HTTP POST /rpc/agent-acp/watch-agent-execution-state",
    87,
    7190,
    {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/rpc/agent-acp/watch-agent-execution-state",
      "http.response.status_code": 200,
      "antnest.listener": "workspace",
      "rpc.system.name": "json-over-http",
      "rpc.service": "agent-acp",
      "rpc.method": "watch_agent_execution_state",
      "antnest.organization.id": "org",
      "antnest.agent.id": "agent-1",
      ...interrupted,
    },
    parent(first.trace, first.ui),
  );
  streams.push(watch);
  const closing = {
    traceID: "7".repeat(32),
    processes: {
      ui: structuredClone(first.trace.processes.ui),
      acp: structuredClone(acp),
    },
    spans: [],
  };
  const receipt = {
    trigger: "requested",
    outcome: "closed",
    target_observed: true,
    delete_attempts: 1,
    delete_responses: 1,
    delete_completed: 1,
    delete_status: 202,
    pending_requests: 0,
    stream_joined: true,
    failures: 0,
    diagnostics_truncated: false,
  };
  const close = add(
    closing,
    "7",
    "ui",
    "agent_ui.acp.close",
    7200,
    7280,
    {
      "span.kind": "internal",
      ...Object.fromEntries(
        Object.entries(receipt).map(([key, value]) => [
          "antnest.ui.acp.close." + key,
          value,
        ]),
      ),
    },
    parent(first.trace, first.ui, "FOLLOWS_FROM"),
  );
  const deletion = add(
    closing,
    "8",
    "acp",
    "HTTP DELETE /v1/acp",
    7210,
    7220,
    {
      "span.kind": "server",
      "http.request.method": "DELETE",
      "http.route": "/v1/acp",
      "antnest.listener": "workspace",
      "http.response.status_code": 202,
    },
    parent(closing, close),
  );
  const health = {
    traceID: "9".repeat(32),
    processes: { acp: structuredClone(acp) },
    spans: [],
  };
  add(health, "9", "acp", "HTTP GET /status", 6005, 6006, {
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "/status",
    "antnest.listener": "control",
    "http.response.status_code": 200,
  });
  for (const trace of [closing, health]) traces.set(trace.traceID, trace);
  const project = first.expected.deployment.project;
  const baseline = Object.fromEntries(
    loadParticipantServices.map((service, index) => {
      const id = (index + 1).toString(16).repeat(64);
      return [
        service,
        {
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
          started_at: new Date(sessionTraceBase - 60000).toISOString(),
          finished_at: "0001-01-01T00:00:00Z",
          at: 5900,
          observed_at_ms: sessionTraceBase + 5900,
        },
      ];
    }),
  );
  const before = structuredClone(baseline),
    after = structuredClone(baseline);
  for (const service of loadParticipantServices) {
    Object.assign(before[service], {
      at: 6900,
      observed_at_ms: sessionTraceBase + 6900,
    });
    Object.assign(after[service], {
      at: 7600,
      observed_at_ms: sessionTraceBase + 7600,
    });
  }
  Object.assign(after["agent-ui"], {
    running: false,
    finished_at: new Date(sessionTraceBase + 7450).toISOString(),
  });
  const ownerLifecycle = {
    project,
    agent_id: "agent-1",
    baseline,
    before,
    after,
    requested_at: 7000,
    stopped_at: 7500,
    requested_at_ms: sessionTraceBase + 7000,
    log_checked: true,
    forced_drain: false,
    log_sha256: "b".repeat(64),
    restored: false,
    acp_clock: {
      container_id: baseline["agent-acp-service"].id,
      listener: "control",
      method: "GET",
      path: "/status",
      started_at: 6000,
      received_at: 6010,
      status: 200,
      ready: true,
      body_complete: true,
      body_bytes: 18,
      body_sha256: "c".repeat(64),
      server_date: new Date(sessionTraceBase + 6000).toUTCString(),
    },
  };
  const collection = { traces, archivedTraceIDs: new Set(traces.keys()) };
  const context = {
    agentId: "agent-1",
    closures: [first.expected, second.expected],
    ownerLifecycle,
  };
  const syncSearches = () => {
    const rows = [...traces.values()].filter((trace) =>
      trace.spans.some(
        (span) =>
          span.operationName === "agent_ui.acp.close" ||
          span.operationName === "HTTP DELETE /v1/acp",
      ),
    );
    const found = {
      close: rows.filter((trace) =>
        trace.spans.some((span) => span.operationName === "agent_ui.acp.close"),
      ),
      deletion: rows.filter((trace) =>
        trace.spans.some(
          (span) => span.operationName === "HTTP DELETE /v1/acp",
        ),
      ),
    };
    collection.cleanupSearches = {
      found: structuredClone(found),
      rounds: {
        close: Array.from({ length: 3 }, () => structuredClone(found.close)),
        deletion: Array.from({ length: 3 }, () =>
          structuredClone(found.deletion),
        ),
      },
      errors: [],
    };
    collection.healthSearches = {
      found: structuredClone([health]),
      rounds: Array.from({ length: 3 }, () => structuredClone([health])),
      errors: [],
    };
  };
  syncSearches();
  return {
    first,
    second,
    context,
    collection,
    initialize,
    close,
    closing,
    deletion,
    health,
    streams,
    watch,
    syncSearches,
    setTag,
  };
}
