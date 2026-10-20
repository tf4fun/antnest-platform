import assert from "node:assert/strict";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { inspectEmptySessionFeed } from "../identity-closeout/organization-freshness.mjs";
import { inspectWorkspaceRequestResolution } from "../workspace-closeout/request-trace.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import {
  databaseChildrenTopology,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";

const prefix = "antnest.identity.resolve.";
const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const finite = (n) =>
  assert(Number.isFinite(n), "missing monotonic observation time");
const end = (s) => {
  assert(
    Number.isFinite(s.startTime) &&
      Number.isFinite(s.duration) &&
      s.duration >= 0,
    "unfinished authority span",
  );
  return s.startTime + s.duration;
};
function successful(spans) {
  for (const s of spans) {
    assert(
      !hasError(s) &&
        tag(s, "otel.status_code") !== 2 &&
        tag(s, "error.type") === undefined &&
        !(tag(s, "http.response.status_code") >= 400) &&
        !(s.logs ?? []).some((event) =>
          (event.fields ?? []).some(
            (field) =>
              /^(severity|severity_text|level)$/u.test(field.key) &&
              /^(ERROR|FATAL)$/iu.test(String(field.value)),
          ),
        ),
      "failed authority request, receiver or SQL",
    );
    end(s);
  }
}
const intersects = (a, b) => Math.max(a[0], b[0]) <= Math.min(a[1], b[1]);

// Gateway ages are double milliseconds sampled at one instant within its own
// decision. Jaeger serializes span timestamps in integer microseconds; this
// covers that conversion only, not clock skew between services or Node timing.
function ageInterval(decision, key) {
  const age = tag(decision, prefix + key);
  assert(Number.isFinite(age) && age >= 0, "invalid cache age");
  return [decision.startTime - age * 1000 - 1, end(decision) - age * 1000 + 1];
}

export function inspectAuthorityOrigin(hit, source, all, get) {
  assert.equal(hit.result.source, "cache");
  assert.equal(source.result.source, "rpc");
  const client = traceTopology(source.trace).spans.get(
    source.result.rpc_client_span_id,
  );
  const interval = ageInterval(hit.decision, "snapshot_age_ms");
  const minted = [source.decision.startTime - 1, client.startTime + 1];
  assert(
    intersects(interval, minted),
    "cache origin differs from original actual Resolve source",
  );
  const candidates = all.flatMap((t) => {
    const tree = traceTopology(t);
    return t.spans
      .filter(
        (d) =>
          d.operationName === "gateway.identity.resolve" &&
          tag(d, prefix + "source") === "rpc" &&
          tag(d, prefix + "profile") === hit.result.profile,
      )
      .flatMap((d) =>
        t.spans
          .filter(
            (c) =>
              tree.service(c) === "edge-gateway" &&
              tag(c, "span.kind") === "client" &&
              tree.parent(c) === tree.parent(d) &&
              c.startTime >= d.startTime &&
              end(c) <= end(d) &&
              t.spans.some(
                (s) =>
                  tree.parent(s) === c &&
                  tree.service(s) === "identity-service" &&
                  tag(s, "http.route") === "/rpc/identity/resolve-access-token",
              ),
          )
          .filter((c) =>
            intersects(interval, [d.startTime - 1, c.startTime + 1]),
          )
          .map((c) => ({ trace: t, client: c })),
      );
  });
  for (const t of all) {
    const tree = traceTopology(t);
    for (const refresh of t.spans.filter(
      (s) =>
        s.operationName === "gateway.identity.resolve.refresh" &&
        tag(s, prefix + "profile") === hit.result.profile,
    )) {
      const link = one(
        refresh.references.filter((r) => r.refType === "FOLLOWS_FROM"),
        "refresh origin trigger missing",
      );
      const trigger = traceTopology(get(link.traceID)).spans.get(link.spanID);
      assert(
        trigger?.operationName === "gateway.identity.resolve" &&
          tag(trigger, prefix + "profile") === hit.result.profile,
        "wrong refresh origin trigger",
      );
      for (const c of t.spans.filter(
        (c) =>
          tree.service(c) === "edge-gateway" &&
          tag(c, "span.kind") === "client" &&
          tree.parent(c) === refresh &&
          t.spans.some(
            (s) =>
              tree.parent(s) === c &&
              tree.service(s) === "identity-service" &&
              tag(s, "http.route") === "/rpc/identity/resolve-access-token",
          ),
      )) {
        if (intersects(interval, [refresh.startTime - 1, c.startTime + 1]))
          candidates.push({ trace: t, client: c });
      }
    }
  }
  const candidate = one(candidates, "ambiguous actual Resolve origin");
  assert(
    candidate.trace === source.trace && candidate.client === client,
    "wrong original Resolve origin",
  );
  assert(
    end(client) <= hit.decision.startTime,
    "cache admitted before its source RPC completed",
  );
  return {
    source_trace_id: source.trace.traceID,
    snapshot_origin_us: interval,
    source_start_bounds_us: minted,
  };
}

