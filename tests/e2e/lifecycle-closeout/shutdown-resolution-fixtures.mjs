import {
  addResolveRPC,
  resolutionFixture,
  sharedResolutionFixture,
  resolvePrefix as prefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

const fields = (tags) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));
const ref = (traceID, spanID, refType = "CHILD_OF") => ({
  refType,
  traceID,
  spanID,
});
export const eventRoute = "/api/admin/{path...}";
export const controllerRoute = "/internal/agents/{agent_id}/events/watch";

export function shutdownResolutionFixture(
  source = "cache",
  executionState = false,
  background = true,
) {
  const f =
    source === "shared"
      ? sharedResolutionFixture(background)
      : resolutionFixture(source);
  const profile = executionState ? "workspace" : "console";
  for (const trace of f.traces.values())
    for (const span of trace.spans)
      if (span.tags.some((field) => field.key === prefix + "profile"))
        setTag(span, prefix + "profile", profile);
  if (f.origin && !background) {
    setTag(f.origin.decision, "error", true);
    setTag(f.origin.decision, "otel.status_description", "unavailable");
  }
  const route = executionState
    ? "/api/app/agents/{agent_id}/state/watch"
    : eventRoute;
  f.root.operationName = `HTTP GET ${route}`;
  setTag(f.root, "http.route", route);
  f.root.duration = 1400000;
  f.upstream.operationName = executionState
    ? "HTTP POST agent-acp-workspace"
    : "HTTP GET admin-console";
  setTag(f.upstream, "http.request.method", executionState ? "POST" : "GET");
  setTag(f.upstream, "http.response.status_code", 200);
  f.upstream.duration = 1370000;
  const span = (
    spanID,
    service,
    parent,
    route,
    method,
    startTime,
    duration,
    kind = "server",
  ) => ({
    spanID,
    traceID: f.trace.traceID,
    processID: service,
    operationName: `HTTP ${method} ${route}`,
    startTime,
    duration,
    references: [ref(f.trace.traceID, parent)],
    tags: fields({
      "span.kind": kind,
      "http.request.method": method,
      "http.response.status_code": 200,
      ...(kind === "server" ? { "http.route": route } : {}),
    }),
  });
  if (executionState) {
    f.receiver = span(
      "acp",
      "agent-acp-service",
      "upstream",
      "/rpc/agent-acp/watch-agent-execution-state",
      "POST",
      1030000,
      1350000,
    );
    setTag(f.receiver, "rpc.method", "watch_agent_execution_state");
    f.trace.spans.push(f.receiver);
  } else {
    f.console = span(
      "console",
      "admin-console",
      "upstream",
      "/api/admin/agents/{agent_id}/events/watch",
      "GET",
      1030000,
      1350000,
    );
    f.consoleClient = span(
      "console-forward",
      "admin-console",
      "console",
      "agent-controller",
      "GET",
      1035000,
      1340000,
      "client",
    );
    f.receiver = span(
      "controller",
      "agent-controller",
      "console-forward",
      controllerRoute,
      "GET",
      1040000,
      1330000,
    );
    f.trace.spans.push(f.console, f.consoleClient, f.receiver);
  }
  for (const service of [
    "admin-console",
    "agent-controller",
    "agent-acp-service",
  ])
    f.trace.processes[service] = { serviceName: service };
  const before = {
    id: "gateway-container",
    name: "edge-gateway",
    project: "shutdown-fixture",
    image: "gateway-image",
    running: true,
    health: "healthy",
    exit: 0,
    oom: false,
    error: "",
    started: new Date(0).toISOString(),
    finished: new Date(0).toISOString(),
  };
  f.expected = {
    traceID: f.trace.traceID,
    route,
    console: !executionState,
    executionState,
    controllerRoute,
    stopWindow: { start: 1000, end: 3500 },
    closure: {
      kind: "transport-end",
      traceID: f.trace.traceID,
      observedAt: 2401,
      receivedEvents: 1,
    },
    stop: {
      liveAt: 1999,
      startedAt: 2000,
      completedAt: 2500,
      project: before.project,
      before: [before],
      after: [
        { ...before, running: false, finished: new Date(2400).toISOString() },
      ],
    },
  };
  return f;
}

export function addShutdownCheck(
  f,
  {
    source = "shared",
    outcome = "unavailable",
    start = 2100000,
    duration = 10000,
    state = "cancelled-before-client",
    cancelKind = "caller-cancelled",
    background = true,
    cancelledClient = false,
    receiver = true,
  } = {},
) {
  const suffix = `-${f.trace.spans.length}`;
  const decision = {
    ...structuredClone(f.decision),
    spanID: "check" + suffix,
    startTime: start,
    duration,
    references: [ref(f.trace.traceID, f.root.spanID)],
    tags: fields({
      "span.kind": "internal",
      [prefix + "source"]: source,
      [prefix + "outcome"]: outcome,
      [prefix + "profile"]: f.expected.executionState ? "workspace" : "console",
    }),
  };
  f.trace.spans.push(decision);
  if (outcome !== "admitted") {
    setTag(decision, "error", true);
    setTag(decision, "otel.status_description", outcome);
  }
  let actual;
  if (source === "cache") {
    for (const [name, value] of Object.entries({
      snapshot_age_ms: 2000,
      proof_age_ms: 100,
      valid_for_ms: 8000,
    }))
      setTag(decision, prefix + name, value);
  } else if (source === "rpc") {
    actual = {
      trace: f.trace,
      ...addResolveRPC(f.trace, suffix, start + 1000),
    };
  } else {
    setTag(decision, prefix + "shared_source_state", state);
    if (outcome === "unavailable")
      setTag(decision, prefix + "cancel_kind", cancelKind);
    if (state === "actual-client") {
      const shared = shutdownResolutionFixture(
        "shared",
        f.expected.executionState,
        background,
      );
      for (const [id, trace] of shared.traces) {
        if (id === f.trace.traceID) continue;
        for (const span of trace.spans) span.startTime += start - 1000000;
        f.traces.set(id, trace);
        f.archivedTraceIDs.add(id);
      }
      const trace = shared.origin.trace;
      actual = {
        trace,
        root: shared.origin.root,
        client: trace.spans.find((span) => span.spanID === "resolve-client"),
        server: trace.spans.find((span) => span.spanID === "resolve-server"),
        sql: trace.spans.find((span) => span.spanID === "sql"),
      };
      // A source CLIENT can finish after this waiter cancels, but must already
      // exist at the cancellation snapshot.
      decision.duration = Math.max(duration, 15000);
      decision.references.push(
        ref(trace.traceID, actual.client.spanID, "FOLLOWS_FROM"),
      );
    }
  }
  if (actual && cancelledClient) {
    setTag(actual.client, "error", true);
    setTag(actual.client, "error.type", "cancelled");
    setTag(actual.client, "otel.status_description", "Request was cancelled");
    actual.client.logs = [
      {
        fields: fields({
          event: "antnest.error",
          "antnest.error.stage": receiver ? "read_response" : "send",
          "error.type": "cancelled",
        }),
      },
    ];
    if (!receiver) {
      setTag(actual.client, "http.response.status_code", undefined);
      actual.trace.spans = actual.trace.spans.filter(
        (span) => ![actual.server, actual.sql].includes(span),
      );
    }
    if (actual.root?.operationName === "gateway.identity.resolve.refresh") {
      setTag(actual.root, prefix + "outcome", "unavailable");
      setTag(actual.root, "error", true);
      setTag(actual.root, "otel.status_description", "unavailable");
    }
  }
  return { decision, ...actual };
}
