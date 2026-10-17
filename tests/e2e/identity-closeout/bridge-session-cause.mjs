import assert from "node:assert/strict";
import { inspectBridgeSessionBoundary } from "./bridge-session-trace.mjs";
import { inspectBridgeSessionOwnerClose } from "./bridge-session-owner-close.mjs";
import { checkedAcknowledgement } from "./session-fault-lifecycle.mjs";
import { verifyIdentityEvidence } from "./trace.mjs";
import {
  inspectLogoutMutation,
  committedTransaction,
} from "../edge-gateway/resolve-cache-recovery-http.mjs";
import {
  inspectGatewayIdentityRejection,
  inspectWorkspaceFailureReceipt,
} from "../edge-gateway/resolve-cache-outage-rejection.mjs";
import {
  sseDiagnostics,
  tokenRead,
} from "../edge-gateway/resolve-cache-outage-stream.mjs";
import { inspectRuntimeInformationRead } from "../observability/runtime-information-read.mjs";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import { resolveTraceDiagnostics } from "../../support/gateway-resolution-evidence.mjs";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
  owningServerTopology,
} from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { assertSessionSuccess as successful } from "./session-diagnostics.mjs";

const prefix = "antnest.identity.resolve.";
const resolveTimeoutMS = 5000;
const loginTokenInsert =
  "INSERT INTO api_tokens ( id,token_hash,user_id,organization_id,membership_id,issued_at,expires_at, public_session_id,idle_expires_at,last_used_at,user_agent_hint ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$10) RETURNING expires_at,idle_expires_at";
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

