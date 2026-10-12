import assert from "node:assert/strict";
import {
  inspectGatewayResolution,
  assertGatewayResolutionAttributes,
} from "../../support/gateway-resolution.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
} from "../observability/trace-tree.mjs";

const prefix = "antnest.identity.resolve.";
const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const fields = (rows) => {
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(
    Object.keys(values).length,
    rows.length,
    "duplicate diagnostic field",
  );
  return values;
};
function errorTags(span, expected) {
  const actual = fields(span.tags ?? []);
  for (const [key, value] of Object.entries(expected))
    assert.equal(actual[key], value, `missing or wrong refusal ${key}`);
  for (const [key, value] of Object.entries(actual))
    if (
      /^(error($|\.)|exception\.|db\.response\.status_code$|antnest\.(error\.|outcome$|result$|operation\.phase$|cancellation\.)|otel\.status_)/u.test(
        key,
      )
    ) {
      assert(Object.hasOwn(expected, key), "unrelated refusal error metadata");
      assert.equal(value, expected[key], "unrelated refusal error metadata");
    }
}
function errorEvent(span, expected) {
  const event = one(span.logs ?? [], "one exact refusal event required");
  assert(
    Number.isFinite(event.timestamp) &&
      event.timestamp >= span.startTime &&
      event.timestamp <= end(span),
    "refusal event outside owning span",
  );
  const actual = fields(event.fields ?? []);
  assert.deepEqual(actual, { event: "antnest.error", ...expected });
}
function decisionError(span, outcome) {
  errorTags(span, {
    error: true,
    "otel.status_code": "ERROR",
    "otel.status_description": outcome,
  });
  assert.equal(span.logs?.length ?? 0, 0, "unexpected Resolve decision event");
}
const transportFailures = {
  deadline_exceeded: {
    message: "Request deadline exceeded",
    causes: [
      ["context.deadlineExceededError"],
      ["*net.OpError", "*net.timeoutError"],
      ["*net.OpError", "*net.DNSError", "*net.timeoutError"],
    ],
  },
  cancelled: {
    message: "Request was cancelled",
    causes: [["*errors.errorString"]],
  },
  network_error: {
    message: "Network operation failed",
    causes: [
      ["*net.OpError", "*os.SyscallError", "syscall.Errno"],
      ["*net.OpError", "syscall.Errno"],
    ],
  },
  dns_error: {
    message: "Could not resolve the remote service",
    causes: [["*net.OpError", "*net.DNSError"]],
  },
};
function transportFailure(span, stage, profile) {
  const type = tag(span, "error.type"),
    expected = transportFailures[type];
  assert(expected, "unrelated stopped transport failure");
  assert(
    stage === "send" || type !== "cancelled",
    "request cancellation lacks stopped HTTP ownership",
  );
  const event = one(span.logs ?? [], "one failed transport event required");
  const value = fields(event.fields ?? [])["antnest.error.cause_types"];
  const causes =
    stage === "send"
      ? expected.causes
      : [
          ...expected.causes.map((chain) =>
            ["*fmt.wrapError", "*url.Error", ...chain].slice(0, 4),
          ),
          ...(profile && type === "deadline_exceeded"
            ? [["context.deadlineExceededError"]]
            : []),
        ];
  assert(
    causes.some((chain) => JSON.stringify(chain) === value),
    "unrelated stopped transport cause",
  );
  errorTags(span, {
    error: true,
    "error.type": type,
    "otel.status_code": "ERROR",
    "otel.status_description": expected.message,
  });
  errorEvent(span, {
    "error.type": type,
    "antnest.error.stage": stage,
    "antnest.error.message": expected.message,
    "antnest.error.cause_types": value,
  });
  return { type, causes: JSON.parse(value) };
}
const end = (s) => {
  assert(
    Number.isFinite(s.startTime) &&
      Number.isFinite(s.duration) &&
      s.duration >= 0,
  );
  return s.startTime + s.duration;
};
const scopeID = (value) =>
  assert.match(
    value ?? "",
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
const route = (path) =>
  path.startsWith("/api/admin/")
    ? "/api/admin/{path...}"
    : path.startsWith("/api/app/workspace/")
      ? "/api/app/workspace/v1/{path...}"
      : path.includes("/v1/acp")
        ? "/api/app/agents/{agent_id}/v1/acp"
        : path;

export function inspectOutageRejections(evidence, collection, secrets = []) {
  const config = evidence.rejections;
  assert.equal(config.request_timeout_ms, 2000);
  assert.equal(evidence.settings.resolveTTLMS, 10000);
  const start = evidence.identity.stopped.at,
    finish = evidence.identity.restart_started_at;
  assert(
    Number.isFinite(start) && Number.isFinite(finish) && finish - start >= 5000,
  );
  assert.equal(evidence.identity.stopped.running, false);
  assert.equal(evidence.identity.stopped_end.running, false);
  const row = (label) =>
    one(
      evidence.http.filter((r) => r.label === label),
      `actual ${label} response missing or duplicate`,
    );
  const sources = resolveTraceSources(
    collection.traces.values().next().value,
    secrets,
    collection,
  );
  const selected = [],
    owned = [];
  const raw = (observation) => {
    assert(
      collection.archivedTraceIDs.has(observation.trace_id),
      "actual HTTP Trace not archived",
    );
    const trace = collection.traces.get(observation.trace_id);
    assert(trace, "actual HTTP Trace missing");
    const tree = traceTopology(trace);
    const root = one(
      trace.spans.filter((s) => !tree.parent(s)),
      "one actual Gateway root required",
    );
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tag(root, "span.kind"), "server");
    assert.equal(tag(root, "http.route"), route(observation.path));
    assert.equal(tag(root, "http.request.method"), observation.method);
    assert.equal(tag(root, "http.response.status_code"), observation.status);
    trace.spans.forEach(end);
    assertGatewayResolutionAttributes(trace);
    selected.push(trace);
    return { trace, tree, root };
  };
  const login = (label) => {
    const r = row(label);
    assert.equal(r.path, "/api/session/login");
    assert.equal(r.method, "POST");
    assert.equal(r.status, 200);
    assert.equal(r.set_cookie_count, 2);
    assert(r.at < start);
    scopeID(r.issued_credential_scope);
    const { trace } = raw(r);
    assert(
      trace.spans.every((s) => !hasError(s)),
      "credential login contains unexpected failure",
    );
    return r.issued_credential_scope;
  };
  const consoleScope = login("cold-console-login"),
    workspaceScope = login("cold-workspace-login"),
    expiredScope = login("short-idle-login");
  assert.equal(
    new Set([
      consoleScope,
      workspaceScope,
      expiredScope,
      login("warm-login"),
      login("audit-login"),
    ]).size,
    5,
    "outage credential scopes must be distinct",
  );
  const fixture = config.expired_session;
  assert.equal(fixture.credential_scope, expiredScope);
  assert.equal(fixture.idle_ms, 2000);
  assert.equal(fixture.only_idle_changed, true);
  assert.deepEqual(fixture.no_match_probe, {
    matches: 0,
    updated: 0,
    unchanged: true,
  });
  assert.equal(fixture.protected_unchanged, 2);
  assert(
    Number.isFinite(fixture.at) && row("short-idle-login").at < fixture.at,
  );
  for (const key of ["expires_at", "idle_expires_at"])
    assert.equal(
      Date.parse(row("short-idle-login").body[key]),
      Date.parse(fixture.before[key]),
    );
  assert(
    Date.parse(fixture.after.idle_expires_at) <
      Date.parse(fixture.before.idle_expires_at),
  );
  for (const key of ["expires_at", "last_used_at", "issued_at"])
    assert.equal(fixture.before[key], fixture.after[key]);
  const observation = (label) =>
    one(
      fixture.observations.filter((r) => r.label === label),
      `database ${label} observation missing`,
    );
  for (const [label, source, database] of [
    ["short-idle-warm", "rpc", "after-warm"],
    ["short-idle-hit", "cache", "after-hit"],
  ]) {
    const r = row(label),
      db = observation(database);
    assert.equal(r.path, "/api/session");
    assert.equal(r.method, "GET");
    assert.equal(r.status, 200);
    assert.equal(r.set_cookie_count, 0);
    assert.equal(r.credential_scope, expiredScope);
    assert(
      r.started_at > fixture.at,
      "short session resolved before deadline fixture",
    );
    assert(r.at < db.at && db.at < start && !db.expired && db.remaining_ms > 0);
    for (const key of ["idle_expires_at", "expires_at"])
      assert.equal(Date.parse(r.body[key]), Date.parse(fixture.after[key]));
    const { trace, tree, root } = raw(r);
    assert(
      trace.spans.every((s) => !hasError(s)),
      "short session admission contains unexpected failure",
    );
    const decision = one(
      trace.spans.filter((s) => s.operationName === "gateway.identity.resolve"),
      "short session Resolve decision missing",
    );
    const result = inspectGatewayResolution(
      trace,
      {
        rootSpanID: root.spanID,
        decisionSpanID: decision.spanID,
        profile: "session",
        ttlMs: 10000,
      },
      collection,
    );
    assert.equal(result.source, source);
    assert(
      !trace.spans.some(
        (s) =>
          tree.service(s) !== "edge-gateway" &&
          tree.service(s) !== "identity-service",
      ),
      "session read forwarded to business service",
    );
    if (source === "cache")
      assert(
        tag(decision, prefix + "valid_for_ms") <= fixture.idle_ms,
        "cache budget exceeds short session deadline",
      );
  }
  const expired = observation("expired");
  assert.equal(expired.expired, true);
  assert(expired.remaining_ms <= 0);
  assert(
    expired.at >= start &&
      expired.at <= row("stopped-expired-session").started_at,
  );
  for (const db of fixture.observations)
    for (const key of Object.keys(fixture.after))
      assert.equal(
        db[key],
        fixture.after[key],
        "ordinary reads changed browser authority",
      );
  const cases = [
    [
      "stopped-cold-console",
      "console",
      "/api/admin/execution-synchronization",
      "GET",
      consoleScope,
    ],
    [
      "stopped-cold-workspace",
      "workspace",
      `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}/sessions/${encodeURIComponent(evidence.session_id)}/view`,
      "GET",
      workspaceScope,
    ],
    [
      "stopped-cold-acp",
      "acp",
      `/api/app/agents/${encodeURIComponent(evidence.agent_id)}/v1/acp`,
      "POST",
      workspaceScope,
    ],
    ["stopped-new-login", null, "/api/session/login", "POST", null],
    ["stopped-expired-session", "session", "/api/session", "GET", expiredScope],
  ];
  const requests = cases.map(([label, profile, path, method, scope]) => {
    const r = row(label);
    assert.equal(r.path, path);
    assert.equal(r.method, method);
    assert(
      Number.isFinite(r.started_at) &&
        Number.isFinite(r.at) &&
        r.started_at >= start &&
        r.at >= r.started_at &&
        r.at <= finish &&
        r.at <= start + 5000,
      "complete HTTP failure must be inside original five-second stop",
    );
    assert.equal(r.status, 503);
    assert.equal(r.body?.code, "identity_unavailable");
    assert(
      typeof r.body.message === "string" && r.body.message.length > 0,
      "actual HTTP error message missing",
    );
    assert.equal(r.set_cookie_count, 0);
    assert.equal(r.credential_scope, scope);
    assert.equal(r.issued_credential_scope, undefined);
    if (label.startsWith("stopped-cold-"))
      assert(
        !evidence.http.some(
          (other) =>
            other !== r &&
            other.credential_scope === scope &&
            other.started_at < start,
        ),
        "cold credential was already used before stop",
      );
    const { trace, tree, root } = raw(r);
    const markers = trace.spans.filter(
      (s) => s.operationName === "gateway.identity.resolve",
    );
    const rootFailure = transportFailure(root, "request", profile);
    let decision;
    if (profile) {
      decision = one(markers, "one failed Resolve decision required");
      assert.equal(tree.parent(decision), root);
      assert.equal(tree.service(decision), "edge-gateway");
      assert.equal(tag(decision, "span.kind"), "internal");
      assert.equal(tag(decision, prefix + "profile"), profile);
      assert.equal(tag(decision, prefix + "source"), "rpc");
      assert.equal(tag(decision, prefix + "outcome"), "unavailable");
      assert.equal(tag(decision, prefix + "cancel_kind"), undefined);
      decisionError(decision, "unavailable");
      assert(
        !(decision.references ?? []).some(
          (ref) => ref.refType === "FOLLOWS_FROM",
        ),
      );
    } else
      assert.equal(markers.length, 0, "login must call local-login directly");
    const client = one(
      trace.spans.filter((s) =>
        ["client", "producer"].includes(tag(s, "span.kind")),
      ),
      "one actual failed Identity CLIENT and no business forwarding required",
    );
    assert.equal(tree.service(client), "edge-gateway");
    assert.equal(tree.parent(client), root);
    assert.equal(client.operationName, "HTTP POST identity-service");
    assert.equal(tag(client, "server.address"), "identity-service");
    assert.equal(tag(client, "http.request.method"), "POST");
    const timeout = tag(client, "antnest.request.timeout_ms");
    assert(
      Number.isInteger(timeout) &&
        timeout >= 0 &&
        timeout <= config.request_timeout_ms,
      "actual Identity request deadline missing or exceeds fixture budget",
    );
    assert.equal(tag(client, "http.response.status_code"), undefined);
    const clientFailure = transportFailure(client, "send", profile);
    const waiterDeadline =
      profile &&
      rootFailure.type === "deadline_exceeded" &&
      rootFailure.causes.length === 1 &&
      rootFailure.causes[0] === "context.deadlineExceededError";
    if (!waiterDeadline) {
      assert.equal(
        rootFailure.type,
        clientFailure.type,
        "unrelated request and CLIENT transport failures",
      );
      assert.deepEqual(
        rootFailure.causes,
        ["*fmt.wrapError", "*url.Error", ...clientFailure.causes].slice(0, 4),
        "request cause does not wrap the actual CLIENT failure",
      );
    }
    assert(
      hasError(client) &&
        [
          "deadline_exceeded",
          "network_error",
          "dns_error",
          "cancelled",
        ].includes(tag(client, "error.type")),
      "actual failed Identity transport required",
    );
    assert.equal(
      trace.spans.length,
      profile ? 3 : 2,
      "unexpected business/server/SQL spans during stopped Identity",
    );
    assert(
      client.startTime >= (decision ?? root).startTime &&
        client.startTime <= end(decision ?? root),
    );
    if (decision)
      assert(
        decision.startTime >= root.startTime && end(decision) <= end(root),
        "stopped decision outside its actual request",
      );
    const retained = Math.max(0, end(client) - end(root));
    if (retained) {
      // A request deadline releases the last waiter and cancels process-owned
      // work. That worker's real CLIENT may end after the response; preserve
      // its finished raw span and exact deadline provenance, never shorten it.
      assert(
        waiterDeadline,
        "late CLIENT lacks actual request deadline provenance",
      );
      assert(
        (root.logs ?? []).some((event) => {
          const fields = Object.fromEntries(
            (event.fields ?? []).map((field) => [field.key, field.value]),
          );
          return (
            fields.event === "antnest.error" &&
            fields["error.type"] === "deadline_exceeded" &&
            fields["antnest.error.stage"] === "request"
          );
        }),
        "late CLIENT lacks actual request deadline event",
      );
      assert(
        ["cancelled", "deadline_exceeded"].includes(tag(client, "error.type")),
      );
    }
    for (const span of [root, client, ...(decision ? [decision] : [])])
      owned.push({
        trace_id: trace.traceID,
        span_id: span.spanID,
        reason: "outage-http-unavailable",
      });
    return {
      label,
      profile,
      status: r.status,
      trace_id: trace.traceID,
      root_span_id: root.spanID,
      client_span_id: client.spanID,
      decision_span_id: decision?.spanID,
      observed_at: r.at,
      retained_client_after_response_us: retained,
    };
  });
  const recovered = row("recovered-expired-session");
  assert.equal(recovered.path, "/api/session");
  assert.equal(recovered.method, "GET");
  assert(
    Number.isFinite(recovered.started_at) &&
      Number.isFinite(recovered.at) &&
      recovered.started_at > finish &&
      recovered.at >= recovered.started_at,
    "complete expired-session response after restart required",
  );
  assert.equal(recovered.credential_scope, expiredScope);
  assert.equal(recovered.status, 401);
  assert.equal(recovered.set_cookie_count, 0);
  assert.equal(recovered.body?.code, "unauthenticated");
  assert(
    typeof recovered.body.message === "string" &&
      recovered.body.message.length > 0,
  );
  const { trace, tree, root } = raw(recovered);
  const decision = one(
    trace.spans.filter((s) => s.operationName === "gateway.identity.resolve"),
    "authoritative expired rejection missing",
  );
  assert.equal(tree.parent(decision), root);
  assert.equal(tag(decision, prefix + "profile"), "session");
  assert.equal(tag(decision, prefix + "source"), "rpc");
  assert.equal(tag(decision, prefix + "outcome"), "rejected");
  assert.equal(tree.service(decision), "edge-gateway");
  assert.equal(tag(decision, "span.kind"), "internal");
  decisionError(decision, "rejected");
  const server = one(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "identity-service" &&
        tag(s, "http.route") === "/rpc/identity/resolve-access-token",
    ),
    "authoritative rejection receiver missing",
  );
  assert.equal(tag(server, "http.response.status_code"), 401);
  assert.equal(tag(server, "span.kind"), "server");
  assert.equal(tag(server, "http.request.method"), "POST");
  assert.equal(tag(server, "rpc.method"), "resolve_access_token");
  const client = tree.parent(server);
  assert.equal(tree.parent(client), root);
  assert.equal(tree.service(client), "edge-gateway");
  assert.equal(tag(client, "http.response.status_code"), 401);
  assert.equal(tag(client, "span.kind"), "client");
  assert.equal(tag(client, "http.request.method"), "POST");
  assert.equal(client.operationName, "HTTP POST identity-service");
  assert.equal(tag(client, "server.address"), "identity-service");
  assert(
    decision.startTime >= root.startTime &&
      end(decision) <= end(root) &&
      client.startTime >= decision.startTime &&
      end(client) <= end(decision),
    "recovered rejection outside its actual request and decision",
  );
  const gatewayMessage =
    "Operation failed; unclassified error text was not exported";
  errorTags(root, {
    error: true,
    "error.type": "operation_failed",
    "otel.status_code": "ERROR",
    "otel.status_description": gatewayMessage,
  });
  errorEvent(root, {
    "error.type": "operation_failed",
    "antnest.error.stage": "request",
    "antnest.error.message": gatewayMessage,
    "antnest.error.cause_types": '["*errors.errorString"]',
  });
  errorTags(client, {
    error: true,
    "error.type": "401",
    "otel.status_code": "ERROR",
    "otel.status_description": "HTTP status 401",
  });
  assert.equal(client.logs?.length ?? 0, 0, "unexpected refused CLIENT event");
  const protocolError = {
    "antnest.error.cause_types": '["*domain.Error"]',
    "antnest.error.code": "unauthenticated",
    "antnest.error.message": "Authentication failed",
    "antnest.error.stage": "protocol",
    "antnest.error.type": "unauthenticated",
    "error.type": "unauthenticated",
  };
  errorTags(server, {
    ...protocolError,
    "antnest.outcome": "rejected",
    "antnest.result": "rejected",
  });
  errorEvent(server, protocolError);
  const database = databaseChildrenTopology(trace, server);
  const sql = one(database, "one actual expired browser token SELECT required");
  assert.equal(tag(sql, "db.operation.name"), "SELECT");
  assert.equal(
    tag(sql, "db.query.text").replace(/\s+/gu, " ").trim(),
    "SELECT t.id, t.expires_at, t.idle_expires_at, u.id, m.organization_id, m.id, u.system_role, m.role, u.active, m.active, o.active, o.slug, o.name FROM api_tokens t JOIN users u ON u.id = t.user_id JOIN organization_memberships m ON m.id = t.membership_id AND m.organization_id = t.organization_id AND m.user_id = u.id JOIN organizations o ON o.id = t.organization_id WHERE t.token_hash = $1 AND t.kind = 'browser' AND t.revoked_at IS NULL AND t.expires_at > $2 AND t.idle_expires_at > $2 AND m.scim_deleted_at IS NULL",
  );
  assert.equal(
    tag(sql, "pgx.rows_affected"),
    0,
    "expired token query returned a live row",
  );
  assert(
    database.every((s) => !hasError(s)),
    "expired-session SQL failed",
  );
  const required = new Set([root, decision, client, server, ...database]);
  assert(
    trace.spans.every((s) => required.has(s)),
    "expired-session rejection has unexpected forwarding or work",
  );
  for (const span of [root, decision, client, server])
    owned.push({
      trace_id: trace.traceID,
      span_id: span.spanID,
      reason: "recovered-session-expired",
    });
  // Expected failures remain in unmodified raw sources and the strict result.
  return {
    status: "passed",
    requests,
    owned_error_spans: owned,
    expired_recovery: { status: 401, trace_id: recovered.trace_id },
    ...resolveTraceDiagnostics(
      selected[0],
      sources.filter((t) => selected.includes(t)),
    ),
  };
}
