import assert from "node:assert/strict";
import {
  inspectGatewayResolution,
  assertGatewayResolutionAttributes,
} from "../../support/gateway-resolution.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { hasDiagnosticError, hasError } from "../acp-plan/requests.mjs";
import { inspectWorkspaceFailureSource } from "../workspace-closeout/watch-resolution.mjs";
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
const diagnosticKey =
  /^(error($|\.)|exception\.|http\.transport\.error\.|db\.response\.status_code$|antnest\.(error\.|outcome$|result$|operation\.phase$|cancellation\.|stream\.termination$|http\.request_cancelled$)|otel\.status_)/u;
function errorTags(span, expected) {
  const actual = fields(span.tags ?? []);
  for (const [key, value] of Object.entries(expected))
    assert.equal(actual[key], value, `missing or wrong refusal ${key}`);
  for (const [key, value] of Object.entries(actual))
    if (
      diagnosticKey.test(key) ||
      key === "outcome" ||
      key.endsWith(".outcome")
    ) {
      assert(Object.hasOwn(expected, key), "unrelated refusal error metadata");
      assert.equal(value, expected[key], "unrelated refusal error metadata");
    }
}
function errorEvent(span, expected, process) {
  const event = one(span.logs ?? [], "one exact refusal event required");
  const finish = end(span),
    languages = (process?.tags ?? []).filter(
      (field) => field.key === "telemetry.sdk.language",
    );
  // Go records these events before ending the span. Jaeger independently
  // exports start, duration and event in integer microseconds, so their sums
  // can differ by one quantum. Keep raw timestamps and the lower bound intact.
  const quantizedGoEnd =
    languages.length === 1 &&
    languages[0].value === "go" &&
    [span.startTime, span.duration, event.timestamp, finish, finish + 1].every(
      Number.isSafeInteger,
    ) &&
    event.timestamp === finish + 1;
  assert(
    Number.isFinite(event.timestamp) &&
      event.timestamp >= span.startTime &&
      (event.timestamp <= finish || quantizedGoEnd),
    "refusal event outside owning span",
  );
  const actual = fields(event.fields ?? []);
  assert.deepEqual(actual, { event: "antnest.error", ...expected });
}
function decisionError(span, outcome) {
  errorTags(span, {
    error: true,
    [prefix + "outcome"]: outcome,
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
function transportFailure(span, stage, profile, process) {
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
  errorEvent(
    span,
    {
      "error.type": type,
      "antnest.error.stage": stage,
      "antnest.error.message": expected.message,
      "antnest.error.cause_types": value,
    },
    process,
  );
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

// Shared by the original SSE revalidation and its later independent HTTP
// denial. This proves an actual Resolve failure, not why the browser closed.
export function inspectWorkspaceFailureReceipt(
  trace,
  root,
  decision,
  collection,
  requestTimeoutMs,
) {
  const selected = inspectWorkspaceFailureSource(
    trace,
    root,
    decision,
    collection,
  );
  const { trace: source, tree, span: client, record } = selected;
  decisionError(decision, record.outcome);
  const currentSpans = new Set([decision]);
  if (source === trace) currentSpans.add(client);
  const receivers = source.spans.filter((s) => tree.parent(s) === client);
  if (record.outcome === "unavailable") {
    assert.equal(
      receivers.length,
      0,
      "unavailable transport invented receiver work",
    );
    assert.equal(tag(client, "http.response.status_code"), undefined);
    const timeout = tag(client, "antnest.request.timeout_ms");
    assert(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0);
    assert(
      Number.isSafeInteger(timeout) &&
        timeout >= 0 &&
        timeout <= requestTimeoutMs,
      "failed Identity CLIENT exceeds its request budget",
    );
    const failure = transportFailure(
      client,
      "send",
      "workspace",
      source.processes[client.processID],
    );
    assert(
      ["network_error", "dns_error", "deadline_exceeded"].includes(
        failure.type,
      ),
      "caller cancellation cannot prove Identity outage",
    );
    if (record.cancel_kind === "shared-deadline")
      assert.deepEqual(
        failure,
        {
          type: "deadline_exceeded",
          causes: ["context.deadlineExceededError"],
        },
        "shared deadline does not match its completed actual CLIENT",
      );
    return {
      ...selected,
      client,
      currentSpans,
      failure,
      record: { ...record, database_spans: 0, transport_failure: failure },
    };
  }
  const server = one(receivers, "one actual rejected Identity SERVER required");
  assert.equal(tree.service(server), "identity-service");
  assert.equal(tag(server, "span.kind"), "server");
  assert.equal(tag(server, "http.request.method"), "POST");
  assert.equal(tag(server, "http.route"), "/rpc/identity/resolve-access-token");
  assert.equal(tag(server, "rpc.method"), "resolve_access_token");
  assert.equal(tag(server, "http.response.status_code"), 401);
  assert.equal(tag(client, "http.response.status_code"), 401);
  errorTags(client, {
    error: true,
    "error.type": "401",
    "otel.status_code": "ERROR",
    "otel.status_description": "HTTP status 401",
  });
  assert.equal(client.logs?.length ?? 0, 0);
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
  errorEvent(server, protocolError, source.processes[server.processID]);
  const sql = one(
    databaseChildrenTopology(source, server),
    "one actual rejected token SELECT required",
  );
  assert.equal(tree.parent(sql), server);
  assert.equal(sql.processID, server.processID);
  assert(
    sql.startTime >= server.startTime && end(sql) <= end(server),
    "token SELECT outside its Identity receiver",
  );
  assert.equal(tag(sql, "db.operation.name"), "SELECT");
  assert.equal(
    tag(sql, "db.query.text").replace(/\s+/gu, " ").trim(),
    "SELECT t.id, t.expires_at, t.idle_expires_at, u.id, m.organization_id, m.id, u.system_role, m.role, u.active, m.active, o.active, o.slug, o.name FROM api_tokens t JOIN users u ON u.id = t.user_id JOIN organization_memberships m ON m.id = t.membership_id AND m.organization_id = t.organization_id AND m.user_id = u.id JOIN organizations o ON o.id = t.organization_id WHERE t.token_hash = $1 AND t.kind = 'browser' AND t.revoked_at IS NULL AND t.expires_at > $2 AND t.idle_expires_at > $2 AND m.scim_deleted_at IS NULL",
  );
  assert.equal(tag(sql, "pgx.rows_affected"), 0);
  assert(!hasDiagnosticError(sql), "rejected token SELECT failed");
  assert.equal(sql.logs?.length ?? 0, 0);
  for (const [key, value] of Object.entries(fields(sql.tags ?? [])))
    if (
      diagnosticKey.test(key) ||
      key === "outcome" ||
      key.endsWith(".outcome")
    )
      assert(
        (key === "error" && value === false) ||
          (key === "error.type" && value === "") ||
          (key === "antnest.error.class" && value === "none") ||
          (key === "otel.status_code" &&
            ["OK", "UNSET", 0, 1].includes(value)) ||
          ((key === "antnest.result" ||
            key === "outcome" ||
            key.endsWith(".outcome")) &&
            value === "success"),
        "unrelated rejected token SELECT diagnostic",
      );
  const synchronous = new Set([client, server, sql]);
  assert(
    source.spans
      .filter((span) => tree.chain(span).includes(client))
      .every((span) => synchronous.has(span)),
    "rejected RPC contains unrelated synchronous work",
  );
  if (source === trace) {
    currentSpans.add(server);
    currentSpans.add(sql);
  }
  return {
    ...selected,
    client,
    server,
    sql,
    currentSpans,
    record: {
      ...record,
      database_spans: 1,
      identity_server_span_id: server.spanID,
      token_read_span_id: sql.spanID,
    },
  };
}

export function inspectGatewayIdentityRejection(
  trace,
  expected,
  collection,
  secrets = [],
) {
  assert.equal(expected.traceID, trace.traceID);
  assert.equal(expected.method, "POST");
  assert.match(
    expected.path ?? "",
    /^\/api\/app\/workspace\/v1\/agents\/[^/]+\/sessions\/[^/]+\/prompts$/u,
  );
  assert.equal(expected.profile, "workspace");
  assert([401, 503].includes(expected.status));
  assert.equal(
    expected.code,
    expected.status === 401 ? "unauthenticated" : "identity_unavailable",
  );
  assert(
    collection.archivedTraceIDs?.has(trace.traceID),
    "actual HTTP denial not archived",
  );
  const sources = resolveTraceSources(trace, secrets, collection);
  for (const source of sources) {
    assertGatewayResolutionAttributes(source);
    for (const span of source.spans) {
      end(span);
      fields(span.tags ?? []);
      for (const event of span.logs ?? []) fields(event.fields ?? []);
    }
  }
  const tree = traceTopology(trace);
  const root = one(
    trace.spans.filter((s) => !tree.parent(s)),
    "one actual denial HTTP root required",
  );
  assert.equal(tree.service(root), "edge-gateway");
  for (const [key, value] of Object.entries({
    "span.kind": "server",
    "http.route": "/api/app/workspace/v1/{path...}",
    "http.request.method": "POST",
    "http.response.status_code": expected.status,
  }))
    assert.equal(tag(root, key), value);
  const decision = one(
    trace.spans.filter((s) => s.operationName === "gateway.identity.resolve"),
    "one failed HTTP Resolve decision required",
  );
  const failure = inspectWorkspaceFailureReceipt(
    trace,
    root,
    decision,
    collection,
    expected.requestTimeoutMs,
  );
  assert.equal(
    failure.record.outcome,
    expected.status === 401 ? "rejected" : "unavailable",
  );
  if (expected.status === 401) {
    const message =
      "Operation failed; unclassified error text was not exported";
    errorTags(root, {
      error: true,
      "error.type": "operation_failed",
      "otel.status_code": "ERROR",
      "otel.status_description": message,
    });
    errorEvent(
      root,
      {
        "error.type": "operation_failed",
        "antnest.error.stage": "request",
        "antnest.error.message": message,
        "antnest.error.cause_types": '["*errors.errorString"]',
      },
      trace.processes[root.processID],
    );
  } else {
    const rootFailure = transportFailure(
      root,
      "request",
      "workspace",
      trace.processes[root.processID],
    );
    assert.equal(rootFailure.type, failure.failure.type);
    if (
      rootFailure.type === "deadline_exceeded" &&
      rootFailure.causes.length === 1 &&
      rootFailure.causes[0] === "context.deadlineExceededError"
    ) {
      // Retained Resolve work returns its context deadline directly after
      // transport cleanup. Keep the selected actual CLIENT and its complete
      // deadline receipt; a bare request error alone proves no dependency fault.
      assert.deepEqual(
        failure.failure.causes,
        ["context.deadlineExceededError"],
        "unwrapped HTTP deadline does not match its completed actual CLIENT",
      );
    } else
      assert.deepEqual(
        rootFailure.causes,
        ["*fmt.wrapError", "*url.Error", ...failure.failure.causes].slice(0, 4),
        "HTTP failure does not wrap the selected actual CLIENT",
      );
  }
  const required = new Set([root, ...failure.currentSpans]);
  assert(
    trace.spans.every((s) => required.has(s)),
    "denied prompt reached unrelated work or execution",
  );
  return {
    trace_id: trace.traceID,
    root_span_id: root.spanID,
    status: expected.status,
    no_execution: true,
    resolution: failure.record,
    ...resolveTraceDiagnostics(trace, sources),
  };
}
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

// Match the retained Gateway caller selection, including decoded Agent IDs
// and bootstrap's empty Agent key. Trace labels cannot redefine this key.
function historyKey(path) {
  const pathname = decodeURIComponent(
    new URL(path, "http://evidence.invalid").pathname,
  );
  if (pathname === "/api/session" || pathname.startsWith("/api/session/"))
    return { profile: "session", agent: "" };
  if (pathname.startsWith("/api/admin/"))
    return { profile: "console", agent: "" };
  const base = "/api/app/workspace/v1/";
  assert(pathname.startsWith(base), "unknown protected cache-key history path");
  const relative = pathname.slice(base.length);
  if (relative === "bootstrap") return { profile: "workspace", agent: "" };
  const parts = relative.split("/");
  assert(
    parts.length >= 3 &&
      parts[0] === "agents" &&
      parts[1].length > 0 &&
      parts[1].length <= 200 &&
      !/[\\\0\r\n]/u.test(parts[1]),
    "workspace cache-key history lacks the actual Agent path",
  );
  return { profile: "workspace", agent: parts[1] };
}

export function inspectOutageRejections(evidence, collection, secrets = []) {
  assert(
    [3, 4].includes(evidence.policy_revision),
    "unsupported outage evidence revision",
  );
  const bridge = evidence.policy_revision === 4;
  if (bridge) assert.equal(evidence.transport, "http-sse");
  else
    assert(
      evidence.transport !== "http-sse" &&
        !evidence.http.some((r) =>
          ["stopped-cold-profile", "stopped-cold-agent"].includes(r.label),
        ),
      "Bridge evidence requires revision 4",
    );
  const noStore = (r) =>
    assert(
      typeof r.cache_control === "string" &&
        r.cache_control
          .toLowerCase()
          .split(",")
          .some((directive) => directive.trim() === "no-store"),
      "actual refusal must contain a complete no-store directive",
    );
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
    owned = [],
    actualRequests = new Map();
  const raw = (observation) => {
    const previous = actualRequests.get(observation.trace_id);
    if (previous) {
      assert.equal(
        previous.observation,
        observation,
        "actual HTTP Trace reused by different request receipts",
      );
      return previous.result;
    }
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
    const result = { trace, tree, root };
    actualRequests.set(observation.trace_id, { observation, result });
    return result;
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
    expiredScope = login("short-idle-login"),
    warmScope = login("warm-login");
  assert.equal(
    new Set([
      consoleScope,
      workspaceScope,
      expiredScope,
      warmScope,
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
  let history;
  if (bridge) {
    const agent = evidence.cold_agent,
      setup = evidence.cold_agent_setup;
    assert(
      typeof agent?.agent_id === "string" &&
        agent.agent_id.length > 0 &&
        agent.agent_id !== evidence.agent_id,
      "cold cache key requires a distinct ready Agent",
    );
    const owner = row("warm-login").body?.principal?.user_id;
    assert(typeof owner === "string" && owner.length > 0, "warm owner missing");
    assert.equal(
      agent.owner_user_id,
      owner,
      "cold Agent has a different owner",
    );
    assert.equal(agent.desired_state, "enabled");
    assert.equal(agent.activation_state, "enabled");
    assert.equal(agent.runtime_state, "available");
    assert(
      typeof agent.executable_execution_revision === "string" &&
        agent.executable_execution_revision.length > 0,
    );
    assert.equal(
      agent.last_successful_execution_revision,
      agent.executable_execution_revision,
    );
    assert.equal(setup?.agent_id, agent.agent_id, "different cold Agent setup");
    assert.equal(setup.owner_user_id, owner);
    assert.equal(
      setup.executable_execution_revision,
      agent.executable_execution_revision,
    );
    assert(
      Number.isFinite(setup.ready_at) && setup.ready_at < start,
      "cold Agent must be ready before the stop",
    );
    const hit = row("warm-workspace-hit");
    assert.equal(hit.credential_scope, warmScope, "warm credential differs");
    assert.equal(hit.method, "GET");
    assert.equal(
      hit.path,
      `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}/sessions/${encodeURIComponent(evidence.session_id)}/view`,
    );
    assert.equal(hit.status, 200);
    assert.equal(hit.set_cookie_count, 0);
    assert.equal(hit.issued_credential_scope, undefined);
    assert(
      Number.isFinite(hit.started_at) &&
        Number.isFinite(hit.at) &&
        hit.started_at > row("warm-login").at &&
        hit.at >= hit.started_at &&
        hit.at < start,
      "warm cache hit must complete before the stop",
    );
    const { trace, root } = raw(hit);
    assert(
      trace.spans.every((s) => !hasError(s)),
      "warm cache hit contains a failure",
    );
    const decision = one(
      trace.spans.filter((s) => s.operationName === "gateway.identity.resolve"),
      "warm workspace Resolve decision missing",
    );
    const resolution = inspectGatewayResolution(
      trace,
      {
        rootSpanID: root.spanID,
        decisionSpanID: decision.spanID,
        profile: "workspace",
        ttlMs: 10000,
      },
      collection,
    );
    assert.equal(resolution.source, "cache");

    // SSE is a separate public request inventory. Its admission, rather than
    // its eventual closure, can warm the same Cookie/profile/Agent cache key.
    const streams = [
      evidence.stream,
      ...(evidence.recovery?.cases ?? []).map((c) => c.stream),
    ]
      .filter(Boolean)
      .map((stream) => {
        scopeID(stream.credential_scope);
        return { ...stream, method: "GET" };
      });
    history = [...evidence.http, ...streams];
    for (const request of history) {
      assert(
        Number.isFinite(request.started_at),
        "cache-key history lacks request time",
      );
      assert(
        typeof request.path === "string" && request.path.startsWith("/"),
        "cache-key history lacks request path",
      );
      if (request.credential_scope !== null) scopeID(request.credential_scope);
      else
        assert(
          request.path === "/api/session/login" && request.method === "POST",
          "unauthenticated history must be an actual login request",
        );
    }
  }
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
    ...(bridge
      ? [
          ["stopped-cold-profile", "session", "/api/session", "GET", warmScope],
          [
            "stopped-cold-agent",
            "workspace",
            `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.cold_agent.agent_id)}/sessions`,
            "GET",
            warmScope,
          ],
        ]
      : [
          [
            "stopped-cold-acp",
            "acp",
            `/api/app/agents/${encodeURIComponent(evidence.agent_id)}/v1/acp`,
            "POST",
            workspaceScope,
          ],
        ]),
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
    if (bridge) noStore(r);
    assert.equal(r.body?.code, "identity_unavailable");
    assert(
      typeof r.body.message === "string" && r.body.message.length > 0,
      "actual HTTP error message missing",
    );
    assert.equal(r.set_cookie_count, 0);
    assert.equal(
      r.credential_scope,
      scope,
      scope === warmScope
        ? "original warm credential required"
        : "wrong refusal credential",
    );
    assert.equal(r.issued_credential_scope, undefined);
    if (bridge && scope === warmScope) {
      for (const prior of history.filter(
        (other) =>
          other !== r &&
          other.credential_scope === scope &&
          other.started_at < r.started_at,
      )) {
        const key = historyKey(prior.path);
        const { trace, tree, root } = raw(prior);
        const decisions = trace.spans.filter(
          (s) => s.operationName === "gateway.identity.resolve",
        );
        if (prior.status >= 200 && prior.status < 300)
          assert(
            decisions.length > 0,
            "protected history response lacks actual Resolve admission",
          );
        for (const decision of decisions) {
          assert.equal(tree.service(decision), "edge-gateway");
          assert.equal(tree.parent(decision), root);
          assert.equal(
            tag(decision, prefix + "profile"),
            key.profile,
            "history Resolve differs from server-selected profile",
          );
        }
        if (key.profile !== profile) continue;
        if (profile === "session")
          assert.fail("cold profile was already used by the warm credential");
        assert.notEqual(
          key.agent,
          evidence.cold_agent.agent_id,
          "cold Agent was already used by the warm credential",
        );
      }
    } else if (label.startsWith("stopped-cold-"))
      assert(
        !(bridge ? history : evidence.http).some(
          (other) =>
            other !== r &&
            other.credential_scope === scope &&
            other.started_at < (bridge ? r.started_at : start),
        ),
        "cold credential was already used before stop",
      );
    const { trace, tree, root } = raw(r);
    const markers = trace.spans.filter(
      (s) => s.operationName === "gateway.identity.resolve",
    );
    const rootFailure = transportFailure(
      root,
      "request",
      profile,
      trace.processes[root.processID],
    );
    let decision;
    if (profile) {
      decision = one(markers, "one failed Resolve decision required");
      assert.equal(tree.parent(decision), root);
      assert.equal(tree.service(decision), "edge-gateway");
      assert.equal(tag(decision, "span.kind"), "internal");
      assert.equal(tag(decision, prefix + "profile"), profile);
      assert.equal(tag(decision, prefix + "source"), "rpc");
      assert.equal(tag(decision, prefix + "outcome"), "unavailable");
      assert.equal(tag(decision, prefix + "shared_source_state"), undefined);
      assert.equal(decision.processID, root.processID);
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
    assert.equal(client.processID, root.processID);
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
    const clientFailure = transportFailure(
      client,
      "send",
      profile,
      trace.processes[client.processID],
    );
    const waiterDeadline =
      profile &&
      rootFailure.type === "deadline_exceeded" &&
      rootFailure.causes.length === 1 &&
      rootFailure.causes[0] === "context.deadlineExceededError";
    const cancelKind = decision && tag(decision, prefix + "cancel_kind");
    if (cancelKind !== undefined) {
      assert(
        waiterDeadline &&
          ["caller-deadline", "shared-deadline"].includes(cancelKind),
        "RPC cancellation lacks the original deadline outcome",
      );
      assert(
        cancelKind === "shared-deadline"
          ? clientFailure.type === "deadline_exceeded"
          : ["cancelled", "deadline_exceeded"].includes(clientFailure.type),
        "RPC cancellation differs from its actual CLIENT failure",
      );
      if (cancelKind === "shared-deadline")
        assert.deepEqual(
          clientFailure.causes,
          ["context.deadlineExceededError"],
          "shared deadline differs from its actual CLIENT cause",
        );
    }
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
      ...(cancelKind === undefined ? {} : { cancel_kind: cancelKind }),
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
  if (bridge) noStore(recovered);
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
  errorEvent(
    root,
    {
      "error.type": "operation_failed",
      "antnest.error.stage": "request",
      "antnest.error.message": gatewayMessage,
      "antnest.error.cause_types": '["*errors.errorString"]',
    },
    trace.processes[root.processID],
  );
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
  errorEvent(server, protocolError, trace.processes[server.processID]);
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
