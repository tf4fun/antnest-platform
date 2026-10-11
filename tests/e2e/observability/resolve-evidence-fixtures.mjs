import { fields } from "./trace-fixtures.mjs";
import {
  resolutionFixture,
  sharedResolutionFixture,
  resolvePrefix,
  setTag,
} from "./gateway-resolution-fixtures.mjs";

export function observabilityResolutionFixture(
  source = "cache",
  profile = "session",
) {
  const fixture = source.startsWith("shared")
    ? sharedResolutionFixture(source === "shared-background")
    : resolutionFixture(source);
  if (source === "shared") {
    // Successful foreground creator. A cancelled creator has an ERROR status
    // in production and must fail this strict development observation gate.
    fixture.origin.root.duration = 100000;
    fixture.origin.decision.duration = 5000;
    setTag(fixture.origin.decision, resolvePrefix + "outcome", "admitted");
  }
  for (const trace of fixture.traces.values()) {
    for (const span of trace.spans) {
      if (span.tags.some((field) => field.key === resolvePrefix + "profile"))
        setTag(span, resolvePrefix + "profile", profile);
      if (span.spanID === "root" && span.operationName.startsWith("HTTP")) {
        setTag(
          span,
          "http.route",
          profile === "session" ? "/api/session" : "/api/admin/{path...}",
        );
        setTag(
          span,
          "http.request.method",
          profile === "session" ? "GET" : "PUT",
        );
      }
      if (span.spanID === "resolve-client")
        setTag(span, "server.address", "identity-service");
      if (span.spanID === "resolve-server") {
        setTag(span, "rpc.service", "identity");
        setTag(span, "rpc.system.name", "antnest.http-json");
        span.logs = ["antnest.request", "antnest.response"].map((event) => ({
          timestamp: span.startTime,
          fields: fields({ event, "antnest.payload.json": "{}" }),
        }));
      }
    }
    // A session read ends at Gateway. It has no business forwarding hop.
    if (profile === "session")
      trace.spans = trace.spans.filter((span) => span.spanID !== "upstream");
  }
  if (profile === "console") {
    setTag(fixture.upstream, "http.request.method", "PUT");
    setTag(fixture.upstream, "http.response.status_code", 200);
    fixture.trace.processes.console = { serviceName: "admin-console" };
    fixture.trace.spans.push({
      traceID: fixture.trace.traceID,
      spanID: "console",
      processID: "console",
      operationName: "HTTP PUT /api/admin/agents/{agent_id}/network-policy",
      startTime: fixture.upstream.startTime + 200,
      duration: 1000,
      references: [
        {
          traceID: fixture.trace.traceID,
          spanID: "upstream",
          refType: "CHILD_OF",
        },
      ],
      tags: fields({
        "span.kind": "server",
        "http.request.method": "PUT",
        "http.response.status_code": 200,
        "http.route": "/api/admin/agents/{agent_id}/network-policy",
      }),
    });
  }
  fixture.expected = {
    traceID: fixture.trace.traceID,
    profile,
    resolveTTLMS: 10000,
    method: profile === "session" ? "GET" : "PUT",
    route: profile === "session" ? "/api/session" : "/api/admin/{path...}",
    status: 200,
    ...(profile === "console"
      ? { consoleRoute: "/api/admin/agents/{agent_id}/network-policy" }
      : {}),
  };
  fixture.captureRpcContent = true;
  return fixture;
}
