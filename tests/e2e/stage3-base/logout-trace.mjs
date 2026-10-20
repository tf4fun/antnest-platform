import assert from "node:assert/strict";
import { inspectLifecycle, inspectLifecycleResolution } from "./trace.mjs";
import { inspectRuntimeInformationRead } from "../observability/runtime-information-read.mjs";
import { inspectBridgeSessionBoundary } from "../identity-closeout/bridge-session-trace.mjs";
import { inspectBrowserFeedWitness } from "../identity-closeout/browser-feed-witness.mjs";
import { inspectLogoutMutation } from "../edge-gateway/resolve-cache-recovery-http.mjs";
import {
  inspectGatewayIdentityRejection,
  inspectWorkspaceFailureReceipt,
} from "../edge-gateway/resolve-cache-outage-rejection.mjs";
import {
  sseDiagnostics,
  tokenRead,
} from "../edge-gateway/resolve-cache-outage-stream.mjs";
import { verifyIdentityEvidence } from "../identity-closeout/trace.mjs";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import { resolveTraceDiagnostics } from "../../support/gateway-resolution-evidence.mjs";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
} from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { assertSessionSuccess as successful } from "../identity-closeout/session-diagnostics.mjs";
const prefix = "antnest.identity.resolve.";
const resolveTimeoutMS = 5000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const finite = (n) =>
  assert(Number.isFinite(n), "missing Session observation time");
const end = (s) => s.startTime + s.duration;
const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const fields = (rows) => {
  const result = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  assert.equal(
    Object.keys(result).length,
    rows.length,
    "duplicate Session diagnostic field",
  );
  return result;
};
function processIdentity(trace, span) {
  const process = trace.processes[span.processID],
    tags = fields(process.tags ?? []);
  for (const key of ["host.name", "service.instance.id"])
    assert(
      typeof tags[key] === "string" && tags[key],
      "missing service process identity",
    );
  assert(Number.isSafeInteger(tags["process.pid"]) && tags["process.pid"] > 0);
  return [
    process.serviceName,
    tags["host.name"],
    tags["process.pid"],
    tags["service.instance.id"],
  ];
}
function sameProcess(trace, span, otherTrace, otherSpan) {
  assert.deepEqual(
    processIdentity(trace, span),
    processIdentity(otherTrace, otherSpan),
    "different service process",
  );
}

function observation(row) {
  for (const key of [
    "startedMono",
    "completedMono",
    "startedAt",
    "completedAt",
  ])
    finite(row[key]);
  assert(
    row.completedMono >= row.startedMono && row.completedAt >= row.startedAt,
    "HTTP receipt completed before dispatch",
  );
  const date = Date.parse(row.serverDate);
  assert(
    Number.isFinite(date) && new Date(date).toUTCString() === row.serverDate,
    "actual HTTP Date missing",
  );
}
function observedGateway(boundary, trace, root, receipt) {
  sameProcess(boundary.trace, boundary.root, trace, root);
  assert(
    root.startTime >= boundary.clock.lower(receipt.startedMono) &&
      root.startTime <= boundary.clock.upper(receipt.completedMono),
    "HTTP root outside actual observed request",
  );
  assert(
    end(root) <= boundary.clock.upper(receipt.completedMono),
    "HTTP completion outside actual receipt",
  );
}
function refusalSource(result, collection) {
  const record = result.resolution,
    trace = collection.traces.get(record.source_trace_id),
    tree = traceTopology(trace);
  return {
    trace,
    tree,
    client: tree.spans.get(record.rpc_client_span_id),
    server: tree.spans.get(record.identity_server_span_id),
    sql: tree.spans.get(record.token_read_span_id),
  };
}

