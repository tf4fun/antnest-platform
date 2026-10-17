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
import { inspectRecoveryHTTP } from "./resolve-cache-recovery-http.mjs";
import {
  completedInitializeRead,
  completedSessionLoadRead,
  completedSessionNewRead,
} from "./resolve-cache-outage-diagnostics.mjs";
import { inspectRuntimeInformationRead } from "../observability/runtime-information-read.mjs";
import { inspectOutageOwnerInventory } from "./resolve-cache-outage-owner.mjs";
import { cleanupInventory } from "./resolve-cache-load-close.mjs";
import { inspectOutageACPClock } from "./resolve-cache-outage-clock.mjs";
import { inspectBrowserFeedWitness } from "../identity-closeout/browser-feed-witness.mjs";

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
  /^(error($|\.)|exception\.|http\.transport\.error\.|db\.response\.status_code$|antnest\.(error\.|outcome$|result$|operation\.phase$|cancellation\.|stream\.termination$|http\.request_cancelled$)|otel\.status_)/u;
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
function cleanSpan(
  span,
  service,
  trace,
  validatedTermination,
  recordRead,
  completedRead,
) {
  assert(!hasError(span), "unrelated stream trace error");
  const tags = values(span.tags ?? []);
  if (
    service === "antnest-runtime" &&
    tags["http.transport.outcome"] === "canceled"
  ) {
    recordRead(completedRead(trace, span));
    return;
  }
  // These existing non-error producer records remain raw observations, never
  // error claims. Preserve their exact shape instead of inventing a failure.
  if (
    service === "agent-acp-service" &&
    (span.operationName === "mcp.runtime.info.read" ||
      tags["antnest.outcome"] === "cancelled")
  ) {
    const read =
      span.operationName === "mcp.runtime.info.read"
        ? span
        : traceTopology(trace).parent(span);
    const proof = inspectRuntimeInformationRead(trace, read);
    recordRead(proof);
    recordRead(completedRead(trace, proof.resource.server));
    assert(proof.spans.includes(span), "foreign completed-read diagnostic");
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
  for (const log of span.logs ?? []) {
    if (log === validatedTermination) continue;
    for (const field of log.fields ?? [])
      assert(
        (!errorKey.test(field.key) ||
          (field.key === "error.type" && field.value === "")) &&
          field.value !== "antnest.error" &&
          !(
            field.key === "event" &&
            field.value === "antnest.stream.termination"
          ),
        "unrelated successful span event",
      );
  }
}
const error = { error: true, "otel.status_code": "ERROR" };
const operationMessage =
  "Operation failed; unclassified error text was not exported";
export const tokenRead =
  "SELECT t.id, t.expires_at, t.idle_expires_at, u.id, m.organization_id, m.id, u.system_role, m.role, u.active, m.active, o.active, o.slug, o.name FROM api_tokens t JOIN users u ON u.id = t.user_id JOIN organization_memberships m ON m.id = t.membership_id AND m.organization_id = t.organization_id AND m.user_id = u.id JOIN organizations o ON o.id = t.organization_id WHERE t.token_hash = $1 AND t.kind = 'browser' AND t.revoked_at IS NULL AND t.expires_at > $2 AND t.idle_expires_at > $2 AND m.scim_deleted_at IS NULL";
export function sseDiagnostics(
  root,
  upstream,
  { feedTermination = false } = {},
) {
  let causes = '["*errors.errorString"]';
  // The caller must first bind the winning feed event to its original mutation.
  // Preserve the raw error and admit only the exact typed wrapping introduced
  // by that producer; all other callers retain their original diagnostics.
  if (feedTermination) {
    const raw = upstream.logs?.[0]?.fields?.find(
      (field) => field.key === "antnest.error.cause_types",
    )?.value;
    assert(
      [
        causes,
        '["*browserstream.feedTerminationCause","*errors.errorString"]',
      ].includes(raw),
    );
    causes = raw;
  }
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
      "antnest.error.cause_types": causes,
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
  // Docker's process timestamps share the daemon's clock, not the runner's
  // wall clock. The observed state transition supplies the monotonic window.
  assert(old < finished, "unproved normal process termination");
  if (restart) assert(finished < current, "consumer process did not restart");
  else assert.equal(current, old, "drain process replaced");
  return row;
}

export function inspectOutageStreams(
  evidence,
  collection,
  secrets = [],
  { inspectRecovery = inspectRecoveryHTTP } = {},
) {
  const timeObservations = new Map(),
    metadataReads = new Map();
  const recordRead = (proof) => {
    for (const observation of proof.timeObservations)
      timeObservations.set(
        JSON.stringify([
          observation.trace_id,
          observation.read_span_id,
          observation.span_id,
          observation.boundary,
          observation.event_index,
        ]),
        observation,
      );
  };
  const clean = (span, service, trace, validatedTermination) =>
    cleanSpan(
      span,
      service,
      trace,
      validatedTermination,
      recordRead,
      completedRead,
    );
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
  let completeRecovery;
  const recoveryProof = () => {
    // Terminal revocation always uses the complete inspector, never a supplied
    // passed marker. Cache its immutable verdict for other stream witnesses.
    completeRecovery ??= inspectRecoveryHTTP(evidence, collection, secrets);
    assert.equal(
      completeRecovery.status,
      "passed",
      "stream recovery not proved",
    );
    return completeRecovery;
  };
  const rejectionWitness = (
    trace,
    tree,
    root,
    upstream,
    decision,
    interval,
    item,
  ) => {
    assert(item, "unrelated failed revalidation");
    assert.equal(tag(decision, resolvePrefix + "outcome"), "rejected");
    assert.equal(
      tag(decision, resolvePrefix + "source"),
      "rpc",
      "stream rejection needs its actual RPC source",
    );
    assert(
      decision.startTime >= upstream.startTime,
      "initial stream admission was rejected",
    );
    const c = item.mutation,
      principal =
        item.name === "warm"
          ? warmLogin.body.principal
          : c.login.body.principal;
    for (const key of ["organization_id", "user_id", "membership_id"])
      assert(
        principal[key] && principal[key] === c.login.body.principal[key],
        "revocation changed another stream principal",
      );
    assert.equal(item.stream.credential_scope, item.scope);
    const receipt = one(
      recoveryProof().mutations.filter(
        (m) => m.action === c.name && m.trace_id === c.mutation.trace_id,
      ),
      "one complete actual stream revocation required",
    );
    const mutation = get(receipt.trace_id),
      mutationTree = traceTopology(mutation),
      mutationServer = mutationTree.spans.get(receipt.identity_server_span_id),
      transaction = mutationTree.spans.get(receipt.transaction_span_id);
    assert(mutationServer && transaction, "stream mutation source missing");
    assert.equal(mutationTree.service(mutationServer), "identity-service");
    assert.equal(mutationTree.parent(transaction), mutationServer);
    assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
    const commit = one(
      mutation.spans.filter(
        (s) =>
          mutationTree.parent(s) === transaction &&
          tag(s, "db.query.text")?.trim().toLowerCase() === "commit",
      ),
      "actual revocation COMMIT missing",
    );
    const client = one(
      trace.spans.filter(
        (s) =>
          tree.parent(s) === root &&
          tree.service(s) === "edge-gateway" &&
          tag(s, "span.kind") === "client" &&
          s.operationName === "HTTP POST identity-service" &&
          s.startTime >= decision.startTime &&
          end(s) <= end(decision),
      ),
      "one terminal Resolve CLIENT required",
    );
    const server = one(
      trace.spans.filter(
        (s) =>
          tree.parent(s) === client &&
          tree.service(s) === "identity-service" &&
          tag(s, "span.kind") === "server",
      ),
      "one terminal Resolve SERVER required",
    );
    const sql = one(
      databaseChildrenTopology(trace, server),
      "one terminal token SELECT required",
    );
    assert.equal(tree.parent(sql), server);
    assert.equal(sql.processID, server.processID);
    assert.equal(
      tag(sql, "db.query.text").replace(/\s+/gu, " ").trim(),
      tokenRead,
    );
    assert.equal(
      tag(sql, "pgx.rows_affected"),
      0,
      "terminal Resolve still read browser authority",
    );
    assert(
      sql.startTime >= server.startTime && end(sql) <= end(server),
      "terminal SELECT outside Identity receiver",
    );
    clean(sql, tree.service(sql), trace);
    const instance = (source, span) => {
      const resource = values(source.processes[span.processID].tags ?? []);
      for (const key of ["service.instance.id", "host.name"])
        assert(
          typeof resource[key] === "string" && resource[key],
          `missing Identity ${key}`,
        );
      assert(
        Number.isSafeInteger(resource["process.pid"]) &&
          resource["process.pid"] > 0,
        "missing Identity PID",
      );
      return Object.fromEntries(
        ["service.instance.id", "host.name", "process.pid"].map((key) => [
          key,
          resource[key],
        ]),
      );
    };
    const identityProcess = instance(trace, server);
    assert.deepEqual(
      identityProcess,
      instance(mutation, mutationServer),
      "revocation and denial belong to different Identity processes",
    );
    assert(
      end(commit) <= sql.startTime,
      "terminal SELECT preceded committed revocation",
    );
    diagnostics(decision, {
      ...error,
      "otel.status_description": "rejected",
      [resolvePrefix + "outcome"]: "rejected",
    });
    diagnostics(client, {
      ...error,
      "error.type": "401",
      "otel.status_description": "HTTP status 401",
    });
    const identityError = {
      "antnest.error.cause_types": '["*domain.Error"]',
      "antnest.error.code": "unauthenticated",
      "antnest.error.message": "Authentication failed",
      "antnest.error.stage": "protocol",
      "antnest.error.type": "unauthenticated",
      "error.type": "unauthenticated",
    };
    diagnostics(
      server,
      {
        ...identityError,
        "antnest.outcome": "rejected",
        "antnest.result": "rejected",
      },
      identityError,
    );
    return {
      spans: new Set([decision, client, server]),
      // Identity has its own clock. Its sole qualified receiver is already
      // bounded by same-process COMMIT/SELECT order; only Gateway uses Date.
      inWindow: (span) =>
        span === server ||
        ([decision, client].includes(span) &&
          span.startTime >= interval.lower(c.mutation.started_at) &&
          end(span) < interval.upper(item.stream.closure.at)),
      evidence: {
        mutation_trace_id: receipt.trace_id,
        transaction_span_id: transaction.spanID,
        commit_span_id: commit.spanID,
        token_read_span_id: sql.spanID,
        identity_process: identityProcess,
      },
    };
  };
  const boundary = (id, row, receivedAt, item) => {
    const trace = get(id),
      tree = traceTopology(trace),
      method = row.method ?? "GET",
      status = row.status;
    const root = one(
      trace.spans.filter((s) => !tree.parent(s)),
      "one actual stream/view root required",
    );
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tag(root, "span.kind"), "server");
    assert.equal(tag(root, "http.request.method"), method);
    assert.equal(tag(root, "http.route"), "/api/app/workspace/v1/{path...}");
    assert.equal(tag(root, "http.response.status_code"), status);
    const ui = one(
      trace.spans.filter(
        (s) =>
          tree.service(s) === "agent-ui" && tag(s, "span.kind") === "server",
      ),
      "one actual Agent UI receiver required",
    );
    assert.equal(ui.operationName, "agent_ui.http.request");
    assert.equal(tag(ui, "http.route"), "/api/app/workspace/v1/*");
    assert.equal(tag(ui, "http.request.method"), method);
    assert.equal(tag(ui, "http.response.status_code"), status);
    const upstream = tree.parent(ui);
    assert.equal(tree.service(upstream), "edge-gateway");
    assert.equal(tree.parent(upstream), root);
    assert.equal(tag(upstream, "span.kind"), "client");
    assert.equal(upstream.operationName, `HTTP ${method} agent-ui`);
    assert.equal(tag(upstream, "http.request.method"), method);
    assert.equal(tag(upstream, "server.address"), "agent-ui");
    assert.equal(tag(upstream, "http.response.status_code"), status);
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
    const failed = decisions.filter(
      (s) => tag(s, resolvePrefix + "outcome") !== "admitted",
    );
    const rejection = failed.length
      ? rejectionWitness(
          trace,
          tree,
          root,
          upstream,
          one(failed, "one terminal stream revalidation failure required"),
          interval,
          item,
        )
      : undefined;
    const { allowedErrors, ...resolution } = inspectWatchResolutions(
      trace,
      root,
      upstream,
      { traceID: id, resolveTTLMS: 10000, revoked: Boolean(rejection) },
      collection,
      rejection?.inWindow ?? (() => false),
    );
    assert.deepEqual(
      allowedErrors,
      rejection?.spans ?? new Set(),
      "unrelated stream Resolve error claim",
    );
    if (rejection) {
      resolution.terminal_rejection = rejection.evidence;
      for (const span of allowedErrors)
        claim(trace, span, "public-sse-revoked-resolve");
    }
    for (const record of [
      resolution.gateway_resolution,
      ...resolution.gateway_revalidations,
    ]) {
      if (!record.rpc_client_span_id) continue;
      if (record.outcome === "rejected") continue;
      const source = get(record.source_trace_id),
        sourceTree = traceTopology(source);
      const client = sourceTree.spans.get(record.rpc_client_span_id),
        server = sourceTree.spans.get(record.identity_server_span_id);
      for (const span of [
        client,
        server,
        ...databaseChildrenTopology(source, server),
      ])
        clean(span, sourceTree.service(span), source);
    }
    return {
      trace,
      tree,
      root,
      upstream,
      ui,
      interval,
      resolution,
      allowedErrors,
    };
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
  const ownerInventory = inspectOutageOwnerInventory(evidence, collection);
  function completedRead(trace, server) {
    const tree = traceTopology(trace),
      proof = inspectRuntimeInformationRead(
        trace,
        tree.parent(tree.parent(server)),
      );
    const method = tag(proof.request, "rpc.method"),
      creation = method === "session/new";
    if (!["session/load", "session/new"].includes(method))
      return completedInitializeRead(trace, server);
    const origin = one(
        ownerInventory.http_origins.filter(
          (row) =>
            row.trace_id === trace.traceID &&
            row.kind === (creation ? "session-create" : "view"),
        ),
        "original load view missing",
      ),
      row = one(
        evidence.http.filter((row) => row.trace_id === trace.traceID),
        "original view response missing",
      ),
      login = one(
        evidence.http.filter(
          (login) =>
            login.issued_credential_scope &&
            login.issued_credential_scope === row.credential_scope,
        ),
        "original view login missing",
      );
    assert.equal(row.method, creation ? "POST" : "GET");
    assert.equal(row.status, creation ? 201 : 200);
    if (!creation) assert.equal(row.body?.agentId, evidence.agent_id);
    assert(
      typeof row.body.sessionId === "string" && row.body.sessionId,
      "original view Session missing",
    );
    const base = `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}`;
    assert(
      (creation
        ? [`${base}/sessions`]
        : [
            `${base}/view`,
            `${base}/sessions/${encodeURIComponent(row.body.sessionId)}/view`,
          ]
      ).includes(row.path),
      "foreign load view path",
    );
    const scope = {
      agent_id: evidence.agent_id,
      session_id: row.body.sessionId,
      ui_span_id: origin.ui_span_id,
      credential_scope: row.credential_scope,
      principal: Object.fromEntries(
        ["user_id", "membership_id", "organization_id"].map((key) => [
          key,
          login.body.principal[key],
        ]),
      ),
    };
    const bound = (
      creation ? completedSessionNewRead : completedSessionLoadRead
    )(trace, server, scope);
    metadataReads.set(`${trace.traceID}:${proof.read.spanID}`, {
      trace_id: trace.traceID,
      read_span_id: proof.read.spanID,
      server_span_id: server.spanID,
      request_span_id: bound.request.spanID,
      receiver_span_id: bound.receiver.spanID,
      ...scope,
    });
    return bound;
  }
  // Each service/generation has its own clock. SERVER start is inside the
  // observed complete HTTP request window; SERVER finish is not necessarily
  // before the client has received the body. The 1ms bound is the Node SDK's
  // start-anchor quantization, not a tolerance for other clocks or errors.
  const serviceClocks = new Map(),
    quantizationUS = 1000;
  const resource = (trace, span) => {
    const process = trace.processes[span.processID],
      tags = values(process.tags ?? []);
    return [
      process.serviceName,
      tags["host.name"],
      tags["process.pid"],
      tags["service.instance.id"] ?? null,
    ];
  };
  const sample = (service, generation, trace, span, row) => {
    const identity = resource(trace, span),
      key = `${service}:${generation}`;
    assert.equal(identity[0], service);
    assert(!hasError(span), "failed service clock source");
    end(span);
    finite(row.started_at);
    finite(row.at);
    assert(row.started_at <= row.at);
    const clock = serviceClocks.get(key) ?? {
      service,
      generation,
      resource: identity,
      node_sdk_quantization_us: quantizationUS,
      offset_min_us: -Infinity,
      offset_max_us: Infinity,
      samples: [],
    };
    assert.deepEqual(
      clock.resource,
      identity,
      "clock source belongs to another service process",
    );
    clock.offset_min_us = Math.max(
      clock.offset_min_us,
      span.startTime - row.at * 1000,
    );
    clock.offset_max_us = Math.min(
      clock.offset_max_us,
      span.startTime - row.started_at * 1000 + quantizationUS,
    );
    assert(
      clock.offset_min_us <= clock.offset_max_us,
      "independent service clock windows do not intersect",
    );
    clock.samples.push({
      trace_id: trace.traceID,
      span_id: span.spanID,
      started_at: row.started_at,
      received_at: row.at,
    });
    serviceClocks.set(key, clock);
  };
  for (const origin of ownerInventory.http_origins) {
    const trace = get(origin.trace_id),
      row = one(
        evidence.http.filter((r) => r.trace_id === origin.trace_id),
        "clock HTTP source missing",
      );
    sample(
      "agent-ui",
      origin.generation,
      trace,
      trace.spans.find((s) => s.spanID === origin.ui_span_id),
      row,
    );
  }
  for (const owner of ownerInventory.owners) {
    const trace = get(owner.origin_trace_id),
      row = one(
        evidence.http.filter((r) => r.trace_id === owner.origin_trace_id),
        "initialization HTTP source missing",
      );
    assert(
      owner.generation === 0
        ? row.at <= acp.before.at
        : row.started_at >= acp.after.at,
      "initialization crosses observed ACP generation",
    );
    sample(
      "agent-acp-service",
      owner.generation,
      trace,
      trace.spans.find((s) => s.spanID === owner.initialization_span_id),
      row,
    );
  }
  // Session views await authorizeExecution -> readExecution and its complete
  // response before returning 200. These unary SERVER starts provide further
  // independent windows; asynchronous GET/watch starts are never clock samples.
  for (const origin of ownerInventory.http_origins) {
    const row = one(
      evidence.http.filter((r) => r.trace_id === origin.trace_id),
      "execution clock HTTP source missing",
    );
    if (
      origin.kind !== "view" ||
      !row.path.startsWith(`${base}/sessions/`) ||
      !row.path.endsWith("/view")
    )
      continue;
    const trace = get(origin.trace_id),
      tree = traceTopology(trace),
      uiSpan = tree.spans.get(origin.ui_span_id);
    for (const span of trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" &&
        tag(s, "rpc.method") === "read_workspace_execution",
    )) {
      assert.equal(span.operationName, "HTTP GET unmatched");
      assert.deepEqual(
        span.references,
        [
          {
            refType: "CHILD_OF",
            traceID: trace.traceID,
            spanID: uiSpan.spanID,
          },
        ],
        "execution clock needs its actual HTTP parent",
      );
      for (const [key, value] of Object.entries({
        "span.kind": "server",
        "http.request.method": "GET",
        "http.route": "unmatched",
        "http.response.status_code": 200,
        "antnest.listener": "workspace",
        "rpc.service": "agent-acp",
        "rpc.system.name": "json-over-http",
      }))
        assert.equal(tag(span, key), value, `execution clock ${key} differs`);
      clean(span, "agent-acp-service", trace);
      assert(
        origin.generation === 0
          ? row.at <= acp.before.at
          : row.started_at >= acp.after.at,
        "execution read crosses observed ACP generation",
      );
      sample("agent-acp-service", origin.generation, trace, span, row);
    }
  }
  if (evidence.policy_revision === 4 || evidence.acp_clock_probe) {
    const clock = serviceClocks.get("agent-acp-service:0");
    const proof = inspectOutageACPClock(evidence, collection, clock);
    clock.offset_min_us = proof.offset_min_us;
    clock.offset_max_us = proof.offset_max_us;
    clock.outage_probe = proof;
    clock.samples.push({
      trace_id: proof.source_trace_id,
      span_id: proof.source_span_id,
      started_at: proof.started_at,
      received_at: proof.received_at,
    });
  }
  const serviceTime = (trace, span, generation, time = end(span)) => {
    const identity = resource(trace, span),
      clock = serviceClocks.get(`${identity[0]}:${generation}`);
    assert(clock, "independent service clock missing");
    assert.deepEqual(
      clock.resource,
      identity,
      "span belongs to another calibrated process",
    );
    finite(time);
    end(span);
    return {
      lower: (time - clock.offset_max_us) / 1000,
      upper: (time + quantizationUS - clock.offset_min_us) / 1000,
    };
  };
  let offboarding;
  const offboardingCase = () => {
    if (offboarding) return offboarding;
    // Reuse the complete recovery gate: real HTTP responses, committed Identity
    // mutation/SQL/feed evidence, cancellation and the disabled Agent readback.
    // A close marker alone cannot establish that offboarding actually happened.
    const proof =
      inspectRecovery === inspectRecoveryHTTP
        ? recoveryProof()
        : inspectRecovery(evidence, collection, secrets);
    assert.equal(proof.status, "passed", "offboarding recovery not proved");
    const receipt = one(
      proof.mutations.filter((m) => m.action === "deactivate"),
      "one actual offboarding mutation required",
    );
    const c = cases[3];
    assert.equal(receipt.trace_id, c.mutation.trace_id);
    const trace = get(receipt.trace_id),
      tree = traceTopology(trace),
      server = tree.spans.get(receipt.identity_server_span_id),
      transaction = tree.spans.get(receipt.transaction_span_id);
    assert(server && transaction, "offboarding receipt source missing");
    assert.equal(tree.service(server), "identity-service");
    assert.equal(tag(server, "span.kind"), "server");
    assert.equal(tag(server, "http.route"), "/rpc/identity/update-membership");
    assert.equal(tag(server, "rpc.method"), "update_membership");
    assert.equal(tag(server, "http.response.status_code"), 200);
    assert.equal(tree.parent(transaction), server);
    assert.equal(tree.service(transaction), "identity-service");
    assert.equal(transaction.operationName, "postgresql transaction");
    assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
    const principal = c.login.body.principal,
      member = c.mutation.body.membership,
      disabled = c.disabled_agent;
    assert.equal(member.id, principal.membership_id);
    assert.equal(member.user_id, principal.user_id);
    assert.equal(member.active, false);
    sameHTTP(disabled);
    assert.equal(
      disabled.path,
      `/api/admin/agents/${encodeURIComponent(evidence.agent_id)}`,
    );
    assert.equal(disabled.method, "GET");
    assert.equal(disabled.status, 200);
    for (const [key, value] of Object.entries({
      agent_id: evidence.agent_id,
      owner_user_id: principal.user_id,
      desired_state: "disabled",
      lifecycle_state: "created",
      activation_state: "disabled",
      runtime_state: "absent",
    }))
      assert.equal(disabled.body[key], value);
    [disabled.started_at, disabled.at].forEach(finite);
    assert(
      disabled.started_at >= c.mutation.at &&
        disabled.at >= disabled.started_at &&
        disabled.at < drain.started_at,
      "disabled readback outside actual offboarding",
    );
    offboarding = c;
    return c;
  };
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
    const b = boundary(s.trace_id, s, s.headers_at, item);
    if (end(b.root) - b.root.startTime > evidence.settings.resolveTTLMS * 1000)
      assert(
        b.resolution.gateway_revalidations.length > 0,
        "long stream lacks actual successful revalidation",
      );
    for (const span of [b.root, b.upstream])
      assert(
        end(span) >= b.interval.lower(c.trigger.at) &&
          end(span) < b.interval.upper(closure.at),
        "stream span ended outside actual closure interval",
      );
    const uiEnd = serviceTime(b.trace, b.ui, 1);
    // The remote EOF is the observed closure. Reject an incompatible UI span
    // using its independent clock; never compare its wall time to Gateway Date.
    assert(
      uiEnd.upper >= c.trigger.at &&
        uiEnd.lower < closure.at &&
        uiEnd.upper < drain.after.at,
      "UI stream span ended outside actual closure interval",
    );
    const failedTransport = hasError(b.root) || hasError(b.upstream);
    let feedWitness, feedTermination;
    if (
      (b.root.logs ?? []).some((event) =>
        event.fields?.some(
          (field) =>
            field.key === "event" &&
            field.value === "antnest.stream.termination",
        ),
      )
    ) {
      const receipt = one(
        recoveryProof().mutations.filter(
          (mutation) =>
            mutation.action === c.name &&
            mutation.trace_id === c.mutation.trace_id,
        ),
        "one complete original feed mutation required",
      );
      const source = get(receipt.trace_id),
        sourceTree = traceTopology(source);
      const mutationRoot = one(
        source.spans.filter((span) => !sourceTree.parent(span)),
        "one original mutation Gateway root required",
      );
      assert.equal(sourceTree.service(mutationRoot), "edge-gateway");
      assert.equal(tag(mutationRoot, "span.kind"), "server");
      const gateway = resource(b.trace, b.root),
        mutationGateway = resource(source, mutationRoot);
      for (const identity of [gateway, mutationGateway]) {
        assert.equal(identity[0], "edge-gateway");
        assert(typeof identity[1] === "string" && identity[1]);
        assert(Number.isSafeInteger(identity[2]) && identity[2] > 0);
        assert(typeof identity[3] === "string" && identity[3]);
      }
      assert.deepEqual(
        gateway,
        mutationGateway,
        "feed source belongs to another Gateway process",
      );
      // The SSE Date is proxied from UI. Anchor this comparison in the same
      // Gateway process using original request dispatch and header receipts.
      const lower = (at) => b.root.startTime + (at - s.headers_at) * 1000;
      const upper = (at) => b.root.startTime + (at - s.started_at) * 1000;
      assert(
        mutationRoot.startTime >= lower(c.mutation.started_at) &&
          end(mutationRoot) <= upper(c.mutation.at),
        "feed mutation outside original HTTP receipt",
      );
      const reason = {
        logout: "session_revoked",
        password: "password_changed",
        role: "role_changed",
        deactivate: "membership_deactivated",
      }[c.name];
      feedWitness = inspectBrowserFeedWitness(b.root, {
        reason,
        sourceTraceID: receipt.trace_id,
        sourceSpanID: receipt.identity_server_span_id,
        principal:
          item.name === "warm"
            ? warmLogin.body.principal
            : c.login.body.principal,
        agentId: evidence.agent_id,
        mutationStart: mutationRoot.startTime,
        lowerBound: lower(c.mutation.started_at),
        upperBound: upper(closure.at),
        transportFailureAt: failedTransport
          ? b.upstream.logs?.[0]?.timestamp
          : undefined,
      });
      assert(feedWitness.event);
      feedTermination = {
        source: "identity-session-feed",
        reason,
        sequence: feedWitness.sequence,
        mutation_trace_id: receipt.trace_id,
        identity_server_span_id: feedWitness.sourceSpanID,
      };
    }
    const hasTermination = (b.ui.logs ?? []).some((log) =>
      (log.fields ?? []).some(
        (field) =>
          field.key === "event" && field.value === "antnest.stream.termination",
      ),
    );
    let marker, termination;
    if (!failedTransport)
      assert.equal(
        closure.kind,
        "remote-end",
        "normal stream requires actual EOF",
      );
    // UI EOF and Gateway revocation can race across processes. Validate any
    // direct witness independently; a Gateway error still needs its exact
    // diagnostics, and a normal public EOF cannot pass without a witness.
    if (!failedTransport || hasTermination) {
      const offboarded = offboardingCase();
      assert.equal(
        c.mutation.trace_id,
        offboarded.mutation.trace_id,
        "normal close lacks its actual offboarding mutation",
      );
      for (const key of ["user_id", "membership_id", "organization_id"])
        assert.equal(
          c.login.body.principal[key],
          offboarded.login.body.principal[key],
          "normal close belongs to another principal",
        );
      marker = one(
        b.ui.logs ?? [],
        "one direct UI termination witness required",
      );
      assert.deepEqual(values(marker.fields ?? []), {
        event: "antnest.stream.termination",
        reason: "access_denied",
        source: "agent-execution-state",
        "antnest.organization.id":
          offboarded.login.body.principal.organization_id,
        "antnest.principal.id": offboarded.login.body.principal.user_id,
        "antnest.agent.id": evidence.agent_id,
      });
      finite(marker.timestamp);
      assert(
        marker.timestamp >= b.ui.startTime && marker.timestamp <= end(b.ui),
        "UI termination witness outside owning span",
      );
      const markerTime = serviceTime(b.trace, b.ui, 1, marker.timestamp);
      assert(
        markerTime.upper >= c.mutation.started_at &&
          markerTime.lower < closure.at,
        "UI termination witness outside actual mutation/closure window",
      );
      termination = {
        reason: "access_denied",
        source: "agent-execution-state",
        span_id: b.ui.spanID,
      };
    }
    if (failedTransport) {
      sseDiagnostics(feedWitness?.root ?? b.root, b.upstream, {
        feedTermination: Boolean(feedWitness?.event),
      });
      claim(b.trace, b.root, "public-sse-revoked-handler");
      claim(b.trace, b.upstream, "public-sse-revoked-response");
    }
    for (const span of b.trace.spans)
      if (
        !b.allowedErrors.has(span) &&
        (!failedTransport || (span !== b.root && span !== b.upstream))
      )
        clean(
          span === b.root && feedWitness ? feedWitness.root : span,
          b.tree.service(span),
          b.trace,
          span === b.ui ? marker : undefined,
        );
    return {
      name: item.name,
      trace_id: s.trace_id,
      ...b.resolution,
      ...(termination ? { termination } : {}),
      ...(feedTermination ? { feed_termination: feedTermination } : {}),
    };
  });
  const closePrefix = "antnest.ui.acp.close.";
  const ownerCloses = ownerInventory.owners.map((owner) => {
    const trace = get(owner.close_trace_id),
      tree = traceTopology(trace),
      span = tree.spans.get(owner.close_span_id),
      tags = values(span.tags ?? []),
      trigger = tags[closePrefix + "trigger"],
      outcome = tags[closePrefix + "outcome"];
    assert(
      ["requested", "transport_failure"].includes(trigger),
      "unobserved close trigger",
    );
    assert(
      ["closed", "failed"].includes(outcome),
      "unproved owner close outcome",
    );
    const failed = outcome === "failed",
      receipt = {
        trigger,
        outcome,
        target_observed: true,
        delete_attempts: 1,
        delete_responses: failed ? 0 : 1,
        delete_completed: failed ? 0 : 1,
        delete_status: failed ? 0 : 202,
        pending_requests: 0,
        stream_joined: true,
        failures: failed ? 1 : 0,
        diagnostics_truncated: false,
      };
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(tags)
          .filter(([k]) => k.startsWith(closePrefix))
          .map(([k, v]) => [k.slice(closePrefix.length), v]),
      ),
      receipt,
      "incomplete or contradictory owner close receipt",
    );
    const expected = Object.fromEntries(
      Object.entries(receipt).map(([k, v]) => [closePrefix + k, v]),
    );
    const receivers = cleanupInventory([trace], "delete")
      .filter((r) => tree.parent(r.span) === span)
      .map((r) => r.span);
    assert.equal(
      receivers.length,
      failed ? 0 : 1,
      "close receipt differs from actual DELETE inventory",
    );
    if (failed) {
      assert.equal(trigger, "transport_failure");
      const event = one(
          span.logs ?? [],
          "one exact close failure event required",
        ),
        causes = values(event.fields ?? []).causes;
      assert(typeof causes === "string");
      assert.match(
        causes,
        /^\[(?:"unknown",)?"(?:connection_refused|connection_reset|broken_pipe|socket_closed)"\]$/u,
        "unproved stopped-peer close cause",
      );
      diagnostics(
        span,
        { ...expected, ...error },
        {
          event: "antnest.ui.acp.close.failure",
          stage: "delete_request",
          causes,
          truncated: false,
        },
      );
    } else {
      assert(!hasError(span), "successful close retains an unrelated error");
      diagnostics(span, expected);
      const receiver = receivers[0];
      assert.equal(receiver.operationName, "HTTP DELETE /v1/acp");
      for (const [k, v] of Object.entries({
        "span.kind": "server",
        "http.request.method": "DELETE",
        "http.route": "/v1/acp",
        "http.response.status_code": 202,
        "antnest.listener": "workspace",
      }))
        assert.equal(tag(receiver, k), v, `wrong close receiver ${k}`);
    }
    for (const other of trace.spans) {
      if (other === span) continue;
      let parent = tree.parent(other);
      while (parent && parent !== span) parent = tree.parent(parent);
      assert.equal(parent, span, "unrelated span in owner close trace");
      clean(other, tree.service(other), trace);
    }
    return {
      trace_id: trace.traceID,
      span_id: span.spanID,
      origin_trace_id: owner.origin_trace_id,
      reason: failed ? "failed-acp-process-exit" : "complete-delete-202",
      delete_span_id: receivers[0]?.spanID,
    };
  });
  const requiredViews = [
    {
      row: byLabel("prep-view"),
      scope: prepScope,
      session: evidence.session_id,
      lifecycle: acp,
      prep: true,
      principal: prepLogin.body.principal,
    },
    ...["warm-workspace-view", "recovered-workspace-view"].map((label) => ({
      row: byLabel(label),
      scope: warmScope,
      session: evidence.session_id,
      lifecycle: drain,
      principal: warmLogin.body.principal,
    })),
    ...cases.map((c, i) => ({
      row: c.initial_view,
      scope: scopes[i],
      session: c.session_id,
      lifecycle: drain,
      principal: c.login.body.principal,
    })),
  ];
  for (const v of requiredViews) {
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
    assert(
      ownerInventory.http_origins.some((r) => r.trace_id === row.trace_id),
      "required view has no actual UI generation witness",
    );
  }
  const views = ownerInventory.http_origins.map((origin) => {
    const row = one(
        evidence.http.filter((r) => r.trace_id === origin.trace_id),
        "actual owner HTTP observation missing",
      ),
      login = one(
        evidence.http.filter(
          (r) =>
            r.issued_credential_scope &&
            r.issued_credential_scope === row.credential_scope,
        ),
        "actual owner HTTP login missing",
      );
    return {
      row,
      principal: login.body.principal,
      prep: origin.generation === 0,
      lifecycle: origin.generation === 0 ? acp : drain,
      kind: origin.kind,
    };
  });
  assert.equal(
    new Set([
      ...views.map((v) => v.row.trace_id),
      ...streamItems.map((v) => v.stream.trace_id),
    ]).size,
    views.length + streams.length,
    "reused stream/view receipt",
  );
  const privateReceipts = new Map(
    ownerInventory.owners.flatMap((owner) =>
      owner.streams.map((row) => [
        `${row.trace_id}:${row.span_id}`,
        { ...row, owner },
      ]),
    ),
  );
  const watches = [];
  for (const v of views) {
    const row = v.row;
    const b = boundary(row.trace_id, row, row.at);
    if (v.kind === "restored-denial") {
      // Structural mapping alone cannot admit a 403. Require the complete
      // deactivation/restoration business, transaction and denial evidence.
      recoveryProof();
      diagnostics(b.upstream, {
        ...error,
        "error.type": "403",
        "otel.status_description": "HTTP status 403",
      });
      claim(b.trace, b.upstream, "restored-disabled-agent-view");
    }
    for (const span of b.trace.spans) {
      if (v.kind === "restored-denial" && span === b.upstream) continue;
      const receipt = privateReceipts.get(`${b.trace.traceID}:${span.spanID}`);
      if (!receipt) {
        clean(span, b.tree.service(span), b.trace);
        continue;
      }
      const privateEnd = serviceTime(b.trace, span, receipt.owner.generation),
        initialTrace = get(receipt.owner.origin_trace_id),
        initial = initialTrace.spans.find(
          (s) => s.spanID === receipt.owner.initialization_span_id,
        );
      assert(
        span.startTime >= initial.startTime &&
          span.startTime < end(span) &&
          privateEnd.upper <= v.lifecycle.after.at,
        "private stream outside observed owning lifecycle",
      );
      if (!hasError(span)) {
        clean(span, b.tree.service(span), b.trace);
        watches.push({
          trace_id: b.trace.traceID,
          span_id: span.spanID,
          reason:
            receipt.kind === "execution-watch"
              ? "internal-completed-execution-watch"
              : "internal-completed-private-stream",
        });
        continue;
      }
      assert.equal(b.tree.parent(span), b.ui, "watch not owned by actual view");
      assert.equal(tag(span, "span.kind"), "server");
      assert.equal(tag(span, "http.response.status_code"), 200);
      let reason;
      const normalTermination = () =>
        assert(
          privateEnd.lower >= v.lifecycle.started_at,
          "watch before actual normal termination without close witness",
        );
      if (tag(span, "http.route") === "/v1/acp") {
        assert.equal(span.operationName, "HTTP GET /v1/acp");
        assert.equal(tag(span, "http.request.method"), "GET");
        for (const key of ["rpc.method", "rpc.service", "rpc.system.name"])
          assert.equal(tag(span, key), undefined);
        const expected = {
          ...error,
          "error.type": "stream_interrupted",
          "antnest.outcome": "disconnected",
        };
        const marker = (span.logs ?? []).find((log) =>
          log.fields?.some(
            (f) =>
              f.key === "event" && f.value === "antnest.stream.termination",
          ),
        );
        if (marker) {
          assert(!v.prep, "preparation watch cannot claim later offboarding");
          const c = offboardingCase(),
            source = values(marker.fields).source;
          assert(
            ["session-output", "learning-notice", "permission"].includes(
              source,
            ),
            "unknown access-denial close source",
          );
          for (const key of ["user_id", "membership_id", "organization_id"]) {
            assert(
              c.login.body.principal[key],
              "offboarding principal missing",
            );
            assert.equal(
              v.principal?.[key],
              c.login.body.principal[key],
              "watch belongs to another offboarded principal",
            );
          }
          diagnostics(span, expected, {
            event: "antnest.stream.termination",
            reason: "access_denied",
            "error.type": "DomainError",
            source,
            "antnest.agent.id": evidence.agent_id,
            "antnest.organization.id": v.principal.organization_id,
          });
          assert(
            serviceTime(
              b.trace,
              span,
              receipt.owner.generation,
              marker.timestamp,
            ).lower >= c.mutation.started_at,
            "access-denial close before actual offboarding mutation",
          );
          reason = "internal-offboarding-access-denied";
        } else {
          normalTermination();
          diagnostics(span, expected);
          reason = v.prep
            ? "internal-acp-restart-disconnect"
            : "internal-ui-drain-disconnect";
        }
      } else {
        normalTermination();
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
    watches.some((w) =>
      [
        "internal-ui-drain-disconnect",
        "internal-offboarding-access-denied",
      ].includes(w.reason),
    ),
    "actual post-restart watch close missing",
  );
  assert(
    watches.some((w) => w.reason === "internal-acp-normal-shutdown"),
    "marked normal shutdown watch missing",
  );
  const watchByID = new Map(
    watches.map((w) => [`${w.trace_id}:${w.span_id}`, w]),
  );
  for (const [index, owner] of ownerInventory.owners.entries()) {
    const receipt = ownerCloses[index],
      trace = get(receipt.trace_id),
      span = trace.spans.find((s) => s.spanID === receipt.span_id),
      closeStart = serviceTime(trace, span, owner.generation, span.startTime),
      closeEnd = serviceTime(trace, span, owner.generation),
      actualWatches = owner.streams.map((r) =>
        watchByID.get(`${r.trace_id}:${r.span_id}`),
      );
    assert(
      actualWatches.every(Boolean),
      "owner close has unvalidated private stream",
    );
    if (receipt.reason === "failed-acp-process-exit") {
      assert.equal(
        owner.generation,
        0,
        "failed close belongs to another ACP generation",
      );
      assert(
        actualWatches.some((w) => w.reason === "internal-acp-normal-shutdown"),
        "failed close lacks its own process-shutdown watch",
      );
      assert(
        closeStart.lower >= acp.started_at && closeEnd.upper <= ui.before.at,
        "failed close outside old ACP/UI lifecycle",
      );
      claim(trace, span, receipt.reason);
    } else {
      const lower =
        owner.generation === 0
          ? acp.started_at
          : actualWatches.some(
                (w) => w.reason === "internal-ui-drain-disconnect",
              )
            ? drain.started_at
            : offboardingCase().mutation.started_at;
      assert(
        closeStart.lower >= lower &&
          closeEnd.upper <=
            (owner.generation === 0 ? ui.before.at : drain.after.at),
        "complete close outside observed UI lifecycle",
      );
      const deletion = trace.spans.find(
        (s) => s.spanID === receipt.delete_span_id,
      );
      const deleteStart = serviceTime(
          trace,
          deletion,
          owner.generation,
          deletion.startTime,
        ),
        deleteEnd = serviceTime(trace, deletion, owner.generation);
      assert(
        deleteStart.lower >= lower &&
          deleteEnd.upper <=
            (owner.generation === 0 ? acp.after.at : drain.after.at),
        "DELETE outside observed owning lifecycle",
      );
      // The real parent edge and completed-body receipt establish causality.
      // Independent clock intervals must also permit that ordering; do not
      // equate UI and ACP timestamps to manufacture exact containment.
      assert(
        deleteStart.upper >= closeStart.lower &&
          deleteEnd.lower <= closeEnd.upper,
        "DELETE incompatible with its actual UI close",
      );
      receipt.delete_observed_start = deleteStart;
      receipt.delete_observed_end = deleteEnd;
      for (const row of owner.streams) {
        const source = get(row.trace_id),
          watch = source.spans.find((s) => s.spanID === row.span_id);
        assert(
          end(watch) <= end(deletion),
          "private stream outlived its complete DELETE receiver",
        );
      }
    }
    receipt.observed_start = closeStart;
    receipt.observed_end = closeEnd;
  }
  return {
    status: "passed",
    streams,
    owner_inventory: ownerInventory,
    metadata_read_receipts: [...metadataReads.values()],
    owner_closes: ownerCloses,
    service_clocks: [...serviceClocks.values()],
    internal_watches: watches,
    owned_error_spans: owned,
    ...resolveTraceDiagnostics(first, sources),
    time_observations: [...timeObservations.values()],
  };
}

const resolvePrefix = "antnest.identity.resolve.";
