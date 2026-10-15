import assert from "node:assert/strict";
import { inspectRecoveryWindow } from "./resolve-cache-recovery.mjs";
import { inspectRebuildPreparation } from "./resolve-cache-rebuild-trace.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
} from "../observability/trace-tree.mjs";
import {
  inspectGatewayResolution,
  assertGatewayResolutionAttributes,
} from "../../support/gateway-resolution.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";

const prefix = "antnest.identity.resolve.";
const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const normalize = (text) => text.replace(/\s+/gu, " ").trim();
const end = (span) => span.startTime + span.duration;
const query = (span) => normalize(tag(span, "db.query.text"));
const statements = {
  begin: "begin",
  commit: "commit",
  revoke:
    "UPDATE api_tokens SET revoked_at = $2 WHERE id = ANY($1::text[]) AND kind = 'browser' AND revoked_at IS NULL AND ($3 = '' OR organization_id = $3) AND ($4 = '' OR membership_id = $4) AND id <> $5 RETURNING id, user_id, organization_id",
  password:
    "UPDATE local_credentials SET password_hash = $3, updated_at = $4 WHERE user_id = $1 AND password_hash = $2",
  replacement:
    "INSERT INTO api_tokens (id, token_hash, public_session_id, user_id, organization_id, membership_id, issued_at, last_used_at, expires_at, idle_expires_at, user_agent_hint) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, LEAST($8::timestamptz, $9::timestamptz), $10) RETURNING expires_at, idle_expires_at",
  membership:
    "UPDATE organization_memberships SET email = $3, display_name = $4, role = $5, active = $6, updated_at = $7 WHERE organization_id = $1 AND id = $2",
  audit:
    "INSERT INTO identity_events ( id, organization_id, actor_principal_id, actor_scim_token_id, event_type, subject_type, subject_id, request_id, metadata, created_at ) VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5, $6, $7, NULLIF($8, ''), $9, $10)",
  session:
    "INSERT INTO session_revocations (token_id, user_id, organization_id, reason, occurred_at, traceparent) VALUES ($1, $2, $3, $4, $5, $6)",
  principal:
    "INSERT INTO principal_revocations (user_id, organization_id, reason, occurred_at, traceparent) VALUES ($1, NULLIF($2, ''), $3, $4, $5)",
  sessionLock: "LOCK TABLE session_revocations IN SHARE ROW EXCLUSIVE MODE",
  principalLock: "LOCK TABLE principal_revocations IN SHARE ROW EXCLUSIVE MODE",
  attemptUpsert:
    "INSERT INTO credential_attempts (scope,key_hash,window_start,failures) VALUES ($1,$2,clock_timestamp(),0) ON CONFLICT (scope,key_hash) DO UPDATE SET scope=EXCLUDED.scope RETURNING window_start,failures,locked_until",
  attemptWrite:
    "UPDATE credential_attempts SET window_start=$3,failures=$4,locked_until=$5 WHERE scope=$1 AND key_hash=$2",
};
const tokenRead =
  "SELECT t.id, t.expires_at, t.idle_expires_at, u.id, m.organization_id, m.id, u.system_role, m.role, u.active, m.active, o.active, o.slug, o.name FROM api_tokens t JOIN users u ON u.id = t.user_id JOIN organization_memberships m ON m.id = t.membership_id AND m.organization_id = t.organization_id AND m.user_id = u.id JOIN organizations o ON o.id = t.organization_id WHERE t.token_hash = $1 AND t.kind = 'browser' AND t.revoked_at IS NULL AND t.expires_at > $2 AND t.idle_expires_at > $2 AND m.scim_deleted_at IS NULL";
const credentialRead =
  "SELECT password_hash FROM local_credentials WHERE user_id=$1 FOR UPDATE";