export function inspectOutageAuthority(evidence, collection, secrets = []) {
  assert(
    [3, 4].includes(evidence.policy_revision),
    "unsupported authority evidence revision",
  );
  const bridge = evidence.policy_revision === 4;
  if (bridge) {
    assert.equal(evidence.transport, "http-sse");
    assert.equal(
      evidence.wire,
      undefined,
      "Bridge authority contains retired WSS admission",
    );
  } else
    assert.notEqual(
      evidence.transport,
      "http-sse",
      "Bridge authority requires revision 4",
    );
  const { traces, archivedTraceIDs } = collection;
  assert(
    traces instanceof Map && traces.size > 0,
    "authority raw traces absent",
  );
  const all = resolveTraceSources(
    traces.values().next().value,
    secrets,
    collection,
  );
  for (const t of all)
    assert(
      archivedTraceIDs.has(t.traceID),
      "authority source must be archived",
    );
  const ttl = evidence.settings.resolveTTLMS;
  assert.equal(ttl, 10000);
  assert.equal(evidence.settings.captureRpcContent, false);
  const stop = evidence.identity.stop_started_at,
    restart = evidence.identity.restart_started_at;
  [stop, restart, evidence.identity.stopped.at].forEach(finite);
  assert(
    stop <= evidence.identity.stopped.at &&
      restart - evidence.identity.stopped.at >= 5000,
    "whole stop interval missing",
  );
  const get = (id) => {
    const trace = traces.get(id);
    assert(trace && archivedTraceIDs.has(id), "actual authority Trace missing");
    return trace;
  };
  const loginScope = (label) => {
    const login = one(
      evidence.http.filter((r) => r.label === label),
      "credential login observation missing",
    );
    get(login.trace_id);
    assert.equal(login.path, "/api/session/login");
    assert.equal(login.method, "POST");
    assert.equal(login.status, 200);
    assert.equal(login.set_cookie_count, 2);
    assert.match(
      login.issued_credential_scope ?? "",
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
      "credential observation ID missing",
    );
    finite(login.at);
    return login;
  };
  const warmLogin = loginScope("warm-login"),
    adminLogin = loginScope("audit-login");
  assert.notEqual(
    warmLogin.issued_credential_scope,
    adminLogin.issued_credential_scope,
    "distinct credentials collapsed to one scope",
  );
  const rootOf = (trace) => {
    const tree = traceTopology(trace);
    const root = one(
      trace.spans.filter((s) => !tree.parent(s)),
      "one actual authority root required",
    );
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tag(root, "span.kind"), "server");
    return { tree, root };
  };
  const resolved = (trace, root, upstream, profile, admissionOnly = false) => {
    const decision = one(
      trace.spans.filter(
        (s) =>
          s.operationName === "gateway.identity.resolve" &&
          (!admissionOnly ||
            (traceTopology(trace).parent(s) === root &&
              end(s) <= upstream.startTime)),
      ),
      "one actual authority decision required",
    );
    const result = inspectGatewayResolution(
      trace,
      {
        rootSpanID: root.spanID,
        decisionSpanID: decision.spanID,
        upstreamSpanID: upstream.spanID,
        profile,
        ttlMs: ttl,
      },
      collection,
    );
    // Long-lived SSE root/upstream also record later cleanup. Their final
    // lifecycle diagnostics remain strict failures owned by the closure gate;
    // this branch proves only admission and never clears those diagnostics.
    successful(admissionOnly ? [decision] : [root, decision, upstream]);
    if (result.rpc_client_span_id) {
      const source = get(result.source_trace_id),
        tree = traceTopology(source);
      const client = tree.spans.get(result.rpc_client_span_id),
        server = tree.spans.get(result.identity_server_span_id);
      successful([client, server, ...databaseChildrenTopology(source, server)]);
    }
    return { trace, decision, result };
  };
  const actualHTTP = (label, path) => {
    const row = one(
      evidence.http.filter((r) => r.label === label),
      `actual ${label} missing or duplicate`,
    );
    assert.equal(row.method, "GET");
    assert.equal(row.path, path);
    assert.equal(row.status, 200);
    assert.equal(row.set_cookie_count, 0);
    const login = [
      "fresh-configuration-acknowledgement",
      "warm-console-audit",
    ].includes(label)
      ? adminLogin
      : warmLogin;
    assert.equal(
      row.credential_scope,
      login.issued_credential_scope,
      "dispatched credential differs from original login",
    );
    finite(row.started_at);
    finite(row.at);
    assert(
      login.at <= row.started_at && row.started_at <= row.at && row.at < stop,
      "prewarm response did not precede Identity stop",
    );
    return row;
  };
  const http = (
    row,
    profile,
    route,
    service,
    receivingRoute,
    status = 200,
    method = "GET",
    admissionOnly = false,
  ) => {
    admissionOnly ||= status === 101;
    const trace = get(row.trace_id),
      { tree, root } = rootOf(trace);
    assert.equal(tag(root, "http.route"), route);
    assert.equal(tag(root, "http.request.method"), "GET");
    assert.equal(tag(root, "http.response.status_code"), status);
    const server = one(
      trace.spans.filter(
        (s) =>
          tree.service(s) === service &&
          tag(s, "span.kind") === "server" &&
          tag(s, "http.route") === receivingRoute,
      ),
      "actual authority consumer receiver missing or duplicate",
    );
    assert.equal(tag(server, "http.request.method"), method);
    assert.equal(tag(server, "http.response.status_code"), status);
    const upstream = tree.parent(server);
    assert.equal(tag(upstream, "span.kind"), "client");
    assert.equal(tag(upstream, "http.request.method"), method);
    assert.equal(tag(upstream, "http.response.status_code"), status);
    if (receivingRoute === "/rpc/agent-acp/get-agent-execution-state")
      assert.equal(tag(server, "antnest.agent.id"), evidence.agent_id);
    if (!admissionOnly) successful([server]);
    return {
      ...resolved(trace, root, upstream, profile, admissionOnly),
      row,
      receiver: server,
      upstream,
    };
  };
  const consoleSource = http(
    actualHTTP(
      "fresh-configuration-acknowledgement",
      "/api/admin/execution-synchronization",
    ),
    "console",
    "/api/admin/{path...}",
    "admin-console",
    "/api/admin/execution-synchronization",
  );
  const workspaceSource = bridge
    ? http(
        actualHTTP(
          "fresh-consumer-agent-ready",
          `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}/view`,
        ),
        "workspace",
        "/api/app/workspace/v1/{path...}",
        "agent-ui",
        "/api/app/workspace/v1/*",
      )
    : http(
        actualHTTP(
          "fresh-consumer-agent-ready",
          `/api/app/agents/${encodeURIComponent(evidence.agent_id)}/state`,
        ),
        "workspace",
        "/api/app/agents/{agent_id}/state",
        "agent-acp-service",
        "/rpc/agent-acp/get-agent-execution-state",
        200,
        "POST",
      );
  let bridgeAdmission;
  if (bridge) {
    assert.equal(
      workspaceSource.row.body?.agentId,
      evidence.agent_id,
      "wrong ready view Agent",
    );
    assert.equal(workspaceSource.row.body.availability, "ready");
    assert.equal(workspaceSource.row.body.activeSessionId, null);
    const { trace, receiver, upstream } = workspaceSource,
      tree = traceTopology(trace);
    assert.equal(receiver.operationName, "agent_ui.http.request");
    assert.equal(upstream.operationName, "HTTP GET agent-ui");
    assert.equal(tag(upstream, "server.address"), "agent-ui");
    const initialize = one(
      trace.spans.filter(
        (s) =>
          tree.service(s) === "agent-acp-service" &&
          tag(s, "span.kind") === "server" &&
          tag(s, "http.route") === "/v1/acp" &&
          tag(s, "http.request.method") === "POST" &&
          tag(s, "rpc.method") === "initialize",
      ),
      "one actual private ACP initialization required",
    );
    assert.equal(
      tree.parent(initialize),
      receiver,
      "ACP initialization must belong to the actual UI receiver",
    );
    assert.equal(tag(initialize, "http.response.status_code"), 200);
    assert.equal(tag(initialize, "rpc.service"), "acp");
    assert.equal(
      tag(initialize, "antnest.agent.id"),
      evidence.agent_id,
      "wrong initialization Agent",
    );
    assert(
      initialize.startTime >= receiver.startTime &&
        end(initialize) <= end(receiver),
      "ACP initialization outside the actual UI request",
    );
    successful([initialize]);
    bridgeAdmission = {
      source_trace_id: trace.traceID,
      initialization_span_id: initialize.spanID,
      ui_receiver_span_id: receiver.spanID,
      gateway_client_span_id: upstream.spanID,
    };
  }
  let connection, originalHit, acpHit;
  if (!bridge) {
    const wire = evidence.wire;
    assert.equal(
      wire.credential_scope,
      warmLogin.issued_credential_scope,
      "WSS credential differs from original login",
    );
    assert.equal(wire.upgrade.status, 101);
    finite(wire.started_at);
    finite(wire.upgrade.at);
    assert(
      warmLogin.at <= wire.started_at &&
        wire.started_at <= wire.upgrade.at &&
        wire.upgrade.at < stop,
    );
    connection = http(
      { trace_id: wire.upgrade.trace_id },
      "acp",
      "/api/app/agents/{agent_id}/v1/acp",
      "agent-acp-service",
      "/v1/acp",
      101,
    );
    const connectionRoot = rootOf(connection.trace).root;
    const frames = wire.frames.map((f) => ({
      ...f,
      message: JSON.parse(f.raw),
    }));
    const message = (method) => {
      const send = one(
        frames.filter(
          (f) => f.direction === "send" && f.message.method === method,
        ),
        `actual ${method} send missing or duplicate`,
      );
      assert(send.message.id !== undefined, "actual request ID missing");
      const receive = one(
        frames.filter(
          (f) => f.direction === "receive" && f.message.id === send.message.id,
        ),
        "actual ACP response missing or duplicate",
      );
      assert(
        Object.hasOwn(receive.message, "result") &&
          !Object.hasOwn(receive.message, "error"),
        "actual ACP request failed",
      );
      [send.at, receive.at].forEach(finite);
      assert(
        wire.upgrade.at <= send.at &&
          send.at <= receive.at &&
          receive.at < stop,
        "ACP prewarm outside observed connection window",
      );
      const trace = one(
        all.filter((t) =>
          t.spans.some(
            (s) =>
              tag(s, "antnest.request.id") === String(send.message.id) &&
              tag(s, "rpc.method") === method &&
              t.spans.some((root) =>
                (root.references ?? []).some(
                  (ref) =>
                    ref.refType === "FOLLOWS_FROM" &&
                    ref.traceID === wire.upgrade.trace_id,
                ),
              ),
          ),
        ),
        "actual ACP prewarm Trace missing or duplicate",
      );
      const { tree, root } = rootOf(trace);
      assert.deepEqual(
        root.references.filter((r) => r.refType === "FOLLOWS_FROM"),
        [
          {
            refType: "FOLLOWS_FROM",
            traceID: connection.trace.traceID,
            spanID: connectionRoot.spanID,
          },
        ],
        "wrong original handshake root",
      );
      const result = inspectWorkspaceRequestResolution(
        trace,
        {
          traceID: trace.traceID,
          method,
          requestId: String(send.message.id),
          transport: "websocket",
          agentId: evidence.agent_id,
          connectionTraceID: connection.trace.traceID,
          resolveTTLMS: ttl,
        },
        secrets,
        collection,
      );
      const decision = tree.spans.get(result.decision_span_id);
      successful([
        root,
        decision,
        ...trace.spans.filter(
          (s) =>
            tree.service(s) === "edge-gateway" ||
            (tree.service(s) === "agent-acp-service" &&
              tag(s, "antnest.request.id") === String(send.message.id)),
        ),
      ]);
      return {
        trace,
        decision,
        result,
        row: { started_at: send.at, at: receive.at },
      };
    };
    originalHit = message("initialize");
    acpHit = message("session/list");
    assert.equal(
      frames.find((f) => f.direction === "send")?.message.method,
      "initialize",
      "original CCT must use the first request after upgrade",
    );
  }
  const consoleHit = http(
    actualHTTP(
      "warm-console-audit",
      `/api/admin/execution-audits/${encodeURIComponent(evidence.run_id)}`,
    ),
    "console",
    "/api/admin/{path...}",
    "admin-console",
    "/api/admin/execution-audits/{run_id}",
  );
  const workspaceHit = http(
    actualHTTP(
      "warm-workspace-hit",
      `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}/sessions/${encodeURIComponent(evidence.session_id)}/view`,
    ),
    "workspace",
    "/api/app/workspace/v1/{path...}",
    "agent-ui",
    "/api/app/workspace/v1/*",
  );
  const stream = evidence.stream;
  assert(stream, "original SSE observation missing");
  assert.equal(
    stream.credential_scope,
    warmLogin.issued_credential_scope,
    "SSE credential differs from original login",
  );
  assert.equal(
    stream.path,
    `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}/events?sessionId=${encodeURIComponent(evidence.session_id)}`,
  );
  assert.equal(stream.status, 200);
  assert.equal(stream.set_cookie_count, 0);
  finite(stream.started_at);
  finite(stream.headers_at);
  assert(
    warmLogin.at <= stream.started_at &&
      stream.started_at <= stream.headers_at &&
      stream.headers_at < stop,
    "original SSE admission outside warm window",
  );
  const streamHit = http(
    stream,
    "workspace",
    "/api/app/workspace/v1/{path...}",
    "agent-ui",
    "/api/app/workspace/v1/*",
    200,
    "GET",
    true,
  );
  const origin = (hit, source) => inspectAuthorityOrigin(hit, source, all, get);
  const prewarm = [
    [consoleHit, consoleSource],
    ...(!bridge ? [[acpHit, connection]] : []),
    [workspaceHit, workspaceSource],
  ].map(([hit, source]) => {
    const bound =
      hit.row.started_at +
      Math.min(
        tag(hit.decision, prefix + "valid_for_ms"),
        ttl - tag(hit.decision, prefix + "proof_age_ms"),
      );
    assert(
      hit.row.at <= restart && restart < bound,
      "Identity stop exceeds conservative authority deadline",
    );
    return {
      trace_id: hit.trace.traceID,
      profile: hit.result.profile,
      ...origin(hit, source),
      proof_start_bounds_us: ageInterval(hit.decision, "proof_age_ms"),
      decision_started_us: hit.decision.startTime,
      sent_at: hit.row.started_at,
      received_at: hit.row.at,
      conservative_deadline: bound,
    };
  });
  const original = bridge ? undefined : origin(originalHit, connection);
  const originalStream = origin(streamHit, workspaceSource);
  const streamDeadline =
    stream.started_at + tag(streamHit.decision, prefix + "valid_for_ms");
  assert(
    restart < streamDeadline,
    "original SSE CCT/session budget expired during stop",
  );
  // valid_for is clipped by the producer to snapshot TTL, original CCT, idle
  // and absolute session expiry. A same-origin hit supplies a lower bound for
  // all four without comparing Gateway and Identity clocks or decoding secrets.
  // Cache hits retain the source's complete Principal and original CCT. Once
  // credential, workspace/Agent and RPC origin match, that clipped cache
  // deadline also bounds the original private initialization's authority.
  const originalDeadline = bridge
    ? one(
        prewarm.filter((r) => r.profile === "workspace"),
        "one original Bridge authority required",
      ).conservative_deadline
    : originalHit.row.started_at +
      tag(originalHit.decision, prefix + "valid_for_ms");
  assert(
    restart < originalDeadline,
    bridge
      ? "original Bridge CCT/session budget expired during stop"
      : "original WSS CCT/session budget expired during stop",
  );
  if (bridge) bridgeAdmission.conservative_deadline = originalDeadline;
  assert(
    collection.feedAttemptTraceIDs instanceof Set &&
      collection.feedAttemptTraceIDs.size > 0,
    "complete Gateway feed attempt inventory required",
  );
  const processAttempts = (trace) => {
    const tree = traceTopology(trace);
    return trace.spans
      .filter(
        (s) =>
          tree.service(s) === "edge-gateway" &&
          !tree.parent(s) &&
          tag(s, "span.kind") === "client" &&
          tag(s, "http.request.method") === "POST" &&
          tag(s, "server.address") === "identity-service",
      )
      .map((client) => ({ trace, client }));
  };
  for (const trace of all) {
    if (processAttempts(trace).length)
      assert(
        collection.feedAttemptTraceIDs.has(trace.traceID),
        "raw Gateway attempt omitted from attempt inventory",
      );
  }
  const feeds = [...collection.feedAttemptTraceIDs]
    .map(get)
    .flatMap(processAttempts)
    .sort((a, b) => a.client.startTime - b.client.startTime);
  for (let i = 1; i < feeds.length; i++)
    assert(
      end(feeds[i - 1].client) <= feeds[i].client.startTime,
      "Gateway feed attempts are not serial",
    );
  const matched = new Set();
  for (const row of prewarm) {
    const interval = row.proof_start_bounds_us;
    const index = feeds.findIndex((f) => f.client.startTime >= interval[0]);
    assert(index > 0, "terminal feed or preceding attempt missing");
    const feed = feeds[index];
    // Poll is serial, and captures proof START before constructing the CLIENT.
    // A prior page still in flight, or completion of this page used as proof,
    // contradicts that origin. No arbitrary skew allowance is added.
    assert(
      Math.max(interval[0], end(feeds[index - 1].client)) <=
        Math.min(interval[1], feed.client.startTime),
      "no proof instant between preceding completion and feed CLIENT start",
    );
    assert(
      end(feed.client) <= row.decision_started_us,
      "feed completion followed cache admission",
    );
    inspectEmptySessionFeed(
      feed.trace,
      { traceID: feed.trace.traceID },
      secrets,
      { traces: new Map([[feed.trace.traceID, feed.trace]]), archivedTraceIDs },
    );
    matched.add(feed.trace.traceID);
  }
  const deadline = Math.min(
    originalDeadline,
    streamDeadline,
    ...prewarm.map((r) => r.conservative_deadline),
  );
  return {
    status: "passed",
    prewarm,
    feed_trace_ids: [...matched].sort(),
    ...(!bridge
      ? {
          original_wss: {
            ...original,
            connection_trace_id: connection.trace.traceID,
            first_hit_trace_id: originalHit.trace.traceID,
            conservative_deadline: originalDeadline,
          },
        }
      : { original_bridge: bridgeAdmission }),
    original_sse: {
      ...originalStream,
      trace_id: streamHit.trace.traceID,
      conservative_deadline: streamDeadline,
    },
    conservative_deadline: deadline,
    remaining_at_restart_ms: deadline - restart,
    ...resolveTraceDiagnostics(
      bridge ? workspaceSource.trace : connection.trace,
      all,
    ),
  };
}
