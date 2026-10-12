import {
  shutdownResolutionFixture,
  eventRoute,
} from "./shutdown-resolution-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

export const route = eventRoute;
export const expected = shutdownResolutionFixture("rpc").expected;

function legacyTrace(executionState = false) {
  const f = shutdownResolutionFixture("rpc", executionState);
  const ids = {
    root: "edge",
    "resolve-server": "identity",
    "resolve-client": "identity-client",
    sql: "identity-sql",
    upstream: "forward",
  };
  const id = (value) => ids[value] ?? value;
  f.trace.processes["edge-gateway"] = f.trace.processes.edge;
  f.trace.processes["identity-service"] = f.trace.processes.identity;
  for (const span of f.trace.spans) {
    span.spanID = id(span.spanID);
    for (const ref of span.references) ref.spanID = id(ref.spanID);
    if (span.processID === "edge") span.processID = "edge-gateway";
    if (span.processID === "identity") span.processID = "identity-service";
    // Keep the old mutation tests' stable server tag positions.
    const order = [
      "span.kind",
      "http.response.status_code",
      "http.route",
      "http.request.method",
    ];
    span.tags.sort(
      (a, b) =>
        (order.includes(a.key) ? order.indexOf(a.key) : 4) -
        (order.includes(b.key) ? order.indexOf(b.key) : 4),
    );
  }
  return f;
}
export function traceFixture() {
  const f = legacyTrace();
  const first = ["edge", "identity", "console", "controller"];
  f.trace.spans = [
    ...first.map((id) => f.trace.spans.find((span) => span.spanID === id)),
    ...f.trace.spans.filter((span) => !first.includes(span.spanID)),
  ];
  return f.trace;
}
export function cancelledTrace() {
  const trace = traceFixture();
  trace.spans[0].tags.push(
    { key: "error", value: true },
    { key: "otel.status_description", value: "handler_aborted" },
    { key: "antnest.http.request_cancelled", value: true },
  );
  return trace;
}

export function dependencyCancellationFixture(executionState = false) {
  const f = legacyTrace(executionState);
  const first = [
    f.root,
    f.trace.spans.find((span) => span.spanID === "identity"),
    f.upstream,
  ];
  if (!executionState) first.push(f.console);
  f.trace.spans = [
    ...first,
    ...f.trace.spans.filter(
      (span) => !first.includes(span) && span !== f.receiver,
    ),
    f.receiver,
  ];
  setTag(f.upstream, "error", true);
  setTag(f.upstream, "error.type", "cancelled");
  if (executionState) {
    setTag(f.receiver, "error.type", "stream_interrupted");
    setTag(f.receiver, "otel.status_code", "ERROR");
  } else {
    setTag(f.console, "error.type", "cancelled");
    f.console.logs = [
      {
        fields: [
          { key: "event", value: "antnest.error" },
          { key: "error.type", value: "cancelled" },
        ],
      },
    ];
    setTag(f.consoleClient, "error", true);
    setTag(f.consoleClient, "error.type", "cancelled");
    setTag(f.receiver, "error.type", "canceled");
    setTag(f.receiver, "otel.status_code", "ERROR");
    setTag(f.receiver, "otel.status_description", "request_failed");
  }
  return { trace: f.trace, want: f.expected };
}