const loginRefusalSQL = [
  statements.begin,
  "SELECT id FROM organizations WHERE slug=$1",
  statements.attemptUpsert,
  "SELECT clock_timestamp()",
  statements.attemptUpsert,
  "SELECT clock_timestamp()",
  "SELECT user_id,id FROM organization_memberships WHERE organization_id=$1 AND email=$2 AND scim_deleted_at IS NULL",
  "SELECT system_role,active FROM users WHERE id=$1 FOR SHARE",
  "SELECT slug,name,active FROM organizations WHERE id=$1 FOR SHARE",
  "SELECT role,active FROM organization_memberships WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND email=$4 AND scim_deleted_at IS NULL FOR SHARE",
  credentialRead,
  "SELECT clock_timestamp()",
  statements.attemptWrite,
  statements.attemptWrite,
  statements.commit,
];
const fields = (row) => {
  const result = Object.fromEntries(row.map((f) => [f.key, f.value]));
  assert.equal(
    Object.keys(result).length,
    row.length,
    "duplicate diagnostic field",
  );
  return result;
};
const rows = (span) => {
  const n = tag(span, "pgx.rows_affected");
  assert(Number.isSafeInteger(n) && n >= 0, "SQL affected-row receipt missing");
  return n;
};

function successful(span, trace, deactivation = false) {
  assert(!hasError(span), "unexpected recovery HTTP error");
  assert(
    !["ERROR", 2].includes(tag(span, "otel.status_code")),
    "failed recovery HTTP span",
  );
  if (tag(span, "http.response.status_code") >= 400) {
    // An idempotent Runtime delete can successfully observe an already absent
    // Docker container. Require the exact completed owning operation, retaining
    // the real 404; this does not admit a failed business HTTP request.
    const tree = traceTopology(trace),
      parent = tree.parent(span);
    assert(deactivation, "failed recovery HTTP status");
    assert.equal(tree.service(span), "runtime-controller");
    assert.equal(span.operationName, "HTTP GET docker");
    assert.equal(tag(span, "span.kind"), "client");
    assert.equal(tag(span, "http.request.method"), "GET");
    assert.equal(tag(span, "http.response.status_code"), 404);
    assert.equal(tag(span, "server.address"), "docker");
    assert.equal(tag(span, "peer.service"), "docker");
    assert.equal(tag(span, "antnest.outcome"), "absent");
    assert.equal(tree.service(parent), "runtime-controller");
    assert.equal(parent.operationName, "runtime.platform.delete");
    for (const [key, value] of Object.entries({
      "span.kind": "internal",
      "antnest.platform": "docker",
      "antnest.platform.operation": "delete",
      "antnest.outcome": "completed",
      "antnest.result": "completed",
    }))
      assert.equal(tag(parent, key), value);
    assert.equal(span.logs?.length ?? 0, 0);
  }
  assert(
    !(span.logs ?? []).some((event) => {
      const f = fields(event.fields ?? []);
      return (
        ["exception", "error", "antnest.error"].includes(f.event) ||
        Object.keys(f).some((key) =>
          /^(exception\.|error\.|antnest\.error\.)/u.test(key),
        )
      );
    }),
    "unexpected recovery HTTP error event",
  );
  const service = trace.processes[span.processID].serviceName;
  if (tag(span, "error.type") !== undefined) {
    // Egress's two successful control calls include an empty error placeholder.
    // Its explicit success receipt is required; no nonempty error is exempt.
    assert.equal(tag(span, "error.type"), "");
    assert.equal(service, "antnest-runtime-egress");
    assert.equal(tag(span, "span.kind"), "server");
    assert.equal(tag(span, "antnest.operation.phase"), "control_http");
    assert.equal(tag(span, "antnest.outcome"), "success");
    assert.equal(tag(span, "http.response.status_code"), 200);
    assert(
      (span.logs ?? []).some((event) => {
        const f = fields(event.fields ?? []);
        return (
          f.event === "antnest.complete" &&
          f["antnest.outcome"] === "success" &&
          f["antnest.response.termination"] === "eof"
        );
      }),
      "missing Egress completion receipt",
    );
  }
  if (tag(span, "antnest.error.code") !== undefined) {
    assert.equal(tag(span, "antnest.error.code"), "");
    assert.equal(service, "runtime-controller");
    assert.equal(span.operationName, "runtime.platform.delete");
    assert.equal(tag(span, "antnest.outcome"), "completed");
    assert.equal(tag(span, "antnest.result"), "completed");
  }
  for (const { key, value } of span.tags ?? []) {
    if (
      /^(error\.|exception\.|antnest\.error\.)/u.test(key) &&
      !["antnest.error.code", "error.type"].includes(key)
    )
      assert(
        key === "antnest.error.class" &&
          value === "none" &&
          service === "runtime-controller",
        "unexpected recovery HTTP error metadata",
      );
  }
}

