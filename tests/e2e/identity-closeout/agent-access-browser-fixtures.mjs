import {
  bridgeSessionCauseFixture,
  moveSessionTrace,
} from "./bridge-session-cause-fixtures.mjs";
import { sessionTraceBase } from "./bridge-session-trace-fixtures.mjs";
import { offboardingFixture } from "./offboarding-trace-fixture.mjs";
import { inspectOffboardingTrace } from "./offboarding-evidence.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

export function membershipBrowserFixture(normal = true, terminal = !normal) {
  const f = bridgeSessionCauseFixture("revoked", { terminal });
  f.expected.principal.membership_id = "member-b";
  const raw = offboardingFixture();
  raw.trace = JSON.parse(
    JSON.stringify(raw.trace).replaceAll("agent-test", "agent-1"),
  );
  raw.expected.agentID = "agent-1";
  moveSessionTrace(
    raw.trace,
    f.expected.cause.traceID,
    (sessionTraceBase + 1200) * 1000,
  );
  raw.expected.sourceID = raw.trace.traceID;
  const root = raw.trace.spans.find((s) => s.spanID === "gateway");
  const console = raw.trace.spans.find((s) => s.spanID === "console");
  const identity = raw.trace.spans.find((s) => s.spanID === "controller");
  setTag(root, "http.response.status_code", 200);
  setTag(
    console,
    "http.route",
    "/api/admin/directory/memberships/{membership_id}",
  );
  setTag(console, "http.response.status_code", 200);
  setTag(identity, "http.route", "/rpc/identity/update-membership");
  setTag(identity, "rpc.method", "update_membership");
  for (const p of Object.values(raw.trace.processes)) {
    const other = Object.values(f.trace.processes).find(
      (o) => o.serviceName === p.serviceName,
    );
    if (other) p.tags = structuredClone(other.tags);
  }
  f.collection.traces.set(raw.trace.traceID, raw.trace);
  Object.assign(f.expected.cause, {
    kind: "membership_deactivated",
    path: "/api/admin/directory/memberships/member-b",
    method: "POST",
    status: 200,
    actor: {
      organization_id: "org",
      user_id: "admin-b",
      organization_role: "admin",
      system_role: "user",
    },
    target: structuredClone(f.expected.principal),
    body: { membership: { id: "member-b", user_id: "user", active: false } },
  });
  delete f.expected.cause.principal;
  delete f.expected.cause.credentialScope;
  f.expected.offboarding = inspectOffboardingTrace(
    [raw.trace],
    raw.expected,
    [],
  );
  if (normal) {
    for (const span of [f.root, f.upstream]) {
      span.tags = span.tags.filter(
        ({ key }) => !/^(error|otel\.status|antnest\.error)/u.test(key),
      );
      span.logs = [];
    }
    f.expected.closure.kind = "remote-end";
    f.ui.logs = [
      {
        timestamp: f.ui.startTime + f.ui.duration,
        fields: Object.entries({
          event: "antnest.stream.termination",
          reason: "access_denied",
          source: "agent-execution-state",
          "antnest.organization.id": "org",
          "antnest.principal.id": "user",
          "antnest.agent.id": "agent-1",
        }).map(([key, value]) => ({ key, value })),
      },
    ];
  }
  return { ...f, raw, identity, mutationRoot: root };
}

export function membershipFeedFixture(typedCause = true) {
  const f = membershipBrowserFixture(false, false);
  f.feed = {
    timestamp: f.upstream.startTime + f.upstream.duration - 1000,
    fields: Object.entries({
      event: "antnest.stream.termination",
      source: "identity-session-feed",
      reason: "session_revoked",
      "antnest.revocation.reason": "membership_deactivated",
      "antnest.revocation.sequence": 23,
      "antnest.revocation.trace_id": f.raw.trace.traceID,
      "antnest.revocation.span_id": f.identity.spanID,
      "antnest.organization.id": "org",
      "antnest.principal.id": "user",
      "antnest.membership.id": "member-b",
      "antnest.agent.id": "agent-1",
    }).map(([key, value]) => ({ key, value })),
  };
  f.root.logs.push(f.feed);
  if (typedCause)
    f.upstream.logs[0].fields.find(
      ({ key }) => key === "antnest.error.cause_types",
    ).value = '["*browserstream.feedTerminationCause","*errors.errorString"]';
  return f;
}
