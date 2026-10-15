import { createHash } from "node:crypto";
import { fields } from "../observability/trace-fixtures.mjs";

export function outageClockFixture() {
  const epoch = Date.parse("Thu, 15 Oct 2026 00:00:00 GMT") * 1000;
  const container = "c".repeat(64);
  const resource = ["agent-acp-service", "acp-container", 1, "acp-container:1"];
  const state = (at) => ({
    id: container,
    project: "project",
    service: "agent-acp-service",
    host_name: resource[1],
    running: true,
    restarting: false,
    exit_code: 0,
    oom_killed: false,
    health: "healthy",
    started_at: new Date(epoch / 1000 - 10000).toISOString(),
    finished_at: new Date(epoch / 1000 - 20000).toISOString(),
    observed_at_ms: epoch / 1000 + at,
    at,
  });
  const before = state(1600);
  const sample = {
    container_id: container,
    listener: "control",
    method: "GET",
    path: "/status",
    status: 200,
    ready: true,
    body_complete: true,
    body_bytes: 18,
    body_sha256: createHash("sha256")
      .update('{"status":"ready"}')
      .digest("hex"),
    server_date: new Date(epoch / 1000 + 1000).toUTCString(),
    started_at: 1700,
    received_at: 1706,
  };
  const health = (n, at) => {
    const traceID = n.toString(16).padStart(32, "0");
    return {
      traceID,
      processes: {
        acp: {
          serviceName: resource[0],
          tags: fields({
            "host.name": resource[1],
            "process.pid": resource[2],
            "service.instance.id": resource[3],
          }),
        },
      },
      spans: [
        {
          traceID,
          spanID: n.toString(16).padStart(16, "0"),
          processID: "acp",
          operationName: "HTTP GET /status",
          startTime: epoch + at * 1000,
          duration: 1000,
          references: [],
          logs: [],
          tags: fields({
            "span.kind": "server",
            "http.request.method": "GET",
            "http.route": "/status",
            "antnest.listener": "control",
            "http.response.status_code": 200,
          }),
        },
      ],
    };
  };
  const found = [health(90, 500), health(91, 1703)];
  const clockSearches = {
    now: epoch / 1000 + 60000,
    query: {
      service: resource[0],
      operation: "HTTP GET /status",
      lookback: "65000ms",
      limit: "500",
      tags: JSON.stringify({
        "span.kind": "server",
        "http.request.method": "GET",
        "http.route": "/status",
        "antnest.listener": "control",
      }),
    },
    found: structuredClone(found),
    rounds: Array.from({ length: 3 }, () => structuredClone(found)),
    errors: [],
  };
  return {
    epoch,
    health,
    evidence: {
      project: "project",
      acp_clock_probe: { before, sample, after: state(1750) },
      consumer_restarts: [
        { service: resource[0], before, started_at: 1801, after: state(2200) },
      ],
    },
    coarse: {
      service: resource[0],
      generation: 0,
      resource,
      node_sdk_quantization_us: 1000,
      offset_min_us: epoch - 90000,
      offset_max_us: epoch + 10000,
      samples: [
        {
          trace_id: "1".repeat(32),
          span_id: "2".repeat(16),
          started_at: 1000,
          received_at: 1100,
        },
      ],
    },
    traces: new Map(found.map((t) => [t.traceID, structuredClone(t)])),
    archivedTraceIDs: new Set(found.map((t) => t.traceID)),
    clockSearches,
  };
}

export function syncOutageClockSearch(f) {
  f.clockSearches.found = [...f.traces.values()].filter((t) =>
    t.spans.some((s) => s.operationName === "HTTP GET /status"),
  );
  f.clockSearches.rounds = Array.from({ length: 3 }, () =>
    structuredClone(f.clockSearches.found),
  );
}
