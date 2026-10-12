import { fields } from "./trace-fixtures.mjs";

export const resolvePrefix = "antnest.identity.resolve.";
export const waiterID = "a".repeat(32);
export const sourceID = "b".repeat(32);
export const triggerID = "c".repeat(32);
const ref = (traceID, spanID, refType = "CHILD_OF") => ({
  refType,
  traceID,
  spanID,
});

export function setTag(span, key, value) {
  span.tags = span.tags.filter((field) => field.key !== key);
  if (value !== undefined) span.tags.push({ key, value });
}

export function resolutionFixture(source = "cache") {
  const trace = {
    traceID: waiterID,
    processes: {
      edge: { serviceName: "edge-gateway" },
      identity: { serviceName: "identity-service" },
    },
    spans: [],
  };
  const span = (spanID, operationName, startTime, duration, tags, parent) => ({
    traceID: trace.traceID,
    spanID,
    processID: "edge",
    operationName,
    startTime,
    duration,
    references: parent ? [ref(trace.traceID, parent)] : [],
    tags: fields(tags),
  });
  const root = span("root", "HTTP GET /api/app/bootstrap", 1000000, 100000, {
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "/api/app/bootstrap",
    "http.response.status_code": 200,
  });
  const decision = span(
    "decision",
    "gateway.identity.resolve",
    1010000,
    5000,
    {
      "span.kind": "internal",
      [resolvePrefix + "source"]: source,
      [resolvePrefix + "profile"]: "workspace",
      [resolvePrefix + "outcome"]: "admitted",
      ...(source === "cache"
        ? {
            [resolvePrefix + "snapshot_age_ms"]: 2000.125,
            [resolvePrefix + "proof_age_ms"]: 125.5,
            [resolvePrefix + "valid_for_ms"]: 7999.875,
          }
        : {}),
    },
    "root",
  );
  const upstream = span(
    "upstream",
    "HTTP GET agent-controller",
    1020000,
    10000,
    { "span.kind": "client", "http.request.method": "GET" },
    "root",
  );
  trace.spans.push(root, decision, upstream);
  const expected = {
    rootSpanID: "root",
    decisionSpanID: "decision",
    profile: "workspace",
    upstreamSpanID: "upstream",
    ttlMs: 10000,
  };
  const traces = new Map([[trace.traceID, trace]]);
  const archivedTraceIDs = new Set([trace.traceID]);
  if (source === "rpc") addResolveRPC(trace);
  return {
    trace,
    root,
    decision,
    upstream,
    expected,
    traces,
    archivedTraceIDs,
  };
}

export function addResolveRPC(trace, suffix = "", start = 1011000) {
  const client = {
    traceID: trace.traceID,
    spanID: "resolve-client" + suffix,
    processID: "edge",
    operationName: "HTTP POST identity-service",
    startTime: start,
    duration: 2000,
    references: [ref(trace.traceID, "root")],
    tags: fields({
      "span.kind": "client",
      "http.request.method": "POST",
      "http.response.status_code": 200,
    }),
  };
  const server = {
    ...structuredClone(client),
    spanID: "resolve-server" + suffix,
    processID: "identity",
    operationName: "HTTP POST /rpc/identity/resolve-access-token",
    startTime: start + 200,
    duration: 1000,
    references: [ref(trace.traceID, client.spanID)],
    tags: fields({
      "span.kind": "server",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "http.route": "/rpc/identity/resolve-access-token",
      "rpc.method": "resolve_access_token",
    }),
  };
  const sql = {
    ...structuredClone(server),
    spanID: "sql" + suffix,
    operationName: "SELECT",
    startTime: start + 400,
    duration: 300,
    references: [ref(trace.traceID, server.spanID)],
    tags: fields({
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": "SELECT",
      "db.query.text": "SELECT $1",
    }),
  };
  trace.spans.push(client, server, sql);
  return { client, server, sql };
}

export function sharedResolutionFixture(background = false) {
  const result = resolutionFixture("shared");
  const origin = resolutionFixture("rpc");
  origin.trace.traceID = sourceID;
  for (const span of origin.trace.spans) {
    span.traceID = sourceID;
    for (const reference of span.references) reference.traceID = sourceID;
  }
  // The first caller may finish before the process-owned source RPC. A linked
  // waiter's later admission still requires that real CLIENT and full ancestry.
  origin.root.duration = 10500;
  origin.decision.duration = 100;
  setTag(origin.decision, resolvePrefix + "outcome", "unavailable");
  origin.trace.spans = origin.trace.spans.filter((s) => s !== origin.upstream);
  if (background) {
    origin.root.operationName = "gateway.identity.resolve.refresh";
    origin.root.duration = 20000;
    origin.root.tags = fields({
      "span.kind": "internal",
      [resolvePrefix + "profile"]: "workspace",
      [resolvePrefix + "outcome"]: "admitted",
    });
    const trigger = resolutionFixture("cache");
    trigger.trace.traceID = triggerID;
    for (const span of trigger.trace.spans) {
      span.traceID = triggerID;
      span.startTime -= 100000;
      for (const reference of span.references) reference.traceID = triggerID;
    }
    origin.root.references = [ref(triggerID, "decision", "FOLLOWS_FROM")];
    origin.trace.spans = origin.trace.spans.filter(
      (s) => s !== origin.decision,
    );
    result.traces.set(triggerID, trigger.trace);
    result.archivedTraceIDs.add(triggerID);
  }
  result.traces.set(sourceID, origin.trace);
  result.archivedTraceIDs.add(sourceID);
  result.decision.references.push(
    ref(sourceID, "resolve-client", "FOLLOWS_FROM"),
  );
  setTag(
    result.decision,
    resolvePrefix + "shared_source_state",
    "actual-client",
  );
  return { ...result, origin };
}
