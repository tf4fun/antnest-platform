import assert from "node:assert/strict";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { assertGatewayResolutionAttributes } from "../../support/gateway-resolution.mjs";
import { inspectWatchResolutions } from "../workspace-closeout/watch-resolution.mjs";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
} from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";

const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const finite = (n) =>
  assert(Number.isFinite(n), "missing stream observation time");
const end = (s) => {
  finite(s.startTime);
  finite(s.duration);
  assert(s.duration >= 0, "unfinished stream span");
  return s.startTime + s.duration;
};
const values = (fields) => {
  const result = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  assert.equal(
    Object.keys(result).length,
    fields.length,
    "duplicate stream field",
  );
  return result;
};
const errorKey =
  /^(error($|\.)|exception\.|db\.response\.status_code$|antnest\.(error\.|outcome$|result$|operation\.phase$|cancellation\.|stream\.termination$|http\.request_cancelled$)|otel\.status_)/u;
function diagnostics(span, expected, event) {
  const tags = values(span.tags ?? []);
  for (const [key, value] of Object.entries(expected))
    assert.equal(tags[key], value, `wrong stream ${key}`);
  for (const [key, value] of Object.entries(tags))
    if (errorKey.test(key) || key === "outcome" || key.endsWith(".outcome")) {
      assert(Object.hasOwn(expected, key), "extra stream error diagnostic");
      assert.equal(value, expected[key]);
    }
  if (!event) {
    assert.equal(span.logs?.length ?? 0, 0, "unexpected disconnect event");
    return;
  }
  const log = one(span.logs ?? [], "one exact stream error event required");
  finite(log.timestamp);
  assert(
    log.timestamp >= span.startTime && log.timestamp <= end(span),
    "stream event outside owning span",
  );
  assert.deepEqual(values(log.fields ?? []), {
    event: "antnest.error",
    ...event,
  });
}
function clean(span, service) {
  assert(!hasError(span), "unrelated stream trace error");
  const tags = values(span.tags ?? []);
  // These existing non-error producer records remain raw observations, never
  // error claims. Preserve their exact shape instead of inventing a failure.
  if (
    service === "agent-acp-service" &&
    tags["antnest.outcome"] === "cancelled"
  ) {
    assert.equal(span.operationName, "HTTP POST antnest-runtime");
    assert.equal(tag(span, "span.kind"), "client");
    assert.equal(tag(span, "http.request.method"), "POST");
    assert.equal(tag(span, "http.response.status_code"), 200);
    assert.equal(tag(span, "peer.service"), "antnest-runtime");
    diagnostics(
      span,
      {
        "antnest.outcome": "cancelled",
        "antnest.operation.phase": "http.send_or_read",
        "antnest.cancellation.type": "AbortError",
      },
      {
        event: "antnest.cancelled",
        "antnest.cancellation.phase": "http.send_or_read",
        "antnest.cancellation.type": "AbortError",
      },
    );
    return;
  }
  for (const field of [
    ...(span.tags ?? []),
    ...(span.logs ?? []).flatMap((log) => log.fields ?? []),
  ])
    if (field.key === "outcome" || field.key.endsWith(".outcome"))
      assert(
        ["success", "ok", "completed", "committed", "admitted"].includes(
          field.value,
        ),
        "contradictory successful span outcome",
      );
  for (const [key, value] of Object.entries(tags)) {
    if (!errorKey.test(key) || key === "antnest.operation.phase") continue;
    assert(
      (key === "otel.status_code" && value === "OK") ||
        (key === "error.type" && value === "") ||
        (["antnest.outcome", "antnest.result"].includes(key) &&
          ["success", "ok"].includes(value)),
      "unrelated successful span diagnostic",
    );
  }
  for (const log of span.logs ?? [])
    for (const field of log.fields ?? [])
      assert(
        (!errorKey.test(field.key) ||
          (field.key === "error.type" && field.value === "")) &&
          field.value !== "antnest.error",
        "unrelated successful span event",
      );
}
const error = { error: true, "otel.status_code": "ERROR" };
const operationMessage =
  "Operation failed; unclassified error text was not exported";
