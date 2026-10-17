import { recoveryHTTPFixture } from "../edge-gateway/resolve-cache-recovery-http-fixtures.mjs";
import {
  resolutionFixture,
  setTag,
  resolvePrefix,
} from "../observability/gateway-resolution-fixtures.mjs";

export function failureDiagnostic(span, type, message, causes, stage) {
  for (const [key, value] of Object.entries({
    error: true,
    "error.type": type,
    "otel.status_code": "ERROR",
    "otel.status_description": message,
  }))
    setTag(span, key, value);
  span.logs = stage
    ? [
        {
          timestamp: span.startTime + span.duration,
          fields: Object.entries({
            event: "antnest.error",
            "error.type": type,
            "antnest.error.stage": stage,
            "antnest.error.message": message,
            "antnest.error.cause_types": JSON.stringify(causes),
          }).map(([key, value]) => ({ key, value })),
        },
      ]
    : [];
}

export function sessionRejectionFixture(
  status = 401,
  shared = false,
  background = false,
) {
  const p = recoveryHTTPFixture().parts.find((p) => p.rejection === "session");
  setTag(p.root, "http.route", "/api/app/workspace/v1/{path...}");
  setTag(p.root, "http.request.method", "POST");
  setTag(p.root, "http.response.status_code", status);
  setTag(p.client, "server.address", "identity-service");
  setTag(p.client, "antnest.request.timeout_ms", 2000);
  setTag(p.decision, resolvePrefix + "profile", "workspace");
  const outcome = status === 401 ? "rejected" : "unavailable";
  setTag(p.decision, resolvePrefix + "outcome", outcome);
  failureDiagnostic(p.decision, undefined, outcome);
  if (status === 401) {
    failureDiagnostic(
      p.root,
      "operation_failed",
      "Operation failed; unclassified error text was not exported",
      ["*errors.errorString"],
      "request",
    );
    failureDiagnostic(p.client, "401", "HTTP status 401");
  } else {
    p.trace.spans = p.trace.spans.filter(
      (s) => s !== p.server && s !== p.database,
    );
    setTag(p.client, "http.response.status_code", undefined);
    failureDiagnostic(
      p.root,
      "network_error",
      "Network operation failed",
      ["*fmt.wrapError", "*url.Error", "*net.OpError", "*os.SyscallError"],
      "request",
    );
    failureDiagnostic(
      p.client,
      "network_error",
      "Network operation failed",
      ["*net.OpError", "*os.SyscallError", "syscall.Errno"],
      "send",
    );
  }
  p.trace.processes.edge.tags = Object.entries({
    "host.name": "gateway-host",
    "process.pid": 1,
    "service.instance.id": "gateway-instance",
    "telemetry.sdk.language": "go",
  }).map(([key, value]) => ({ key, value }));
  const traces = new Map([[p.trace.traceID, p.trace]]);
  let source = p.trace,
    sourceClient = p.client,
    sourceRoot = p.root,
    sourceDecision = p.decision;
  if (shared) {
    source = structuredClone(p.trace);
    source.traceID = "e".repeat(32);
    for (const span of source.spans) {
      span.traceID = source.traceID;
      for (const ref of span.references) ref.traceID = source.traceID;
    }
    sourceRoot = source.spans.find((s) => s.spanID === p.root.spanID);
    sourceClient = source.spans.find((s) => s.spanID === p.client.spanID);
    sourceDecision = source.spans.find((s) => s.spanID === p.decision.spanID);
    p.trace.spans = p.trace.spans.filter((s) =>
      [p.root, p.decision].includes(s),
    );
    setTag(p.decision, resolvePrefix + "source", "shared");
    setTag(p.decision, resolvePrefix + "shared_source_state", "actual-client");
    p.decision.references.push({
      refType: "FOLLOWS_FROM",
      traceID: source.traceID,
      spanID: sourceClient.spanID,
    });
    if (background) {
      source.spans = source.spans.filter((s) => s !== sourceDecision);
      sourceRoot.operationName = "gateway.identity.resolve.refresh";
      sourceRoot.tags = Object.entries({
        "span.kind": "internal",
        [resolvePrefix + "profile"]: "workspace",
        [resolvePrefix + "outcome"]: outcome,
      }).map(([key, value]) => ({ key, value }));
      failureDiagnostic(sourceRoot, undefined, outcome);
      const trigger = resolutionFixture("cache");
      trigger.trace.processes.edge.tags = structuredClone(
        p.trace.processes.edge.tags,
      );
      trigger.trace.traceID = "d".repeat(32);
      for (const span of trigger.trace.spans) {
        span.traceID = trigger.trace.traceID;
        span.startTime -= 100000;
        for (const ref of span.references) ref.traceID = trigger.trace.traceID;
      }
      sourceRoot.references = [
        {
          refType: "FOLLOWS_FROM",
          traceID: trigger.trace.traceID,
          spanID: trigger.decision.spanID,
        },
      ];
      traces.set(trigger.trace.traceID, trigger.trace);
    }
    traces.set(source.traceID, source);
  }
  const expected = {
    traceID: p.trace.traceID,
    path: "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts",
    method: "POST",
    status,
    profile: "workspace",
    requestTimeoutMs: 2000,
    code: status === 401 ? "unauthenticated" : "identity_unavailable",
  };
  return {
    ...p,
    source,
    sourceRoot,
    sourceClient,
    sourceDecision,
    expected,
    collection: { traces, archivedTraceIDs: new Set(traces.keys()) },
  };
}
