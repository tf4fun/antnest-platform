import assert from "node:assert/strict";
import { inspectBridgeSessionBoundary } from "./bridge-session-trace.mjs";
import { inspectBrowserFeedWitness } from "./browser-feed-witness.mjs";
import { inspectOffboardingTrace } from "./offboarding-evidence.mjs";
import { inspectUserRevocationTransaction } from "./user-revocation-evidence.mjs";
import { verifyIdentityEvidence } from "./trace.mjs";
import {
  inspectGatewayIdentityRejection,
  inspectWorkspaceFailureReceipt,
} from "../edge-gateway/resolve-cache-outage-rejection.mjs";
import { sseDiagnostics } from "../edge-gateway/resolve-cache-outage-stream.mjs";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import { resolveTraceDiagnostics } from "../../support/gateway-resolution-evidence.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { assertSessionSuccess as successful } from "./session-diagnostics.mjs";
import { inspectMembershipAccessDenial } from "./agent-access-denial.mjs";

const one = (rows, label) => {
  assert.equal(rows.length, 1, label);
  return rows[0];
};
const end = (span) => span.startTime + span.duration;
function receipt(row) {
  for (const field of [
    "startedMono",
    "completedMono",
    "startedAt",
    "completedAt",
  ])
    assert(Number.isFinite(row?.[field]));
  assert(
    row.completedMono >= row.startedMono && row.completedAt >= row.startedAt,
  );
  const date = Date.parse(row.serverDate);
  assert(
    Number.isFinite(date) && new Date(date).toUTCString() === row.serverDate,
  );
}
function gatewayObservation(boundary, trace, root, row) {
  const identity = (source, span) => {
    const tags = Object.fromEntries(
      (source.processes[span.processID]?.tags ?? []).map(({ key, value }) => [
        key,
        value,
      ]),
    );
    assert(typeof tags["host.name"] === "string" && tags["host.name"]);
    assert(
      typeof tags["service.instance.id"] === "string" &&
        tags["service.instance.id"],
    );
    assert(
      Number.isSafeInteger(tags["process.pid"]) && tags["process.pid"] > 0,
    );
    return [
      tags["host.name"],
      tags["service.instance.id"],
      tags["process.pid"],
    ];
  };
  assert.deepEqual(
    identity(trace, root),
    identity(boundary.trace, boundary.root),
  );
  assert(
    root.startTime >= boundary.clock.lower(row.startedMono) &&
      end(root) <= boundary.clock.upper(row.completedMono),
    "HTTP source outside its actual receipt",
  );
}