function sseDiagnostics(root, upstream) {
  diagnostics(
    root,
    { ...error, "otel.status_description": "handler_aborted" },
    {
      "antnest.error.panic_type": "*errors.errorString",
      "antnest.error.stage": "handler",
      "error.type": "handler_aborted",
    },
  );
  diagnostics(
    upstream,
    {
      ...error,
      "error.type": "operation_failed",
      "otel.status_description": operationMessage,
    },
    {
      "antnest.error.cause_types": '["*errors.errorString"]',
      "antnest.error.message": operationMessage,
      "antnest.error.stage": "read_response",
      "error.type": "operation_failed",
    },
  );
}
function clock(row, receivedAt) {
  const date = Date.parse(row.server_date);
  assert(
    Number.isFinite(date) && new Date(date).toUTCString() === row.server_date,
    "actual HTTP Date required",
  );
  finite(row.started_at);
  finite(receivedAt);
  assert(receivedAt >= row.started_at, "headers before actual request");
  // HTTP Date locates header emission within a one-second service-clock
  // interval. Relative observation times bound it without equating wall clocks.
  return {
    start: (date - (receivedAt - row.started_at)) * 1000,
    headers: (date + 1000) * 1000,
    lower: (at) => (date + at - receivedAt) * 1000,
    upper: (at) => (date + 1000 + at - row.started_at) * 1000,
  };
}
function transition(evidence, row, service, restart) {
  assert(row, "actual consumer lifecycle missing");
  const { before, after, started_at: started } = row;
  assert(before?.id && after);
  for (const state of [before, after]) {
    assert.equal(state.id, before.id, "consumer container replaced");
    assert.equal(state.project, evidence.project);
    assert.equal(state.service, service);
    assert.equal(state.restarting, false);
    assert.equal(state.oom_killed, false);
    assert.equal(state.exit_code, 0);
    finite(state.at);
    assert(Number.isSafeInteger(state.observed_at_ms));
  }
  assert.equal(before.running, true);
  assert.equal(before.health, "healthy");
  assert.equal(after.running, restart);
  if (restart) assert.equal(after.health, "healthy");
  finite(started);
  assert(
    before.at <= started && started < after.at,
    "invalid lifecycle observation order",
  );
  const old = Date.parse(before.started_at),
    finished = Date.parse(after.finished_at),
    current = Date.parse(after.started_at);
  [old, finished, current].forEach(finite);
  assert(
    old < finished &&
      before.observed_at_ms <= finished &&
      finished <= after.observed_at_ms,
    "unproved normal process termination",
  );
  if (restart)
    assert(
      finished < current && current <= after.observed_at_ms,
      "consumer process did not restart",
    );
  else assert.equal(current, old, "drain process replaced");
  return {
    ...row,
    process_start: old * 1000,
    finished_upper: (finished + 1) * 1000,
  };
}