function rejectionEvent(span, expected) {
  const event = one(span.logs ?? [], "one exact refusal event required");
  assert.deepEqual(fields(event.fields ?? []), {
    event: "antnest.error",
    ...expected,
  });
}

function rejectionTags(span, allowed) {
  for (const [key, value] of Object.entries(fields(span.tags ?? [])))
    if (
      /^(error($|\.)|exception\.|antnest\.error\.|otel\.status_)/u.test(key)
    ) {
      assert(Object.hasOwn(allowed, key), "unrelated refusal error metadata");
      assert.equal(value, allowed[key], "unrelated refusal error metadata");
    }
}

function committedTransaction(trace, tree, server, database) {
  const transaction = one(
    trace.spans.filter(
      (s) =>
        s.operationName === "postgresql transaction" &&
        tree.parent(s) === server,
    ),
    "one owning Identity transaction required",
  );
  assert.equal(tree.service(transaction), "identity-service");
  assert.equal(
    transaction.processID,
    server.processID,
    "foreign transaction process",
  );
  assert.equal(tag(transaction, "span.kind"), "internal");
  assert.equal(tag(transaction, "db.system.name"), "postgresql");
  assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
  successful(transaction, trace);
  assert(
    server.startTime <= transaction.startTime &&
      end(transaction) <= end(server),
    "transaction outside owning Identity response",
  );
  const sql = database
    .filter((s) => tree.parent(s) === transaction)
    .sort((a, b) => a.startTime - b.startTime);
  assert(sql.length >= 2, "committed transaction SQL missing");
  assert.equal(query(sql[0]), statements.begin);
  assert.equal(query(sql.at(-1)), statements.commit);
  let previousEnd = transaction.startTime;
  for (const span of sql) {
    assert.equal(span.processID, server.processID, "foreign SQL process");
    assert(
      previousEnd <= span.startTime && end(span) <= end(transaction),
      "SQL outside serial transaction lifetime",
    );
    previousEnd = end(span);
    successful(span, trace);
  }
  return { transaction, sql };
}

export function inspectLoginRefusalTransaction(trace, server) {
  assert(trace.spans.includes(server), "login SERVER not in raw trace");
  const tree = traceTopology(trace),
    database = databaseChildrenTopology(trace, server);
  const { transaction, sql } = committedTransaction(
    trace,
    tree,
    server,
    database,
  );
  assert.equal(
    sql.length,
    database.length,
    "refusal SQL outside owning transaction",
  );
  assert.deepEqual(
    sql.map(query),
    loginRefusalSQL,
    "wrong committed login refusal SQL",
  );
  for (let n = 0; n < sql.length; n++)
    assert.equal(rows(sql[n]), n === 0 || n === sql.length - 1 ? 0 : 1);
  const credential = one(
    sql.filter((s) => query(s) === credentialRead),
    "one locked refusal credential required",
  );
  return { transaction, sql, credential };
}