// This proves the original browser's authority loss, using the existing real
// Disable workflow proof. It does not claim final closure of Bridge's shared
// internal protocol owners; that remains the owning Session lifecycle gate.
function inspectBrowserAccessClosure(
  trace,
  expected,
  secrets,
  collection,
  kind,
) {
  const b = inspectBridgeSessionBoundary(trace, expected, secrets, collection);
  assert.equal(expected.reason, "revoked");
  const { checkpoint, closure, cause, denial: response, principal } = expected;
  assert.equal(cause.kind, kind);
  const globalUser = kind === "user_deactivated";
  receipt(cause);
  receipt(response);
  for (const field of ["organization_id", "user_id", "membership_id"]) {
    assert(typeof principal?.[field] === "string" && principal[field]);
    assert.equal(cause.target[field], principal[field]);
  }
  assert(typeof cause.actor.user_id === "string" && cause.actor.user_id);
  assert.equal(cause.method, "POST");
  assert.equal(cause.status, 200);
  if (globalUser) {
    assert.equal(cause.actor.system_role, "admin");
    assert.equal(
      cause.path,
      `/api/admin/directory/users/${encodeURIComponent(principal.user_id)}/active`,
    );
    assert.deepEqual(cause.requestBody, { active: false });
    assert.deepEqual(cause.body, { status: "updated" });
  } else {
    assert.equal(cause.actor.organization_id, principal.organization_id);
    assert(
      cause.actor.system_role === "admin" ||
        cause.actor.organization_role === "admin",
    );
    assert.equal(
      cause.path,
      `/api/admin/directory/memberships/${encodeURIComponent(principal.membership_id)}`,
    );
    const membership = cause.body?.membership;
    assert.equal(membership?.id, principal.membership_id);
    assert.equal(membership.user_id, principal.user_id);
    assert.equal(membership.active, false);
  }
  assert(
    checkpoint.at <= cause.startedMono &&
      cause.startedMono <= closure.at &&
      cause.completedMono <= response.startedMono,
    "directory mutation outside original closure/denial interval",
  );
  assert.equal(response.credentialScope, expected.credentialScope);
  assert.equal(response.method, "POST");
  assert.equal(
    response.path,
    `/api/app/workspace/v1/agents/${encodeURIComponent(expected.agentId)}/sessions/${encodeURIComponent(expected.sessionId)}/prompts`,
  );
  assert([401, 403].includes(response.status));
  assert.equal(response.noStore, true);
  assert.equal(response.setCookieCount, 0);
  assert.match(
    response.intentId ?? "",
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
  );
  assert(
    response.startedMono >= closure.at,
    "denial preceded original closure",
  );
  assert.equal(
    new Set([trace.traceID, cause.traceID, response.traceID]).size,
    3,
  );
  assert(
    collection.archivedTraceIDs.has(cause.traceID),
    "original mutation not archived",
  );
  const mutation = collection.traces.get(cause.traceID),
    tree = traceTopology(mutation);
  const report = expected.offboarding;
  assert.equal(report.source_trace_id, cause.traceID);
  assert.equal(report.trace_id, cause.traceID);
  assert.equal(report.agent_id, expected.agentId);
  const offboarding = inspectOffboardingTrace(
    [mutation],
    {
      sourceID: cause.traceID,
      agentID: expected.agentId,
      requestID: report.request_id,
      ...(globalUser
        ? {
            ownerRevocation: {
              event: report.owner_revocation,
              ownerUserID: principal.user_id,
              organizationID: "",
              reason: kind,
            },
          }
        : {}),
    },
    secrets,
  );
  const schedule = one(
    mutation.spans.filter(
      (s) =>
        s.operationName === "agent_controller.identity_offboarding.disable" &&
        tag(s, "agent.id") === expected.agentId,
    ),
    "one actual directory Disable required",
  );
  const identity = one(
    tree
      .chain(schedule)
      .filter(
        (s) =>
          tree.service(s) === "identity-service" &&
          tag(s, "span.kind") === "server",
      ),
    "actual Identity mutation ancestor required",
  );
  for (const [field, value] of Object.entries({
    "http.route": globalUser
      ? "/rpc/identity/set-user-active"
      : "/rpc/identity/update-membership",
    "rpc.method": globalUser ? "set_user_active" : "update_membership",
    "http.request.method": "POST",
    "http.response.status_code": 200,
  }))
    assert.equal(tag(identity, field), value);
  const console = one(
    tree
      .chain(identity)
      .filter(
        (s) =>
          tree.service(s) === "admin-console" &&
          tag(s, "span.kind") === "server",
      ),
    "actual Console mutation ancestor required",
  );
  assert.equal(
    tag(console, "http.route"),
    globalUser
      ? "/api/admin/directory/users/{user_id}/active"
      : "/api/admin/directory/memberships/{membership_id}",
  );
  assert.equal(tag(console, "http.request.method"), "POST");
  assert.equal(tag(console, "http.response.status_code"), 200);
  const userProof = globalUser
    ? {
        ...inspectUserRevocationTransaction(mutation, identity),
        owner_revocation_sequence:
          offboarding.owner_revocation.data.identity_revocation_sequence,
      }
    : {};
  const mutationRoot = one(
    mutation.spans.filter((s) => !tree.parent(s)),
    "one mutation root required",
  );
  gatewayObservation(b, mutation, mutationRoot, cause);
  const denialTrace = collection.traces.get(response.traceID);
  const denial =
    response.status === 403
      ? inspectMembershipAccessDenial(
          denialTrace,
          response,
          secrets,
          collection,
        )
      : inspectGatewayIdentityRejection(
          denialTrace,
          { ...response, profile: "workspace", requestTimeoutMs: 5000 },
          collection,
          secrets,
        );
  gatewayObservation(
    b,
    denialTrace,
    traceTopology(denialTrace).spans.get(denial.root_span_id),
    response,
  );
  const allowed = new Set(),
    resolutions = [];
  let terminal;
  for (const decision of trace.spans
    .filter((s) => s.operationName === "gateway.identity.resolve")
    .sort((a, z) => a.startTime - z.startTime)) {
    assert(!terminal, "Resolve after terminal directory rejection");
    if (tag(decision, "antnest.identity.resolve.outcome") === "admitted")
      resolutions.push(
        inspectGatewayResolution(
          trace,
          {
            rootSpanID: b.root.spanID,
            decisionSpanID: decision.spanID,
            profile: "workspace",
            ttlMs: 10000,
          },
          collection,
        ),
      );
    else {
      terminal = inspectWorkspaceFailureReceipt(
        trace,
        b.root,
        decision,
        collection,
        5000,
      );
      assert.equal(terminal.record.outcome, "rejected");
      for (const span of terminal.currentSpans) allowed.add(span);
      resolutions.push(terminal.record);
    }
  }
  if (end(b.root) - b.root.startTime > 10000000) assert(resolutions.length > 1);
  const failedTransport = hasError(b.root) || hasError(b.upstream);
  const witness = inspectBrowserFeedWitness(b.root, {
    reason: cause.kind,
    sourceTraceID: cause.traceID,
    sourceSpanID: identity.spanID,
    principal,
    agentId: expected.agentId,
    mutationStart: mutationRoot.startTime,
    lowerBound: b.clock.lower(cause.startedMono),
    upperBound: b.clock.upper(closure.at),
    transportFailureAt: failedTransport
      ? b.upstream.logs?.[0]?.timestamp
      : undefined,
  });
  const feed = witness.event,
    gatewayRoot = witness.root;
  const markers = (b.ui.logs ?? []).filter((event) =>
    event.fields?.some(
      (field) =>
        field.key === "event" && field.value === "antnest.stream.termination",
    ),
  );
  assert(
    terminal || markers.length || feed,
    "directory closure lacks an original authorization termination witness",
  );
  if (!failedTransport)
    assert.equal(
      closure.kind,
      "remote-end",
      "normal close requires original EOF",
    );
  if ((!failedTransport && !feed) || markers.length) {
    const marker = one(
      markers,
      "one original UI access-denied witness required",
    );
    const fields = Object.fromEntries(
      marker.fields.map(({ key, value }) => [key, value]),
    );
    assert.equal(Object.keys(fields).length, marker.fields.length);
    assert.deepEqual(fields, {
      event: "antnest.stream.termination",
      reason: "access_denied",
      source: "agent-execution-state",
      "antnest.organization.id": principal.organization_id,
      "antnest.principal.id": principal.user_id,
      "antnest.agent.id": expected.agentId,
    });
    assert(
      Number.isFinite(marker.timestamp) &&
        marker.timestamp >= b.ui.startTime &&
        marker.timestamp <= end(b.ui),
    );
    const delta = (marker.timestamp - b.ui.startTime) / 1000;
    assert(
      checkpoint.stream.headers_at + delta >= cause.startedMono &&
        checkpoint.stream.started_at + delta <= closure.at,
      "UI witness outside actual mutation/closure window",
    );
  }
  if (failedTransport) {
    sseDiagnostics(gatewayRoot, b.upstream, { feedTermination: Boolean(feed) });
    allowed.add(b.root);
    allowed.add(b.upstream);
  }
  successful({
    ...b.ui,
    logs: (b.ui.logs ?? []).filter((event) => !markers.includes(event)),
  });
  for (const span of trace.spans)
    if (
      ["edge-gateway", "identity-service"].includes(b.tree.service(span)) &&
      !allowed.has(span)
    )
      successful(span === b.root ? gatewayRoot : span);
  return {
    trace_id: trace.traceID,
    reason: expected.reason,
    protocol_version: expected.protocolVersion,
    authorizationCauseVerified: true,
    closure: "silent",
    private_owner_close_verified: false,
    cause_proof: {
      kind: cause.kind,
      mutation_trace_id: cause.traceID,
      request_id: offboarding.request_id,
      identity_server_span_id: identity.spanID,
      ...userProof,
      ...(feed
        ? {
            feed_sequence: witness.sequence,
            feed_source_span_id: witness.sourceSpanID,
          }
        : {}),
    },
    gateway_resolution: resolutions[0],
    gateway_revalidations: resolutions.slice(1),
    denial,
    ...resolveTraceDiagnostics(trace, b.sources),
  };
}

export function inspectMembershipBrowserClosure(
  trace,
  expected,
  secrets,
  collection,
) {
  return inspectBrowserAccessClosure(
    trace,
    expected,
    secrets,
    collection,
    "membership_deactivated",
  );
}
export function inspectUserBrowserClosure(
  trace,
  expected,
  secrets,
  collection,
) {
  return inspectBrowserAccessClosure(
    trace,
    expected,
    secrets,
    collection,
    "user_deactivated",
  );
}
export function collectUserBrowserClosures(
  base,
  expectations,
  secrets,
  options = {},
) {
  return verifyIdentityEvidence(
    base,
    expectations.map((expected) => ({
      ...expected,
      relatedTraceIDs: [expected.cause.traceID, expected.denial.traceID],
    })),
    secrets,
    { ...options, inspect: inspectUserBrowserClosure },
  );
}

export function collectMembershipBrowserClosures(
  base,
  expectations,
  secrets,
  options = {},
) {
  return verifyIdentityEvidence(
    base,
    expectations.map((expected) => ({
      ...expected,
      relatedTraceIDs: [expected.cause.traceID, expected.denial.traceID],
    })),
    secrets,
    { ...options, inspect: inspectMembershipBrowserClosure },
  );
}