export function inspectOutageStreams(evidence, collection, secrets = []) {
  assert.equal(evidence.settings.resolveTTLMS, 10000);
  assert.equal(evidence.settings.captureRpcContent, false);
  const get = (id) => {
    assert.match(id ?? "", /^[a-f0-9]{32}$/u);
    assert(collection.archivedTraceIDs?.has(id), "stream source not archived");
    const trace = collection.traces.get(id);
    assert(trace, "stream source missing");
    return trace;
  };
  const first = get(evidence.stream.trace_id),
    sources = resolveTraceSources(first, secrets, collection);
  for (const source of sources) assertGatewayResolutionAttributes(source);
  const cases = evidence.recovery?.cases;
  assert.deepEqual(
    cases?.map((c) => c.name),
    ["logout", "password", "role", "deactivate"],
  );
  const byLabel = (label) =>
    one(
      evidence.http.filter((r) => r.label === label),
      `actual ${label} missing`,
    );
  const sameHTTP = (row) =>
    assert.deepEqual(
      one(
        evidence.http.filter(
          (r) => r === row || (row.trace_id && r.trace_id === row.trace_id),
        ),
        "actual stream-related response missing or duplicate",
      ),
      row,
    );
  const loginScope = (row) => {
    sameHTTP(row);
    assert.equal(row.path, "/api/session/login");
    assert.equal(row.method, "POST");
    assert.equal(row.status, 200);
    assert.equal(row.set_cookie_count, 2);
    assert(
      typeof row.issued_credential_scope === "string" &&
        row.issued_credential_scope,
    );
    return row.issued_credential_scope;
  };
  const warmLogin = byLabel("warm-login"),
    prepLogin = byLabel("prep-login");
  const warmScope = loginScope(warmLogin),
    prepScope = loginScope(prepLogin);
  const scopes = cases.map((c) => loginScope(c.login));
  assert.equal(
    new Set([warmScope, prepScope, ...scopes]).size,
    cases.length + 2,
    "independent credentials collapsed",
  );
  const password = cases[1];
  for (const key of ["user_id", "membership_id", "organization_id"]) {
    assert(warmLogin.body?.principal?.[key], "warm principal missing");
    assert.equal(
      password.login.body?.principal?.[key],
      warmLogin.body.principal[key],
      "password changed another member",
    );
  }
  const base = `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}`;
  const owned = [],
    selected = new Map();
  const claim = (trace, span, reason) => {
    const key = `${trace.traceID}:${span.spanID}`;
    assert(!selected.has(key), "duplicate stream claim");
    selected.set(key, span);
    owned.push({ trace_id: trace.traceID, span_id: span.spanID, reason });
  };
  const boundary = (id, row, receivedAt) => {
    const trace = get(id),
      tree = traceTopology(trace);
    const root = one(
      trace.spans.filter((s) => !tree.parent(s)),
      "one actual stream/view root required",
    );
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tag(root, "span.kind"), "server");
    assert.equal(tag(root, "http.request.method"), "GET");
    assert.equal(tag(root, "http.route"), "/api/app/workspace/v1/{path...}");
    assert.equal(tag(root, "http.response.status_code"), 200);
    const ui = one(
      trace.spans.filter(
        (s) =>
          tree.service(s) === "agent-ui" && tag(s, "span.kind") === "server",
      ),
      "one actual Agent UI receiver required",
    );
    assert.equal(ui.operationName, "agent_ui.http.request");
    assert.equal(tag(ui, "http.route"), "/api/app/workspace/v1/*");
    assert.equal(tag(ui, "http.request.method"), "GET");
    assert.equal(tag(ui, "http.response.status_code"), 200);
    const upstream = tree.parent(ui);
    assert.equal(tree.service(upstream), "edge-gateway");
    assert.equal(tree.parent(upstream), root);
    assert.equal(tag(upstream, "span.kind"), "client");
    assert.equal(upstream.operationName, "HTTP GET agent-ui");
    assert.equal(tag(upstream, "http.request.method"), "GET");
    assert.equal(tag(upstream, "server.address"), "agent-ui");
    assert.equal(tag(upstream, "http.response.status_code"), 200);
    for (const span of trace.spans) {
      assert(tree.chain(span).includes(root));
      end(span);
    }
    assert(upstream.startTime >= root.startTime && end(upstream) <= end(root));
    const interval = clock(row, receivedAt);
    assert(
      root.startTime >= interval.start && root.startTime < interval.headers,
      "root outside observed admission interval",
    );
    const decisions = trace.spans.filter(
      (s) => s.operationName === "gateway.identity.resolve",
    );
    for (const decision of decisions)
      assert.equal(
        tag(decision, resolvePrefix + "outcome"),
        "admitted",
        "unrelated failed revalidation",
      );
    const { allowedErrors, ...resolution } = inspectWatchResolutions(
      trace,
      root,
      upstream,
      { traceID: id, resolveTTLMS: 10000 },
      collection,
      () => false,
    );
    assert.equal(allowedErrors.size, 0, "stream cannot claim failed Resolve");
    for (const record of [
      resolution.gateway_resolution,
      ...resolution.gateway_revalidations,
    ]) {
      if (!record.rpc_client_span_id) continue;
      const source = get(record.source_trace_id),
        sourceTree = traceTopology(source);
      const client = sourceTree.spans.get(record.rpc_client_span_id),
        server = sourceTree.spans.get(record.identity_server_span_id);
      for (const span of [
        client,
        server,
        ...databaseChildrenTopology(source, server),
      ])
        clean(span, sourceTree.service(span));
    }
    return { trace, tree, root, upstream, ui, interval, resolution };
  };
  const streamItems = [
    {
      name: "warm",
      stream: evidence.stream,
      session_id: evidence.session_id,
      scope: warmScope,
      mutation: password,
    },
    ...cases.map((c, i) => ({
      name: c.name,
      stream: c.stream,
      session_id: c.session_id,
      scope: scopes[i],
      mutation: c,
    })),
  ];
  assert.equal(
    new Set(streamItems.map((s) => s.stream.trace_id)).size,
    streamItems.length,
    "reused public stream",
  );
  const streams = streamItems.map((item) => {
    const { stream: s, mutation: c } = item,
      closure = s.closure;
    assert.equal(
      s.path,
      `${base}/events?sessionId=${encodeURIComponent(item.session_id)}`,
    );
    assert.equal(s.credential_scope, item.scope);
    assert.equal(s.status, 200);
    assert.equal(s.set_cookie_count, 0);
    assert(
      ["transport-end", "remote-end"].includes(closure?.kind),
      "actual remote stream retirement missing",
    );
    assert.equal(closure.trace_id, s.trace_id, "foreign stream closure");
    [s.started_at, s.headers_at, closure.at, c.trigger.at].forEach(finite);
    assert(
      Number.isSafeInteger(closure.observed_at_ms) &&
        Number.isSafeInteger(c.trigger.observed_at_ms),
    );
    assert(
      s.started_at <= s.headers_at &&
        s.headers_at < c.trigger.at &&
        closure.at >= c.trigger.at &&
        closure.at <= c.trigger.at + 30000,
      "stream closed outside mutation window",
    );
    assert(
      closure.observed_at_ms >= c.trigger.observed_at_ms &&
        closure.observed_at_ms <= c.trigger.observed_at_ms + 30000,
    );
    sameHTTP(c.mutation);
    const path =
      c.name === "logout"
        ? "/api/session"
        : c.name === "password"
          ? "/api/session/password"
          : `/api/admin/directory/memberships/${encodeURIComponent(c.login.body.principal.membership_id)}`;
    assert.equal(c.mutation.path, path);
    assert.equal(c.mutation.method, c.name === "logout" ? "DELETE" : "POST");
    assert.equal(c.mutation.status, c.name === "logout" ? 204 : 200);
    if (["logout", "password"].includes(c.name))
      assert.equal(
        c.mutation.credential_scope,
        c.login.issued_credential_scope,
      );
    assert(
      c.trigger.at <= c.mutation.started_at &&
        c.mutation.started_at <= c.mutation.at &&
        c.mutation.started_at <= closure.at,
    );
    const b = boundary(s.trace_id, s, s.headers_at);
    if (end(b.root) - b.root.startTime > evidence.settings.resolveTTLMS * 1000)
      assert(
        b.resolution.gateway_revalidations.length > 0,
        "long stream lacks actual successful revalidation",
      );
    for (const span of [b.root, b.upstream, b.ui])
      assert(
        end(span) >= b.interval.lower(c.trigger.at) &&
          end(span) < b.interval.upper(closure.at),
        "stream span ended outside actual closure interval",
      );
    sseDiagnostics(b.root, b.upstream);
    claim(b.trace, b.root, "public-sse-revoked-handler");
    claim(b.trace, b.upstream, "public-sse-revoked-response");
    for (const span of b.trace.spans)
      if (span !== b.root && span !== b.upstream)
        clean(span, b.tree.service(span));
    return { name: item.name, trace_id: s.trace_id, ...b.resolution };
  });
  const acp = transition(
    evidence,
    one(
      evidence.consumer_restarts.filter(
        (r) => r.service === "agent-acp-service",
      ),
      "one ACP restart required",
    ),
    "agent-acp-service",
    true,
  );
  const ui = transition(
    evidence,
    one(
      evidence.consumer_restarts.filter((r) => r.service === "agent-ui"),
      "one UI restart required",
    ),
    "agent-ui",
    true,
  );
  const drain = transition(evidence, evidence.ui_drain, "agent-ui", false);
  assert.equal(drain.before.id, ui.after.id, "drain of different UI container");
  assert.equal(
    drain.before.started_at,
    ui.after.started_at,
    "drain of different UI process",
  );
  assert(
    streamItems.every((s) => s.stream.closure.at < drain.started_at),
    "UI drained before public closure",
  );
  const views = [
    {
      row: byLabel("prep-view"),
      scope: prepScope,
      session: evidence.session_id,
      lifecycle: acp,
      prep: true,
    },
    ...["warm-workspace-view", "recovered-workspace-view"].map((label) => ({
      row: byLabel(label),
      scope: warmScope,
      session: evidence.session_id,
      lifecycle: drain,
    })),
    ...cases.map((c, i) => ({
      row: c.initial_view,
      scope: scopes[i],
      session: c.session_id,
      lifecycle: drain,
    })),
  ];
  assert.equal(
    new Set([
      ...views.map((v) => v.row.trace_id),
      ...streamItems.map((v) => v.stream.trace_id),
    ]).size,
    views.length + streams.length,
    "reused stream/view receipt",
  );
  const watches = [];
  for (const v of views) {
    const row = v.row;
    sameHTTP(row);
    assert.equal(
      row.path,
      `${base}/sessions/${encodeURIComponent(v.session)}/view`,
    );
    assert.equal(row.method, "GET");
    assert.equal(row.status, 200);
    assert.equal(row.set_cookie_count, 0);
    assert.equal(row.credential_scope, v.scope);
    assert(
      row.at < v.lifecycle.started_at,
      "view after closing lifecycle began",
    );
    const b = boundary(row.trace_id, row, row.at);
    for (const span of b.trace.spans) {
      if (b.tree.service(span) !== "agent-acp-service" || !hasError(span)) {
        clean(span, b.tree.service(span));
        continue;
      }
      assert.equal(b.tree.parent(span), b.ui, "watch not owned by actual view");
      assert.equal(tag(span, "span.kind"), "server");
      assert.equal(tag(span, "http.response.status_code"), 200);
      assert(
        span.startTime >= v.lifecycle.process_start &&
          span.startTime >= b.interval.start &&
          span.startTime < end(span),
      );
      const finished = end(span);
      assert(
        finished >= b.interval.lower(v.lifecycle.started_at) &&
          finished <
            Math.min(
              b.interval.upper(v.lifecycle.after.at),
              v.lifecycle.finished_upper,
            ),
        "watch outside actual normal termination",
      );
      let reason;
      if (tag(span, "http.route") === "/v1/acp") {
        assert.equal(span.operationName, "HTTP GET /v1/acp");
        assert.equal(tag(span, "http.request.method"), "GET");
        for (const key of ["rpc.method", "rpc.service", "rpc.system.name"])
          assert.equal(tag(span, key), undefined);
        diagnostics(span, {
          ...error,
          "error.type": "stream_interrupted",
          "antnest.outcome": "disconnected",
        });
        reason = v.prep
          ? "internal-acp-restart-disconnect"
          : "internal-ui-drain-disconnect";
      } else {
        assert(v.prep, "shutdown witness belongs to preparation view");
        assert.equal(
          span.operationName,
          "HTTP POST /rpc/agent-acp/watch-agent-execution-state",
        );
        assert.equal(
          tag(span, "http.route"),
          "/rpc/agent-acp/watch-agent-execution-state",
        );
        assert.equal(tag(span, "http.request.method"), "POST");
        assert.equal(tag(span, "rpc.method"), "watch_agent_execution_state");
        assert.equal(tag(span, "rpc.service"), "agent-acp");
        assert.equal(tag(span, "rpc.system.name"), "json-over-http");
        assert.equal(
          tag(span, "antnest.agent.id"),
          evidence.agent_id,
          "shutdown of another Agent",
        );
        assert.equal(
          tag(span, "antnest.organization.id"),
          prepLogin.body.principal.organization_id,
          "shutdown in another organization",
        );
        diagnostics(
          span,
          {
            ...error,
            "error.type": "Error",
            "antnest.outcome": "error",
            "antnest.operation.phase": "agent.execution_state",
            "antnest.stream.termination": "process-shutdown",
          },
          {
            "antnest.error.cause_types": "[]",
            "antnest.error.causes":
              '[{"type":"Error","message":"Error: unregistered message omitted"}]',
            "antnest.error.message": "Error: unregistered message omitted",
            "antnest.error.stage": "agent.execution_state",
            "antnest.error.type": "Error",
            "antnest.operation.phase": "agent.execution_state",
          },
        );
        reason = "internal-acp-normal-shutdown";
      }
      claim(b.trace, span, reason);
      watches.push({ trace_id: b.trace.traceID, span_id: span.spanID, reason });
    }
  }
  assert(
    watches.some((w) => w.reason === "internal-acp-restart-disconnect"),
    "actual ACP restart watch missing",
  );
  assert(
    watches.some((w) => w.reason === "internal-ui-drain-disconnect"),
    "actual UI drain watch missing",
  );
  assert(
    watches.some((w) => w.reason === "internal-acp-normal-shutdown"),
    "marked normal shutdown watch missing",
  );
  return {
    status: "passed",
    streams,
    internal_watches: watches,
    owned_error_spans: owned,
    ...resolveTraceDiagnostics(first, sources),
  };
}

const resolvePrefix = "antnest.identity.resolve.";
