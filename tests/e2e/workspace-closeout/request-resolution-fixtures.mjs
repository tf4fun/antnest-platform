import { fields } from "../observability/trace-fixtures.mjs";
import {
  resolutionFixture,
  sharedResolutionFixture,
  resolvePrefix as prefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

export function fixture(source = "cache", transport = "websocket") {
  const f =
    source === "shared"
      ? sharedResolutionFixture(true)
      : resolutionFixture(source);
  for (const trace of f.traces.values())
    for (const span of trace.spans)
      if (span.tags.some((field) => field.key === prefix + "profile"))
        setTag(span, prefix + "profile", "acp");
  f.expected = {
    traceID: f.trace.traceID,
    transport,
    method: "session/list",
    requestId: "1",
    sessionId: "session",
    agentId: "agent",
    kind: "request",
    connectionTraceID: "d".repeat(32),
  };
  f.trace.processes.acp = { serviceName: "agent-acp-service" };
  const acp = (spanID, parent, tags) => ({
    traceID: f.trace.traceID,
    spanID,
    processID: "acp",
    operationName: "acp session/list",
    startTime: f.upstream.startTime + 1,
    duration: 100,
    references: [
      { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: parent },
    ],
    tags: fields(tags),
  });
  if (transport === "websocket") {
    f.root.operationName = "acp session/list";
    f.root.tags = fields({
      "span.kind": "server",
      "rpc.service": "acp",
      "rpc.method": f.expected.method,
      "antnest.operation.phase": "relay",
      "network.transport": "websocket",
    });
    f.root.references.push({
      refType: "FOLLOWS_FROM",
      traceID: f.expected.connectionTraceID,
      spanID: "socket",
    });
    f.upstream.operationName = "acp session/list";
    f.upstream.tags = fields({
      "span.kind": "producer",
      "antnest.operation.phase": "forward",
    });
  } else {
    f.root.operationName = "HTTP POST /api/app/agents/{agent_id}/v1/acp";
    setTag(f.root, "http.route", "/api/app/agents/{agent_id}/v1/acp");
    setTag(f.root, "http.request.method", "POST");
    f.upstream.operationName = "HTTP POST agent-acp-workspace";
    setTag(f.upstream, "http.request.method", "POST");
    const http = acp("acp-http", "upstream", {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/v1/acp",
    });
    http.operationName = "HTTP POST /v1/acp";
    f.trace.spans.push(http);
  }
  f.trace.spans.push(
    acp("request", transport === "http" ? "acp-http" : "upstream", {
      "span.kind": "server",
      "rpc.method": f.expected.method,
      "antnest.request.id": f.expected.requestId,
      "antnest.agent.id": f.expected.agentId,
      "antnest.session.id": f.expected.sessionId,
    }),
  );
  return f;
}
