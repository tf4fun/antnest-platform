import assert from "node:assert/strict";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import { resolveTraceSources } from "../../support/gateway-resolution-evidence.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
} from "../observability/trace-tree.mjs";
import {
  inspectWorkspaceRequestResolution,
  assertWorkspaceResolveReceipt,
} from "../workspace-closeout/request-trace.mjs";
import { inspectAuthorityOrigin } from "./resolve-cache-outage-authority.mjs";
import { inspectRecoveryWindow } from "./resolve-cache-recovery.mjs";

const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const end = (s) => s.startTime + s.duration;
const bound = (sent, decision, closed, origin) => {
  assert(Number.isFinite(sent) && Number.isFinite(closed));
  const valid = tag(decision, "antnest.identity.resolve.valid_for_ms");
  assert(Number.isFinite(valid) && valid > 0);
  const deadline = sent + valid;
  assert(
    closed < deadline,
    "remote retirement reached original authority lower bound",
  );
  return {
    ...origin,
    sent_at: sent,
    conservative_deadline: deadline,
    closed_at: closed,
  };
};

export function inspectRecoveryAuthorityCase(
  evidence,
  c,
  collection,
  secrets = [],
) {
  assert(
    [3, 4].includes(evidence.policy_revision),
    "unsupported recovery authority revision",
  );
  const bridge = evidence.policy_revision === 4;
  if (bridge) {
    assert.equal(evidence.transport, "http-sse");
    for (const wire of [evidence.wire, c.wire, c.wss_close])
      assert.equal(
        wire,
        undefined,
        "Bridge recovery contains retired WSS evidence",
      );
  } else
    assert.notEqual(
      evidence.transport,
      "http-sse",
      "Bridge recovery requires revision 4",
    );
  const get = (id) => {
    assert(
      collection.archivedTraceIDs.has(id),
      "original recovery authority not archived",
    );
    const t = collection.traces.get(id);
    assert(t, "original recovery authority missing");
    return t;
  };
  const all = resolveTraceSources(
    get(bridge ? c.session_create.trace_id : c.wire.upgrade.trace_id),
    secrets,
    collection,
  );
  const rootOf = (trace) => {
    const tree = traceTopology(trace),
      root = one(
        trace.spans.filter((s) => !tree.parent(s)),
        "one Gateway root required",
      );
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tag(root, "span.kind"), "server");
    return { tree, root };
  };
  const admission = (
    id,
    profile,
    route,
    service,
    receivingRoute,
    status,
    method = "GET",
  ) => {
    const trace = get(id),
      { tree, root } = rootOf(trace);
    assert.equal(tag(root, "http.route"), route);
    assert.equal(tag(root, "http.request.method"), method);
    assert.equal(tag(root, "http.response.status_code"), status);
    const server = one(
      trace.spans.filter(
        (s) =>
          tree.service(s) === service &&
          tag(s, "span.kind") === "server" &&
          tag(s, "http.route") === receivingRoute,
      ),
      "one original consumer admission required",
    );
    assert.equal(tag(server, "http.response.status_code"), status);
    assert.equal(tag(server, "http.request.method"), method);
    const upstream = tree.parent(server);
    assert.equal(tree.service(upstream), "edge-gateway");
    assert.equal(tag(upstream, "span.kind"), "client");
    assert.equal(tag(upstream, "http.request.method"), method);
    assert.equal(tag(upstream, "http.response.status_code"), status);
    assert.equal(tree.parent(upstream), root);
    const decision = one(
      trace.spans.filter(
        (s) =>
          s.operationName === "gateway.identity.resolve" &&
          tree.parent(s) === root &&
          end(s) <= upstream.startTime,
      ),
      "one original admission decision required",
    );
    assert(!hasError(decision));
    const result = inspectGatewayResolution(
      trace,
      {
        rootSpanID: root.spanID,
        upstreamSpanID: upstream.spanID,
        decisionSpanID: decision.spanID,
        profile,
        ttlMs: 10000,
      },
      collection,
    );
    assertWorkspaceResolveReceipt(trace, result, collection);
    if (result.rpc_client_span_id) {
      const source = get(result.source_trace_id),
        sourceTree = traceTopology(source);
      const client = sourceTree.spans.get(result.rpc_client_span_id),
        server = sourceTree.spans.get(result.identity_server_span_id);
      for (const span of [
        client,
        server,
        ...databaseChildrenTopology(source, server),
      ]) {
        assert(
          !hasError(span) &&
            tag(span, "otel.status_code") !== 2 &&
            tag(span, "error.type") === undefined &&
            !(tag(span, "http.response.status_code") >= 400),
          "failed original authority receipt",
        );
      }
    }
    return { trace, root, decision, result };
  };
  if (bridge) {
    assert.equal(evidence.settings.resolveTTLMS, 10000);
    assert.equal(evidence.settings.captureRpcContent, false);
    for (const trace of all)
      assert(
        collection.archivedTraceIDs.has(trace.traceID),
        "recovery authority trace not archived",
      );
    const scope = c.login.issued_credential_scope,
      base = `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}`;
    assert.match(scope ?? "", /^[a-f0-9-]{36}$/u);
    assert.equal(c.agent_id, evidence.agent_id);
    assert.equal(c.login.body.principal.active, true);
    assert.equal(c.owner_id, c.login.body.principal.user_id);
    for (const field of ["organization_id", "user_id", "membership_id"])
      assert(
        typeof c.login.body.principal[field] === "string" &&
          c.login.body.principal[field].length > 0,
      );
    const actual = (row, path, method, status) => {
      assert.deepEqual(
        one(
          evidence.http.filter((r) => r.trace_id === row.trace_id),
          "actual recovery admission missing or duplicated",
        ),
        row,
      );
      get(row.trace_id);
      assert.equal(row.path, path);
      assert.equal(row.method, method);
      assert.equal(row.status, status);
      assert.equal(row.credential_scope, scope);
      assert.equal(row.set_cookie_count, 0);
      assert(Number.isFinite(row.started_at) && Number.isFinite(row.at));
      assert(
        c.login.at <= row.started_at &&
          row.started_at <= row.at &&
          row.at < c.trigger.at,
        "original admission outside pre-mutation order",
      );
    };
    assert.deepEqual(
      one(
        evidence.http.filter((r) => r.trace_id === c.login.trace_id),
        "actual recovery login missing or duplicated",
      ),
      c.login,
    );
    get(c.login.trace_id);
    assert.equal(c.login.method, "POST");
    assert.equal(c.login.path, "/api/session/login");
    assert.equal(c.login.status, 200);
    assert.equal(c.login.set_cookie_count, 2);
    actual(c.session_create, `${base}/sessions`, "POST", 201);
    assert.deepEqual(c.session_create.request, {});
    assert.equal(c.session_create.body.sessionId, c.session_id);
    actual(
      c.initial_view,
      `${base}/sessions/${encodeURIComponent(c.session_id)}/view`,
      "GET",
      200,
    );
    assert.equal(c.initial_view.body.agentId, evidence.agent_id);
    assert.equal(c.initial_view.body.sessionId, c.session_id);
    assert(c.session_create.at <= c.initial_view.started_at);
    assert.equal(
      c.stream.path,
      `${base}/events?sessionId=${encodeURIComponent(c.session_id)}`,
    );
    assert.equal(c.stream.credential_scope, scope);
    assert.equal(c.stream.status, 200);
    assert.equal(c.stream.set_cookie_count, 0);
    assert(
      Number.isFinite(c.stream.started_at) &&
        Number.isFinite(c.stream.headers_at),
    );
    assert(
      c.initial_view.at <= c.stream.started_at &&
        c.stream.started_at <= c.stream.headers_at &&
        c.stream.headers_at < c.trigger.at,
    );
    assert.equal(
      new Set([
        c.session_create.trace_id,
        c.initial_view.trace_id,
        c.stream.trace_id,
      ]).size,
      3,
      "reused original admission Trace",
    );
    assert(
      ["remote-end", "transport-end"].includes(c.stream.closure?.kind),
      "actual remote SSE retirement missing",
    );
    assert.equal(
      c.stream.closure.trace_id,
      c.stream.trace_id,
      "foreign original SSE closure",
    );
    assert(
      c.trigger.at <= c.stream.closure.at,
      "stream closed before revocation",
    );
    const read = (row, method = "GET", status = 200) =>
      admission(
        row.trace_id,
        "workspace",
        "/api/app/workspace/v1/{path...}",
        "agent-ui",
        "/api/app/workspace/v1/*",
        status,
        method,
      );
    const source = read(c.session_create, "POST", 201),
      initial = read(c.initial_view),
      sse = read(c.stream);
    // Existing Bridge owners are valid here. These are two public workspace
    // admissions, not proof of a new private ACP initialize or its CCT lifetime.
    return {
      name: c.name,
      view_trace_id: c.initial_view.trace_id,
      sse_trace_id: c.stream.trace_id,
      session_create_trace_id: c.session_create.trace_id,
      view: bound(
        c.initial_view.started_at,
        initial.decision,
        c.stream.closure.at,
        inspectAuthorityOrigin(initial, source, all, get),
      ),
      sse: bound(
        c.stream.started_at,
        sse.decision,
        c.stream.closure.at,
        inspectAuthorityOrigin(sse, source, all, get),
      ),
    };
  }
  const scope = c.login.issued_credential_scope;
  assert.equal(c.wire.credential_scope, scope);
  assert.equal(c.stream.credential_scope, scope);
  assert.equal(c.initial_view.credential_scope, scope);
  assert.deepEqual(
    one(
      evidence.http.filter((r) => r.trace_id === c.initial_view.trace_id),
      "actual initial view missing",
    ),
    c.initial_view,
  );
  assert.equal(
    c.initial_view.path,
    `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}/sessions/${encodeURIComponent(c.session_id)}/view`,
  );
  assert.equal(c.initial_view.status, 200);
  assert.equal(c.initial_view.set_cookie_count, 0);
  const connection = admission(
    c.wire.upgrade.trace_id,
    "acp",
    "/api/app/agents/{agent_id}/v1/acp",
    "agent-acp-service",
    "/v1/acp",
    101,
  );
  const frames = c.wire.frames.map((f) => ({
    ...f,
    message: JSON.parse(f.raw),
  }));
  const first = frames.find((f) => f.direction === "send");
  assert.equal(first.message.method, "initialize");
  assert.notEqual(first.message.id, undefined);
  const reply = one(
    frames.filter(
      (f) => f.direction === "receive" && f.message.id === first.message.id,
    ),
    "original initialize reply missing",
  );
  assert(
    Object.hasOwn(reply.message, "result") &&
      !Object.hasOwn(reply.message, "error"),
  );
  assert(
    c.wire.upgrade.at <= first.at &&
      first.at <= reply.at &&
      reply.at < c.trigger.at,
    "original initialize outside pre-mutation connection order",
  );
  const trace = one(
    all.filter(
      (t) =>
        t.spans.some(
          (s) =>
            tag(s, "antnest.request.id") === String(first.message.id) &&
            tag(s, "rpc.method") === "initialize",
        ) &&
        t.spans.some((s) =>
          (s.references ?? []).some(
            (r) =>
              r.refType === "FOLLOWS_FROM" &&
              r.traceID === c.wire.upgrade.trace_id,
          ),
        ),
    ),
    "original initialize Trace missing or ambiguous",
  );
  const { tree, root } = rootOf(trace);
  assert.deepEqual(
    root.references.filter((r) => r.refType === "FOLLOWS_FROM"),
    [
      {
        refType: "FOLLOWS_FROM",
        traceID: connection.trace.traceID,
        spanID: connection.root.spanID,
      },
    ],
  );
  const result = inspectWorkspaceRequestResolution(
    trace,
    {
      traceID: trace.traceID,
      method: "initialize",
      requestId: String(first.message.id),
      transport: "websocket",
      agentId: evidence.agent_id,
      connectionTraceID: connection.trace.traceID,
      resolveTTLMS: 10000,
    },
    secrets,
    collection,
  );
  const decision = tree.spans.get(result.decision_span_id);
  assert(!trace.spans.some(hasError), "failed original initialize");
  const wssOrigin = inspectAuthorityOrigin(
    { trace, decision, result },
    connection,
    all,
    get,
  );
  const initial = admission(
    c.initial_view.trace_id,
    "workspace",
    "/api/app/workspace/v1/{path...}",
    "agent-ui",
    "/api/app/workspace/v1/*",
    200,
  );
  const sse = admission(
    c.stream.trace_id,
    "workspace",
    "/api/app/workspace/v1/{path...}",
    "agent-ui",
    "/api/app/workspace/v1/*",
    200,
  );
  const sseOrigin = inspectAuthorityOrigin(sse, initial, all, get);
  return {
    name: c.name,
    wss: bound(first.at, decision, c.wss_close.observed_at, wssOrigin),
    sse: bound(
      c.stream.started_at,
      sse.decision,
      c.stream.closure.at,
      sseOrigin,
    ),
  };
}

export function inspectRecoveryAuthority(evidence, collection, secrets = []) {
  if (evidence.policy_revision === 4) inspectRecoveryWindow(evidence);
  return {
    status: "passed",
    cases: evidence.recovery.cases.map((c) =>
      inspectRecoveryAuthorityCase(evidence, c, collection, secrets),
    ),
  };
}