// Agent Delete is deliberately later than browser Logout. Its publication may
// end Bridge's retained private notification streams; this does not prove that
// Logout drained the shared owner. Bind only this exact internal denial.
export function inspectStage3StreamDenial(
  b,
  span,
  expected,
  collection,
  secrets,
) {
  const lifecycle = expected.closingLifecycle;
  assert.equal(lifecycle?.kind, "delete");
  assert.equal(lifecycle.agentId, expected.agentId);
  assert(
    collection.archivedTraceIDs.has(lifecycle.traceID),
    "original Delete not archived",
  );
  const deletion = collection.traces.get(lifecycle.traceID);
  inspectLifecycle(deletion, lifecycle, secrets);
  const tree = traceTopology(deletion);
  const root = one(
    deletion.spans.filter((s) => !tree.parent(s)),
    "one Delete root",
  );
  sameProcess(b.trace, b.root, deletion, root);
  assert(
    end(b.root) <= root.startTime,
    "Delete cannot stand in for browser Logout",
  );
  const settlement = one(
    deletion.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" &&
        tag(s, "rpc.method") === "settle_agent" &&
        tag(s, "span.kind") === "server",
    ),
    "one actual Delete settlement",
  );
  assert.equal(tag(settlement, "antnest.agent.id"), expected.agentId);
  assert.equal(
    tag(settlement, "antnest.organization.id"),
    expected.principal.organization_id,
  );
  const revision = tag(settlement, "antnest.configuration.revision");
  assert(Number.isSafeInteger(revision) && revision > 0);
  const publication = deletion.spans
    .filter(
      (s) =>
        tree.service(s) === "agent-acp-service" &&
        tag(s, "rpc.method") === "apply_execution_snapshot" &&
        tag(s, "span.kind") === "server" &&
        tag(s, "antnest.configuration.revision") === revision,
    )
    .sort((a, z) => a.startTime - z.startTime)
    .at(0);
  assert(publication, "original Delete access publication missing");
  assert.equal(
    tag(publication, "antnest.organization.id"),
    expected.principal.organization_id,
  );
  sameProcess(deletion, publication, deletion, settlement);
  sameProcess(b.trace, span, deletion, settlement);
  assert.equal(b.tree.parent(span), b.ui);
  assert.equal(span.operationName, "HTTP GET /v1/acp");
  for (const [key, value] of Object.entries({
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "/v1/acp",
    "antnest.listener": "workspace",
  }))
    assert.equal(tag(span, key), value);
  assert.equal(tag(span, "http.response.status_code"), 200);
  for (const key of [
    "rpc.method",
    "rpc.service",
    "rpc.system.name",
    "antnest.operation.phase",
  ])
    assert.equal(tag(span, key), undefined);
  assert.equal(span.events?.length ?? 0, 0);
  const event = one(span.logs ?? [], "one exact Agent denial termination");
  assert.deepEqual(fields(event.fields), {
    event: "antnest.stream.termination",
    reason: "access_denied",
    "error.type": "DomainError",
    source: "learning-notice",
    "antnest.agent.id": expected.agentId,
    "antnest.organization.id": expected.principal.organization_id,
  });
  // Delete removes the Principal in its initial access snapshot. A notice read
  // can observe it before settlement or the final publication responds. Bind
  // the first publication of the settled revision, not those later responses.
  assert(
    Number.isFinite(event.timestamp) &&
      event.timestamp >= publication.startTime &&
      event.timestamp >= span.startTime &&
      event.timestamp <= end(span),
    "Agent denial outside original Delete publication",
  );
  const diagnostics = {
    error: true,
    "otel.status_code": "ERROR",
    "error.type": "stream_interrupted",
    "antnest.outcome": "disconnected",
  };
  for (const [key, value] of Object.entries(diagnostics))
    assert.equal(tag(span, key), value);
  successful({ ...span, logs: [] }, diagnostics);
  return {
    trace_id: b.trace.traceID,
    span_id: span.spanID,
    reason: "deleted-agent-access-denied",
    delete_trace_id: deletion.traceID,
    settlement_span_id: settlement.spanID,
    publication_span_id: publication.spanID,
    configuration_revision: revision,
  };
}

