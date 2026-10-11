import { fixture } from "./trace-fixtures.mjs";
import { readonlyReplayFixture } from "../lifecycle-closeout/replay-fixtures.mjs";
import {
  resolutionFixture,
  sharedResolutionFixture,
  resolvePrefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

// Keep the existing owning business fixtures and attach their real Console
// boundary to an independent Resolve provenance fixture.
export function attachAdmission(business, source, clientID) {
  const f =
    source === "shared"
      ? sharedResolutionFixture(true)
      : resolutionFixture(source);
  for (const trace of f.traces.values())
    for (const span of trace.spans)
      if (span.tags.some((field) => field.key === resolvePrefix + "profile"))
        setTag(span, resolvePrefix + "profile", "console");
  f.root.operationName = "HTTP POST /api/admin/{path...}";
  setTag(f.root, "http.route", "/api/admin/{path...}");
  setTag(f.root, "http.request.method", "POST");
  setTag(f.root, "http.response.status_code", 202);
  f.upstream.operationName = "HTTP POST admin-console";
  setTag(f.upstream, "http.request.method", "POST");
  setTag(f.upstream, "http.response.status_code", 202);
  const id = (value) =>
    value === "gateway"
      ? "root"
      : value === clientID
        ? "upstream"
        : `business-${value}`;
  for (const original of business.trace.spans) {
    if (["gateway", clientID].includes(original.spanID)) continue;
    const span = structuredClone(original);
    span.spanID = id(span.spanID);
    span.traceID = f.trace.traceID;
    span.startTime += f.upstream.startTime;
    span.references = span.references.map((ref) => ({
      ...ref,
      traceID: f.trace.traceID,
      spanID: id(ref.spanID),
    }));
    if (original.spanID === "console")
      setTag(span, "http.response.status_code", 202);
    f.trace.spans.push(span);
  }
  Object.assign(f.trace.processes, business.trace.processes);
  f.expected = { ...business.expected, traceID: f.trace.traceID };
  f.business = (spanID) =>
    f.trace.spans.find((span) => span.spanID === id(spanID));
  return f;
}

export function lifecycleResolutionFixture(kind = "create", source = "cache") {
  return attachAdmission(fixture(kind), source, "client-console");
}

export function replayResolutionFixture(source = "cache") {
  return attachAdmission(readonlyReplayFixture(), source, "gateway-client");
}