// Business receipts establish credential/Principal identity and ordering. This
// gate binds their actual HTTP traces to committed command SQL and exact refusal
// spans. SQL parameters are intentionally absent: row counts do not prove SIDs.
export function inspectRecoveryHTTP(evidence, collection, secrets = []) {
  const preparation =
    evidence.policy_revision === 4 || evidence.recovery_preparation
      ? inspectRebuildPreparation(evidence, collection, secrets)
      : undefined;
  inspectRecoveryWindow(evidence);
  assert.equal(evidence.settings.resolveTTLMS, 10000);
  resolveTraceSources(
    collection.traces.values().next().value,
    secrets,
    collection,
  );
  const selected = [],
    mutations = [],
    rejections = [],
    owned = [];
  const get = (id) => {
    assert(
      collection.archivedTraceIDs.has(id),
      "recovery HTTP Trace not archived",
    );
    const trace = collection.traces.get(id);
    assert(trace, "recovery HTTP Trace missing");
    return trace;
  };
  function raw(row) {
    const trace = get(row.trace_id),
      tree = traceTopology(trace);
    assert(!selected.includes(trace), "reused recovery HTTP Trace");
    selected.push(trace);
    const root = one(
      trace.spans.filter((s) => !tree.parent(s)),
      "one actual Gateway HTTP root required",
    );
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tag(root, "span.kind"), "server");
    assert.equal(
      tag(root, "http.route"),
      row.path.startsWith("/api/admin/") ? "/api/admin/{path...}" : row.path,
    );
    assert.equal(tag(root, "http.request.method"), row.method);
    assert.equal(tag(root, "http.response.status_code"), row.status);
    for (const span of trace.spans)
      assert(
        Number.isFinite(span.startTime) &&
          Number.isFinite(span.duration) &&
          span.duration >= 0,
        "unfinished recovery HTTP span",
      );
    assertGatewayResolutionAttributes(trace);
    return { trace, tree, root };
  }
  function rpc(trace, tree, route, method, caller, parent, status = 200) {
    const server = one(
      trace.spans.filter(
        (s) =>
          tree.service(s) === "identity-service" &&
          tag(s, "span.kind") === "server" &&
          tag(s, "http.route") === `/rpc/identity/${route}`,
      ),
      "one owning Identity command required",
    );
    assert.equal(tag(server, "rpc.method"), method);
    const client = tree.parent(server);
    assert.equal(tree.service(client), caller);
    assert.equal(tree.parent(client), parent);
    assert.equal(tag(client, "span.kind"), "client");
    for (const s of [client, server]) {
      assert.equal(tag(s, "http.request.method"), "POST");
      assert.equal(tag(s, "http.response.status_code"), status);
    }
    return { client, server };
  }
  function mutation(c, row = c.mutation, action = c.name) {
    const { trace, tree, root } = raw(row),
      console = ["role", "deactivate", "restore"].includes(action);
    let parent = root,
      upstream;
    if (console) {
      parent = one(
        trace.spans.filter(
          (s) =>
            tree.service(s) === "admin-console" &&
            tag(s, "span.kind") === "server" &&
            tag(s, "http.route") ===
              "/api/admin/directory/memberships/{membership_id}",
        ),
        "one Console Membership command required",
      );
      upstream = tree.parent(parent);
      assert.equal(tree.service(upstream), "edge-gateway");
      assert.equal(tree.parent(upstream), root);
      assert.equal(tag(upstream, "span.kind"), "client");
      for (const s of [upstream, parent]) {
        assert.equal(tag(s, "http.request.method"), "POST");
        assert.equal(tag(s, "http.response.status_code"), 200);
      }
    }
    const route =
      action === "logout"
        ? "revoke-access-token"
        : action === "password"
          ? "change-local-password"
          : "update-membership";
    const { client, server } = rpc(
      trace,
      tree,
      route,
      route.replaceAll("-", "_"),
      console ? "admin-console" : "edge-gateway",
      parent,
    );
    upstream ??= client;
    const decision = one(
      trace.spans.filter((s) => s.operationName === "gateway.identity.resolve"),
      "one mutation Resolve decision required",
    );
    const resolution = inspectGatewayResolution(
      trace,
      {
        rootSpanID: root.spanID,
        decisionSpanID: decision.spanID,
        upstreamSpanID: upstream.spanID,
        profile: console ? "console" : "session",
        ttlMs: evidence.settings.resolveTTLMS,
      },
      collection,
    );
    if (resolution.rpc_client_span_id) {
      const source = get(resolution.source_trace_id),
        sourceTree = traceTopology(source);
      const receipt = sourceTree.spans.get(resolution.identity_server_span_id);
      const database = databaseChildrenTopology(source, receipt);
      const read = one(database, "one admitted Resolve SELECT required");
      assert.equal(
        query(read),
        tokenRead,
        "Resolve source changed browser authority",
      );
      assert.equal(rows(read), 1, "admitted Resolve did not read one token");
      for (const s of [
        sourceTree.spans.get(resolution.rpc_client_span_id),
        receipt,
        ...database,
      ])
        successful(s, source);
    }
    trace.spans.forEach((s) => successful(s, trace, action === "deactivate"));
    const db = databaseChildrenTopology(trace, server),
      { transaction } = committedTransaction(trace, tree, server, db),
      groups = Object.fromEntries(
        Object.keys(statements).map((key) => [key, []]),
      );
    for (const span of db) {
      const text = query(span);
      rows(span);
      if (/^SELECT /u.test(text)) continue;
      const key = Object.keys(statements).find(
        (key) => statements[key] === text,
      );
      assert(key, "unexpected mutation SQL write");
      assert.equal(
        tree.parent(span),
        transaction,
        "mutation SQL outside owning transaction",
      );
      groups[key].push(span);
    }
    const exactly = (key, count, affected) => {
      assert.equal(groups[key].length, count, `wrong ${key} SQL count`);
      if (affected !== undefined)
        for (const span of groups[key])
          assert.equal(rows(span), affected, `wrong ${key} affected rows`);
    };
    exactly("begin", 1, 0);
    exactly("commit", 1, 0);
    assert(
      server.startTime <= transaction.startTime &&
        end(transaction) <= end(server),
      "transaction outside owning Identity response",
    );
    assert(
      transaction.startTime <= groups.begin[0].startTime &&
        end(groups.begin[0]) <= groups.commit[0].startTime &&
        end(groups.commit[0]) <= end(transaction),
      "COMMIT outside owning transaction lifetime",
    );
    exactly("password", action === "password" ? 1 : 0, 1);
    exactly("replacement", action === "password" ? 1 : 0, 1);
    exactly("attemptUpsert", action === "password" ? 2 : 0, 1);
    exactly("attemptWrite", action === "password" ? 1 : 0, 1);
    if (action === "password") {
      for (const upsert of groups.attemptUpsert)
        assert(
          end(upsert) <= groups.password[0].startTime,
          "attempt admission follows password mutation",
        );
      assert(
        end(groups.replacement[0]) <= groups.attemptWrite[0].startTime,
        "account reset precedes completed rotation",
      );
    }
    exactly("membership", console ? 1 : 0, 1);
    exactly("revoke", action === "restore" ? 0 : 1);
    const revoked = groups.revoke.length ? rows(groups.revoke[0]) : 0;
    if (action !== "restore") assert(revoked > 0, "no actual sessions revoked");
    if (action === "logout") assert.equal(revoked, 1);
    exactly("session", revoked, 1);
    exactly("sessionLock", revoked ? 1 : 0, 0);
    exactly("principal", action === "deactivate" ? 1 : 0, 1);
    exactly("principalLock", action === "deactivate" ? 1 : 0, 0);
    assert(groups.audit.length > 0, "mutation audit missing");
    groups.audit.forEach((span) => assert.equal(rows(span), 1));
    for (const spans of Object.values(groups))
      for (const span of spans)
        if (span !== groups.begin[0] && span !== groups.commit[0])
          assert(
            groups.begin[0].startTime <= span.startTime &&
              span.startTime + span.duration <= groups.commit[0].startTime,
            "mutation SQL outside BEGIN/COMMIT order",
          );
    mutations.push({
      action,
      trace_id: trace.traceID,
      identity_server_span_id: server.spanID,
      transaction_span_id: transaction.spanID,
      revoked_sessions: revoked,
      session_feed_rows: groups.session.length,
      principal_feed_rows: groups.principal.length,
      attempt_upserts: groups.attemptUpsert.length,
      attempt_writes: groups.attemptWrite.length,
      resolution,
    });
  }
  function rejection(row, login = false) {
    assert.equal(row.body.code, "unauthenticated");
    const { trace, tree, root } = raw(row);
    const route = login ? "local-login" : "resolve-access-token";
    const { client, server } = rpc(
      trace,
      tree,
      route,
      route.replaceAll("-", "_"),
      "edge-gateway",
      root,
      401,
    );
    const markers = trace.spans.filter(
      (s) => s.operationName === "gateway.identity.resolve",
    );
    assert.equal(markers.length, login ? 0 : 1);
    const decision = markers[0];
    if (decision) {
      assert.equal(tree.parent(decision), root);
      assert.equal(tree.service(decision), "edge-gateway");
      assert.equal(tag(decision, "span.kind"), "internal");
      for (const [key, value] of Object.entries({
        source: "rpc",
        profile: "session",
        outcome: "rejected",
      }))
        assert.equal(tag(decision, prefix + key), value);
      assert.equal(tag(decision, "otel.status_code"), "ERROR");
      assert.equal(tag(decision, "error"), true);
      assert.equal(tag(decision, "error.type"), undefined);
      assert.equal(decision.logs?.length ?? 0, 0);
      assert(
        client.startTime >= decision.startTime &&
          client.startTime + client.duration <=
            decision.startTime + decision.duration,
        "rejected Resolve outside actual decision",
      );
    }
    const database = databaseChildrenTopology(trace, server);
    let sql,
      transaction,
      ordered = database;
    if (login) {
      ({
        transaction,
        sql: ordered,
        credential: sql,
      } = inspectLoginRefusalTransaction(trace, server));
    } else {
      sql = one(database, "one refusal SELECT required");
      assert.equal(tree.parent(sql), server);
      assert.equal(sql.processID, server.processID);
      assert.equal(query(sql), tokenRead);
      assert.equal(rows(sql), 0);
      successful(sql, trace);
    }
    const gatewayEvent = {
      "antnest.error.cause_types": JSON.stringify([
        login ? "*identity.RemoteError" : "*errors.errorString",
      ]),
      "antnest.error.message":
        "Operation failed; unclassified error text was not exported",
      "antnest.error.stage": "request",
      "error.type": "operation_failed",
    };
    rejectionEvent(root, gatewayEvent);
    assert.equal(tag(root, "error.type"), "operation_failed");
    assert.equal(tag(client, "error.type"), "401");
    assert.equal(client.logs?.length ?? 0, 0);
    for (const s of [root, client]) {
      assert.equal(tag(s, "otel.status_code"), "ERROR");
      assert.equal(tag(s, "error"), true);
    }
    const identityEvent = {
      "antnest.error.cause_types": '["*domain.Error"]',
      "antnest.error.code": "unauthenticated",
      "antnest.error.message": "Authentication failed",
      "antnest.error.stage": "protocol",
      "antnest.error.type": "unauthenticated",
      "error.type": "unauthenticated",
    };
    rejectionEvent(server, identityEvent);
    for (const [key, value] of Object.entries(identityEvent))
      assert.equal(tag(server, key), value);
    for (const key of ["antnest.outcome", "antnest.result"])
      assert.equal(tag(server, key), "rejected");
    if (login)
      assert.equal(
        tag(server, "antnest.identity.authentication_method"),
        "local",
      );
    rejectionTags(root, {
      "error.type": "operation_failed",
      error: true,
      "otel.status_code": "ERROR",
      "otel.status_description": gatewayEvent["antnest.error.message"],
    });
    rejectionTags(client, {
      "error.type": "401",
      error: true,
      "otel.status_code": "ERROR",
      "otel.status_description": "HTTP status 401",
    });
    rejectionTags(server, identityEvent);
    if (decision)
      rejectionTags(decision, {
        error: true,
        "otel.status_code": "ERROR",
        "otel.status_description": "rejected",
      });
    const failures = [root, client, server, ...(decision ? [decision] : [])];
    const ownedSpans = new Set([
      ...failures,
      ...database,
      ...(transaction ? [transaction] : []),
    ]);
    assert(
      trace.spans.every((span) => ownedSpans.has(span)),
      "refusal contains unexpected forwarding or work",
    );
    for (const span of failures) {
      assert(hasError(span));
      owned.push({
        trace_id: trace.traceID,
        span_id: span.spanID,
        reason: login
          ? "recovery-login-unauthenticated"
          : "recovery-session-revoked",
      });
    }
    rejections.push({
      trace_id: trace.traceID,
      kind: login ? "login" : "session",
      status: 401,
      identity_server_span_id: server.spanID,
      sql_span_id: sql.spanID,
      sql_span_ids: ordered.map((span) => span.spanID),
      ...(transaction ? { transaction_span_id: transaction.spanID } : {}),
    });
  }
  for (const c of evidence.recovery.cases) {
    mutation(c);
    rejection(c.old_session);
    if (c.name !== "logout") rejection(c.peer_session);
    if (c.old_password) rejection(c.old_password, true);
    if (c.deactivated_login) rejection(c.deactivated_login, true);
    if (c.restore) {
      assert.equal(c.restore.credential_scope, c.mutation.credential_scope);
      assert.equal(
        c.restore.body.membership.user_id,
        c.login.body.principal.user_id,
      );
      assert.equal(c.restore.body.membership.role, "admin");
      mutation(c, c.restore, "restore");
      rejection(c.restored_old_session);
    }
  }
  if (preparation) {
    owned.push(...preparation.owned_error_spans);
    for (const id of preparation.trace_ids) {
      const trace = get(id);
      assert(!selected.includes(trace), "Rebuild aliases recovery mutation");
      selected.push(trace);
    }
  }
  return {
    status: "passed",
    ...(preparation ? { preparation } : {}),
    mutations,
    rejections,
    owned_error_spans: owned,
    ...resolveTraceDiagnostics(selected[0], selected),
  };
}