// Deliberately narrow: original browser EOF/abort, committed Logout, then an
// actual post-close HTTP 401 using that same Cookie. No SDK close substitution.
export function inspectStage3Logout(trace, expected, secrets, collection) {
  assert.equal(expected.reason, "revoked");
  const b = inspectBridgeSessionBoundary(trace, expected, secrets, collection);
  const { checkpoint, closure, denial: response, cause } = expected;
  for (const key of ["organization_id", "user_id"])
    assert(
      typeof expected.principal?.[key] === "string" && expected.principal[key],
      "original principal missing",
    );
  observation(response);
  assert.equal(
    response.path,
    `/api/app/workspace/v1/agents/${encodeURIComponent(expected.agentId)}/sessions/${encodeURIComponent(expected.sessionId)}/prompts`,
  );
  assert.equal(response.credentialScope, expected.credentialScope);
  assert.equal(response.noStore, true);
  assert.equal(response.setCookieCount, 0);
  assert.match(response.intentId ?? "", uuid);
  assert(
    response.startedMono >= closure.at,
    "denial preceded original remote close",
  );
  assert.notEqual(
    response.traceID,
    trace.traceID,
    "denial reuses the original stream",
  );
  const denialTrace = collection.traces.get(response.traceID);
  const denial = inspectGatewayIdentityRejection(
    denialTrace,
    { ...response, profile: "workspace", requestTimeoutMs: resolveTimeoutMS },
    collection,
    secrets,
  );
  assert.equal(denial.status, expected.reason === "unavailable" ? 503 : 401);
  const denialRoot = traceTopology(denialTrace).spans.get(denial.root_span_id);
  observedGateway(b, denialTrace, denialRoot, response);
  const refusal = refusalSource(denial, collection);
  const decisions = trace.spans
    .filter((s) => s.operationName === "gateway.identity.resolve")
    .sort((x, y) => x.startTime - y.startTime);
  const records = [],
    allowed = new Set(),
    currentClients = new Set([b.upstream]),
    rpcCreators = new Set();
  const claimClient = (decision, source, client) => {
    if (source === trace) currentClients.add(client);
    if (tag(decision, prefix + "source") !== "rpc") return;
    const key = `${source.traceID}:${client.spanID}`;
    assert(!rpcCreators.has(key), "multiple rpc decisions claim one CLIENT");
    rpcCreators.add(key);
  };
  let terminal;
  for (const decision of decisions) {
    assert(!terminal, "Resolve continued after terminal Session failure");
    assert.equal(
      decision.processID,
      b.root.processID,
      "foreign Gateway Resolve process",
    );
    const outcome = tag(decision, prefix + "outcome");
    if (outcome === "admitted") {
      const record = inspectGatewayResolution(
        trace,
        {
          rootSpanID: b.root.spanID,
          decisionSpanID: decision.spanID,
          profile: "workspace",
          ttlMs: 10000,
        },
        collection,
      );
      if (record.rpc_client_span_id) {
        const source = collection.traces.get(record.source_trace_id),
          tree = traceTopology(source);
        const client = tree.spans.get(record.rpc_client_span_id),
          server = tree.spans.get(record.identity_server_span_id);
        sameProcess(trace, b.root, source, client);
        claimClient(decision, source, client);
        const sql = one(
          databaseChildrenTopology(source, server),
          "one admitted Session token read required",
        );
        assert.equal(tag(sql, "db.operation.name"), "SELECT");
        assert.equal(tag(sql, "pgx.rows_affected"), 1);
        assert.equal(
          tag(sql, "db.query.text")?.replace(/\s+/gu, " ").trim(),
          tokenRead,
          "actual browser token SELECT required",
        );
        for (const span of [client, server, sql]) successful(span);
      }
      records.push(record);
    } else {
      assert(
        decision.startTime >= b.upstream.startTime,
        "failed initial Session admission",
      );
      terminal = inspectWorkspaceFailureReceipt(
        trace,
        b.root,
        decision,
        collection,
        resolveTimeoutMS,
      );
      claimClient(decision, terminal.trace, terminal.client);
      for (const span of terminal.currentSpans) allowed.add(span);
      records.push(terminal.record);
    }
  }
  const gatewayClients = trace.spans.filter(
    (span) =>
      b.tree.service(span) === "edge-gateway" &&
      tag(span, "span.kind") === "client",
  );
  assert(
    gatewayClients.length === currentClients.size &&
      gatewayClients.every((span) => currentClients.has(span)),
    "unclaimed Gateway CLIENT in original Session stream",
  );
  if (end(b.root) - b.root.startTime > 10000000)
    assert(records.length > 1, "long Session stream lacks revalidation");
  let causeProof, feedWitness;
  assert.equal(cause.kind, "logout");
  observation(cause);
  assert.equal(cause.credentialScope, expected.credentialScope);
  for (const key of ["organization_id", "user_id"])
    assert.equal(cause.principal[key], expected.principal[key]);
  assert(
    checkpoint.at <= cause.startedMono &&
      cause.startedMono <= closure.at &&
      cause.completedMono <= response.startedMono,
    "logout outside original close and denial interval",
  );
  assert.notEqual(cause.traceID, trace.traceID);
  assert.notEqual(cause.traceID, response.traceID);
  const mutationTrace = collection.traces.get(cause.traceID);
  const mutation = inspectLogoutMutation(
    mutationTrace,
    cause,
    collection,
    secrets,
  );
  const tree = traceTopology(mutationTrace),
    server = tree.spans.get(mutation.identity_server_span_id),
    commit = tree.spans.get(mutation.commit_span_id);
  const root = one(
    mutationTrace.spans.filter((s) => !tree.parent(s)),
    "one actual logout root required",
  );
  observedGateway(b, mutationTrace, root, cause);
  assert(
    tree.parent(server).startTime <= end(b.root),
    "logout command dispatched after stream ended",
  );
  const afterCommit = (receipt) => {
    sameProcess(mutationTrace, server, receipt.trace, receipt.server);
    assert(
      receipt.sql.startTime >= end(commit),
      "refusal SQL preceded committed logout",
    );
  };
  afterCommit(refusal);
  if (terminal) {
    assert.equal(terminal.record.outcome, "rejected");
    afterCommit(terminal);
  }
  feedWitness = inspectBrowserFeedWitness(b.root, {
    reason: "session_revoked",
    sourceTraceID: mutation.trace_id,
    sourceSpanID: server.spanID,
    principal: expected.principal,
    agentId: expected.agentId,
    mutationStart: root.startTime,
    lowerBound: b.clock.lower(cause.startedMono),
    upperBound: b.clock.upper(closure.at),
    transportFailureAt: b.upstream.logs?.[0]?.timestamp,
  });
  causeProof = {
    kind: "logout",
    mutation_trace_id: mutation.trace_id,
    commit_span_id: commit.spanID,
    post_close_token_read_span_id: refusal.sql.spanID,
    ...(feedWitness.event
      ? {
          feed_sequence: feedWitness.sequence,
          feed_source_span_id: feedWitness.sourceSpanID,
        }
      : {}),
  };

  assert(
    feedWitness.event,
    "Stage3 Logout requires its actual winning Session feed witness",
  );
  assert(
    hasError(b.root) || hasError(b.upstream),
    "Logout must terminate the actual Gateway stream",
  );
  sseDiagnostics(feedWitness.root, b.upstream, { feedTermination: true });
  allowed.add(b.root);
  allowed.add(b.upstream);
  const neutral = new Set(),
    neutralRecords = [],
    timeObservations = [];
  for (const span of trace.spans)
    if (
      b.tree.service(span) === "agent-acp-service" &&
      span.operationName === "mcp.runtime.info.read"
    ) {
      const proof = inspectRuntimeInformationRead(trace, span),
        request = proof.request,
        method = tag(request, "rpc.method");
      assert.equal(proof.agentId, expected.agentId);
      assert.equal(tag(request, "antnest.agent.id"), expected.agentId);
      assert.equal(tag(request, "span.kind"), "server");
      assert(["initialize", "session/load"].includes(method));
      assert.equal(tag(request, "rpc.system.name"), "jsonrpc");
      assert.equal(tag(request, "rpc.service"), "acp");
      // Agent UI's Bridge always uses ACP /v1/acp, independently of the
      // browser fixture's legacy protocol version.
      assert.equal(tag(request, "antnest.protocol.version"), "v1");
      if (method === "session/load")
        assert.equal(tag(request, "antnest.session.id"), expected.sessionId);
      assert(
        typeof tag(request, "antnest.request.id") === "string" &&
          tag(request, "antnest.request.id").length > 0,
        "missing original ACP request identity",
      );
      let receiver = request;
      if (request.operationName !== "HTTP POST /v1/acp") {
        assert.equal(request.operationName, `acp ${method}`);
        for (const name of [
          "http.request.method",
          "http.route",
          "http.response.status_code",
          "antnest.listener",
        ])
          assert.equal(
            tag(request, name),
            undefined,
            "HTTP attributes on queued RPC",
          );
        // The SDK carries the accepting POST through RPC metadata. That
        // HTTP202 may finish before this queued dispatch, so parent identity
        // is required without imposing synchronous lifetime containment.
        receiver = b.tree.parent(request);
        assert.equal(
          receiver?.processID,
          request.processID,
          "foreign ACP receiver process",
        );
        assert(
          receiver.startTime <= request.startTime,
          "queued RPC starts before its HTTP receiver",
        );
      }
      assert.equal(b.tree.service(receiver), "agent-acp-service");
      assert.equal(receiver.operationName, "HTTP POST /v1/acp");
      assert.equal(tag(receiver, "span.kind"), "server");
      assert.equal(tag(receiver, "http.request.method"), "POST");
      assert.equal(tag(receiver, "http.route"), "/v1/acp");
      assert.equal(tag(receiver, "antnest.listener"), "workspace");
      assert.equal(
        tag(receiver, "http.response.status_code"),
        receiver === request ? 200 : 202,
      );
      assert.equal(
        b.tree.parent(receiver),
        b.ui,
        "Runtime read outside original UI request",
      );
      for (const owned of proof.spans) neutral.add(owned);
      neutralRecords.push(...proof.neutralDiagnostics);
      timeObservations.push(...proof.timeObservations);
    }
  const privateTerminations = [];
  for (const span of trace.spans) {
    if (allowed.has(span) || neutral.has(span)) continue;
    if (
      hasError(span) &&
      b.tree.service(span) === "agent-acp-service" &&
      span.operationName === "HTTP GET /v1/acp"
    )
      privateTerminations.push(
        inspectStage3StreamDenial(b, span, expected, collection, secrets),
      );
    else successful(span);
  }
  if (privateTerminations.length)
    inspectLifecycleResolution(
      collection.traces.get(expected.closingLifecycle.traceID),
      expected.closingLifecycle,
      secrets,
      collection,
    );
  return {
    trace_id: trace.traceID,
    reason: "revoked",
    protocol_version: expected.protocolVersion,
    authorizationCauseVerified: true,
    owning_admission: "passed",
    neutral_diagnostics: neutralRecords,
    time_observations: timeObservations,
    closure: "silent",
    private_owner_close_verified: false,
    private_stream_terminations: privateTerminations,
    gateway_resolution: records[0],
    gateway_revalidations: records.slice(1),
    cause_proof: causeProof,
    denial,
    ...resolveTraceDiagnostics(trace, b.sources),
  };
}
export function collectStage3Logouts(
  base,
  expectations,
  secrets,
  options = {},
) {
  return verifyIdentityEvidence(
    base,
    expectations.map((expected) => ({
      ...expected,
      relatedTraceIDs: [
        expected.cause.traceID,
        expected.denial.traceID,
        expected.closingLifecycle?.traceID,
      ].filter(Boolean),
    })),
    secrets,
    { ...options, inspect: inspectStage3Logout },
  );
}