function history(expected) {
  const { project, runID } = expected.deployment ?? {};
  assert.match(project ?? "", /^antnest-stage3-e2e-\d+$/u);
  assert.match(runID ?? "", uuid);
  const transitions = expected.identityTransitions;
  assert(
    Array.isArray(transitions) &&
      transitions.length >= 2 &&
      transitions.length <= 3,
    "actual Identity transition history missing",
  );
  const nonces = new Set();
  let previous;
  for (const [index, transition] of transitions.entries()) {
    const step = index + 1,
      nonce = transition.deployment.request?.nonce;
    assert.match(nonce ?? "", uuid);
    assert(!nonces.has(nonce), "reused Identity fault request nonce");
    nonces.add(nonce);
    checkedAcknowledgement(
      transition.deployment,
      { version: 1, project, run_id: runID, step, nonce },
      previous,
    );
    const observation = transition.observation;
    assert.equal(observation.clock, "session-client");
    for (const point of [observation.requested, observation.acknowledged]) {
      finite(point.at);
      finite(point.observed_at_ms);
    }
    assert(observation.acknowledged.at >= observation.requested.at);
    assert(observation.acknowledged.at < observation.requested.at + 90000);
    if (previous)
      assert(observation.requested.at >= previous.observation.acknowledged.at);
    previous = transition;
  }
  return transitions;
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

function originalShortLogin(boundary, expected, collection, refusal) {
  const issuance = expected.checkpoint.issuance;
  const trace = collection.traces.get(issuance.traceID);
  assert(
    trace && collection.archivedTraceIDs.has(issuance.traceID),
    "original login Trace not collected and archived",
  );
  assert.notEqual(trace.traceID, boundary.trace.traceID);
  assert.notEqual(trace.traceID, expected.denial.traceID);
  const tree = traceTopology(trace);
  const root = one(
    trace.spans.filter((span) => !tree.parent(span)),
    "one original login Gateway root required",
  );
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.route"), "/api/session/login");
  assert.equal(tag(root, "http.request.method"), "POST");
  assert.equal(tag(root, "http.response.status_code"), 200);
  observedGateway(boundary, trace, root, issuance);
  assert(
    end(root) <= boundary.root.startTime,
    "original login followed SSE dispatch",
  );
  const { server, database } = owningServerTopology(trace, {
    service: "identity-service",
    route: "/rpc/identity/local-login",
    method: "POST",
    rpcMethod: "local_login",
    clientService: "edge-gateway",
  });
  const client = tree.parent(server);
  assert.equal(tree.parent(client), root);
  assert.equal(client.processID, root.processID);
  assert(client.startTime >= root.startTime && end(client) <= end(root));
  for (const span of [client, server])
    assert.equal(tag(span, "http.response.status_code"), 200);
  assert.deepEqual(
    trace.spans.filter(
      (span) =>
        tree.service(span) === "edge-gateway" &&
        tag(span, "span.kind") === "client",
    ),
    [client],
    "unrelated login Gateway CLIENT",
  );
  const { transaction, sql } = committedTransaction(
    trace,
    tree,
    server,
    database,
  );
  assert.equal(
    sql.length,
    database.length,
    "login SQL outside actual transaction",
  );
  const inserted = one(
    sql.filter(
      (span) =>
        tag(span, "db.query.text")?.replace(/\s+/gu, " ").trim() ===
        loginTokenInsert,
    ),
    "one committed original token INSERT required",
  );
  assert.equal(tag(inserted, "db.operation.name"), "INSERT");
  assert.equal(tag(inserted, "pgx.rows_affected"), 1);
  sameProcess(trace, server, refusal.trace, refusal.server);
  // The issued ISO timestamp was read as integer milliseconds. Its one-ms
  // bucket must overlap this Identity login, without adjusting any raw span.
  const issuedAt = (expected.checkpoint.expiresAt - 5000) * 1000;
  assert(
    issuedAt + 1000 > server.startTime && issuedAt <= end(server),
    "short token expiry does not belong to original login",
  );
  for (const span of trace.spans) successful(span);
  return {
    trace_id: trace.traceID,
    identity_server_span_id: server.spanID,
    transaction_span_id: transaction.spanID,
    token_insert_span_id: inserted.spanID,
    commit_span_id: sql.at(-1).spanID,
  };
}

export function inspectBridgeSessionClosure(
  trace,
  expected,
  secrets,
  collection,
) {
  const b = inspectBridgeSessionBoundary(trace, expected, secrets, collection);
  const ownerNodes = new Set();
  let ownerClose;
  if (collection.sessionOwnerContext) {
    const observed = one(
      collection.sessionOwnerContext.closures.filter(
        (item) => item.traceID === expected.traceID,
      ),
      "owner context lacks the original Session observation",
    );
    assert.deepEqual(
      observed,
      expected,
      "owner context substitutes another observation",
    );
    const { nodes, ...proof } = inspectBridgeSessionOwnerClose(
      collection.sessionOwnerContext,
      collection,
      secrets,
    );
    ownerClose = proof;
    for (const row of nodes) if (row.trace === trace) ownerNodes.add(row.span);
  } else {
    assert(
      !trace.spans.some(
        (span) =>
          span.operationName === "HTTP GET /v1/acp" ||
          (tag(span, "http.route") === "/v1/acp" &&
            tag(span, "http.request.method") === "GET") ||
          tag(span, "rpc.method") === "watch_agent_execution_state",
      ),
      "private Session work requires actual owner evidence",
    );
  }
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
  let causeProof;
  if (expected.reason === "revoked") {
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
    causeProof = {
      kind: "logout",
      mutation_trace_id: mutation.trace_id,
      commit_span_id: commit.spanID,
      post_close_token_read_span_id: refusal.sql.spanID,
    };
  } else if (expected.reason === "unavailable") {
    assert.equal(cause.kind, "identity-outage");
    const transitions = history(expected),
      stop = transitions[0],
      restart = transitions[1];
    assert.deepEqual(cause.transition, stop, "different actual stop receipt");
    const start = stop.observation.acknowledged.at,
      finish = restart.observation.requested.at;
    assert(
      checkpoint.at <= stop.observation.requested.at &&
        closure.at >= start &&
        response.completedMono <= finish,
      "Session outage crosses the stopped interval",
    );
    assert(
      terminal && terminal.record.outcome === "unavailable",
      "outage needs actual terminal unavailable Resolve",
    );
    for (const receipt of [terminal, refusal]) {
      sameProcess(trace, b.root, receipt.trace, receipt.client);
      assert(
        receipt.client.startTime >= b.clock.upper(start) &&
          end(receipt.client) <= b.clock.lower(finish),
        "actual failed RPC outside independently stopped Identity interval",
      );
    }
    causeProof = {
      kind: "identity-outage",
      stopped_container_id: stop.deployment.after.container_id,
      stop_request_nonce: stop.deployment.request.nonce,
      restart_request_nonce: restart.deployment.request.nonce,
      stopped_interval: { clock: "session-client", start, end: finish },
      failed_rpc_span_id: terminal.client.spanID,
    };
  } else {
    assert.equal(cause.kind, "absolute-expiry");
    assert.equal(cause.expiresAt, checkpoint.expiresAt);
    const rebuilt = history(expected)[1];
    assert.deepEqual(
      cause.transition,
      rebuilt,
      "original short-TTL deployment missing",
    );
    assert.equal(rebuilt.deployment.after.token_ttl, "5s");
    const issuance = checkpoint.issuance;
    assert(issuance, "original short Session login receipt missing");
    finite(issuance.startedMono);
    finite(issuance.completedMono);
    assert.match(issuance.traceID ?? "", /^[a-f0-9]{32}$/u);
    assert(
      rebuilt.observation.acknowledged.at <= issuance.startedMono &&
        issuance.startedMono <= issuance.completedMono &&
        issuance.completedMono <= checkpoint.stream.started_at,
      "short Session login outside deployment and original SSE interval",
    );
    const login = originalShortLogin(b, expected, collection, refusal);
    assert(
      response.startedMono > checkpoint.stream.headers_at + 17000,
      "denial preceded original authority/cache upper bound",
    );
    assert(
      refusal.sql.startTime >= checkpoint.expiresAt * 1000,
      "refusal token SELECT preceded original expiry",
    );
    if (terminal) {
      assert.equal(terminal.record.outcome, "rejected");
      assert(terminal.sql.startTime >= checkpoint.expiresAt * 1000);
    }
    causeProof = {
      kind: "absolute-expiry",
      expires_at_unix_ms: checkpoint.expiresAt,
      original_delegation: b.delegation,
      original_login: login,
      post_close_token_read_span_id: refusal.sql.spanID,
      short_ttl_container_id: rebuilt.deployment.after.container_id,
    };
  }
  const aborted = hasError(b.root) || hasError(b.upstream);
  if (aborted) {
    sseDiagnostics(b.root, b.upstream);
    allowed.add(b.root);
    allowed.add(b.upstream);
  } else {
    assert.equal(
      expected.reason,
      "expired",
      "Session logout/outage requires its actual Gateway abort",
    );
    assert.equal(
      closure.kind,
      "remote-end",
      "normal expiry requires remote EOF",
    );
  }
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
  for (const span of trace.spans)
    if (!allowed.has(span) && !neutral.has(span) && !ownerNodes.has(span))
      successful(span);
  return {
    trace_id: trace.traceID,
    reason: expected.reason,
    protocol_version: expected.protocolVersion,
    authorizationCauseVerified: true,
    closure: "silent",
    gateway_resolution: records[0],
    gateway_revalidations: records.slice(1),
    cause_proof: causeProof,
    denial,
    neutral_diagnostics: neutralRecords,
    time_observations: timeObservations,
    ...(ownerClose ? { owner_close: ownerClose } : {}),
    spans: trace.spans.length,
    ...resolveTraceDiagnostics(trace, b.sources),
  };
}

export async function collectBridgeSessionClosure(
  base,
  expected,
  secrets,
  options = {},
) {
  const relatedTraceIDs = [
    expected.denial.traceID,
    ...(expected.reason === "revoked" ? [expected.cause.traceID] : []),
    ...(expected.reason === "expired"
      ? [expected.checkpoint.issuance.traceID]
      : []),
  ];
  const [result] = await verifyIdentityEvidence(
    base,
    [{ ...expected, relatedTraceIDs }],
    secrets,
    { ...options, inspect: inspectBridgeSessionClosure },
  );
  return result;
}
