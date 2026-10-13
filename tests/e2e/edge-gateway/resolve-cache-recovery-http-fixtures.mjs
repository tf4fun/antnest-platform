import { recoveryFixture } from "./resolve-cache-recovery-fixtures.mjs";
import {
  resolutionFixture,
  setTag,
  resolvePrefix,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

const tokenRead =
  "SELECT t.id, t.expires_at, t.idle_expires_at, u.id, m.organization_id, m.id, u.system_role, m.role, u.active, m.active, o.active, o.slug, o.name FROM api_tokens t JOIN users u ON u.id = t.user_id JOIN organization_memberships m ON m.id = t.membership_id AND m.organization_id = t.organization_id AND m.user_id = u.id JOIN organizations o ON o.id = t.organization_id WHERE t.token_hash = $1 AND t.kind = 'browser' AND t.revoked_at IS NULL AND t.expires_at > $2 AND t.idle_expires_at > $2 AND m.scim_deleted_at IS NULL";
const attemptUpsert =
  "INSERT INTO credential_attempts (scope,key_hash,window_start,failures) VALUES ($1,$2,clock_timestamp(),0) ON CONFLICT (scope,key_hash) DO UPDATE SET scope=EXCLUDED.scope RETURNING window_start,failures,locked_until";
const attemptWrite =
  "UPDATE credential_attempts SET window_start=$3,failures=$4,locked_until=$5 WHERE scope=$1 AND key_hash=$2";
const tokenUpdate =
  "UPDATE api_tokens SET revoked_at = $2 WHERE id = ANY($1::text[]) AND kind = 'browser' AND revoked_at IS NULL AND ($3 = '' OR organization_id = $3) AND ($4 = '' OR membership_id = $4) AND id <> $5 RETURNING id, user_id, organization_id";
const audit =
  "INSERT INTO identity_events ( id, organization_id, actor_principal_id, actor_scim_token_id, event_type, subject_type, subject_id, request_id, metadata, created_at ) VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5, $6, $7, NULLIF($8, ''), $9, $10)";

export function recoveryHTTPFixture() {
  const evidence = recoveryFixture();
  evidence.settings = { resolveTTLMS: 10000 };
  const traces = new Map(),
    archivedTraceIDs = new Set(),
    parts = [];
  function create(row, source = "rpc") {
    const f = resolutionFixture(source),
      trace = f.trace;
    trace.traceID = row.trace_id;
    trace.processes.console = { serviceName: "admin-console" };
    trace.spans = trace.spans.filter((s) => s !== f.upstream);
    for (const s of trace.spans) {
      s.traceID = trace.traceID;
      for (const ref of s.references) ref.traceID = trace.traceID;
    }
    setTag(
      f.root,
      "http.route",
      row.path.startsWith("/api/admin/") ? "/api/admin/{path...}" : row.path,
    );
    setTag(f.root, "http.request.method", row.method);
    setTag(f.root, "http.response.status_code", row.status);
    setTag(
      f.decision,
      resolvePrefix + "profile",
      row.path.startsWith("/api/admin/") ? "console" : "session",
    );
    if (source === "rpc") {
      setTag(
        trace.spans.find((s) => s.spanID === "sql"),
        "db.query.text",
        tokenRead,
      );
      setTag(
        trace.spans.find((s) => s.spanID === "sql"),
        "pgx.rows_affected",
        1,
      );
    }
    let sequence = 0;
    const add = (id, processID, parent, tags, operationName = id) => {
      const s = {
        traceID: trace.traceID,
        spanID: id,
        processID,
        operationName,
        startTime: 1020000 + sequence++ * 100,
        duration: 50,
        references: [
          {
            refType: "CHILD_OF",
            traceID: trace.traceID,
            spanID: parent.spanID,
          },
        ],
        tags: fields(tags),
        logs: [],
      };
      trace.spans.push(s);
      return s;
    };
    const http = (id, process, parent, kind, route, status = 200) =>
      add(id, process, parent, {
        "span.kind": kind,
        "http.request.method": "POST",
        "http.response.status_code": status,
        ...(route
          ? {
              "http.route": route,
              "rpc.method": route.split("/").at(-1).replaceAll("-", "_"),
            }
          : {}),
      });
    const sql = (id, parent, query, rows = 1) =>
      add(
        id,
        "identity",
        parent,
        {
          "span.kind": "client",
          "db.system.name": "postgresql",
          "db.operation.name": query.split(" ")[0].toUpperCase(),
          "db.query.text": query,
          "pgx.rows_affected": rows,
        },
        query.split(" ")[0].toUpperCase(),
      );
    traces.set(trace.traceID, trace);
    archivedTraceIDs.add(trace.traceID);
    const part = { ...f, row, add, http, sql };
    parts.push(part);
    return part;
  }
  function mutation(c, row = c.mutation, action = c.name) {
    const console = ["role", "deactivate", "restore"].includes(action);
    const f = create(row, console ? "cache" : "rpc");
    f.action = action;
    let parent = f.root;
    if (console) {
      f.upstream = f.http("console-client", "edge", parent, "client");
      parent = f.http(
        "console-server",
        "console",
        f.upstream,
        "server",
        "/api/admin/directory/memberships/{membership_id}",
      );
    }
    f.client = f.http(
      "command-client",
      console ? "console" : "edge",
      parent,
      "client",
    );
    f.upstream ??= f.client;
    f.server = f.http(
      "command-server",
      "identity",
      f.client,
      "server",
      `/rpc/identity/${action === "logout" ? "revoke-access-token" : action === "password" ? "change-local-password" : "update-membership"}`,
    );
    f.transaction = f.add(
      "transaction",
      "identity",
      f.server,
      {
        "span.kind": "internal",
        "db.system.name": "postgresql",
        "antnest.transaction.outcome": "committed",
      },
      "postgresql transaction",
    );
    f.begin = f.sql("begin", f.transaction, "begin", 0);
    if (action === "password") {
      f.attemptUpserts = [
        f.sql("attempt-organization", f.transaction, attemptUpsert),
      ];
      f.sql("clock-organization", f.transaction, "SELECT clock_timestamp()");
      f.attemptUpserts.push(
        f.sql("attempt-user", f.transaction, attemptUpsert),
      );
      f.sql("clock-user", f.transaction, "SELECT clock_timestamp()");
    }
    if (console)
      f.membership = f.sql(
        "membership",
        f.transaction,
        "UPDATE organization_memberships SET email = $3, display_name = $4, role = $5, active = $6, updated_at = $7 WHERE organization_id = $1 AND id = $2",
      );
    if (action === "password")
      f.password = f.sql(
        "password",
        f.transaction,
        "UPDATE local_credentials SET password_hash = $3, updated_at = $4 WHERE user_id = $1 AND password_hash = $2",
      );
    if (action !== "restore") {
      f.revoked = f.sql(
        "revoked",
        f.transaction,
        tokenUpdate,
        action === "logout" ? 1 : 3,
      );
      f.sql(
        "session-lock",
        f.transaction,
        "LOCK TABLE session_revocations IN SHARE ROW EXCLUSIVE MODE",
        0,
      );
      for (let n = 0; n < (action === "logout" ? 1 : 3); n++)
        f.sql(
          `session-feed-${n}`,
          f.transaction,
          "INSERT INTO session_revocations (token_id, user_id, organization_id, reason, occurred_at, traceparent) VALUES ($1, $2, $3, $4, $5, $6)",
        );
    }
    if (action === "password")
      f.replacement = f.sql(
        "replacement",
        f.transaction,
        "INSERT INTO api_tokens (id, token_hash, public_session_id, user_id, organization_id, membership_id, issued_at, last_used_at, expires_at, idle_expires_at, user_agent_hint) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, LEAST($8::timestamptz, $9::timestamptz), $10) RETURNING expires_at, idle_expires_at",
      );
    if (action === "deactivate") {
      f.sql(
        "principal-lock",
        f.transaction,
        "LOCK TABLE principal_revocations IN SHARE ROW EXCLUSIVE MODE",
        0,
      );
      f.principalFeed = f.sql(
        "principal-feed",
        f.transaction,
        "INSERT INTO principal_revocations (user_id, organization_id, reason, occurred_at, traceparent) VALUES ($1, NULLIF($2, ''), $3, $4, $5)",
      );
    }
    f.sql("audit", f.transaction, audit);
    if (action === "password") {
      f.sql("clock-reset", f.transaction, "SELECT clock_timestamp()");
      f.attemptWrites = [f.sql("attempt-reset", f.transaction, attemptWrite)];
    }
    f.commit = f.sql("commit", f.transaction, "commit", 0);
    f.transaction.duration =
      f.commit.startTime + f.commit.duration - f.transaction.startTime + 1;
    f.server.duration =
      f.transaction.startTime + f.transaction.duration - f.server.startTime + 1;
    f.client.duration =
      f.server.startTime + f.server.duration - f.client.startTime + 1;
    if (action === "password")
      f.root.duration =
        f.client.startTime + f.client.duration - f.root.startTime + 1;
  }
  const event = (span, values) => {
    span.logs = [
      {
        timestamp: span.startTime,
        fields: fields({ event: "antnest.error", ...values }),
      },
    ];
  };
  function rejection(row, login = false) {
    row.body = { code: "unauthenticated" };
    const f = create(row);
    f.rejection = login ? "login" : "session";
    f.client = f.trace.spans.find((s) => s.spanID === "resolve-client");
    f.server = f.trace.spans.find((s) => s.spanID === "resolve-server");
    f.database = f.trace.spans.find((s) => s.spanID === "sql");
    if (login) {
      f.trace.spans = f.trace.spans.filter(
        (s) => s !== f.decision && s !== f.database,
      );
      f.server.operationName = "HTTP POST /rpc/identity/local-login";
      setTag(f.server, "http.route", "/rpc/identity/local-login");
      setTag(f.server, "rpc.method", "local_login");
      setTag(f.server, "antnest.identity.authentication_method", "local");
      f.transaction = f.add(
        "transaction",
        "identity",
        f.server,
        {
          "span.kind": "internal",
          "db.system.name": "postgresql",
          "antnest.transaction.outcome": "committed",
        },
        "postgresql transaction",
      );
      f.begin = f.sql("begin", f.transaction, "begin", 0);
      f.sql(
        "organization-discovery",
        f.transaction,
        "SELECT id FROM organizations WHERE slug=$1",
      );
      f.attemptUpserts = [
        f.sql("attempt-organization", f.transaction, attemptUpsert),
      ];
      f.sql("clock-organization", f.transaction, "SELECT clock_timestamp()");
      f.attemptUpserts.push(
        f.sql("attempt-account", f.transaction, attemptUpsert),
      );
      f.sql("clock-account", f.transaction, "SELECT clock_timestamp()");
      f.sql(
        "membership-discovery",
        f.transaction,
        "SELECT user_id,id FROM organization_memberships WHERE organization_id=$1 AND email=$2 AND scim_deleted_at IS NULL",
      );
      f.sql(
        "user-lock",
        f.transaction,
        "SELECT system_role,active FROM users WHERE id=$1 FOR SHARE",
      );
      f.sql(
        "organization-lock",
        f.transaction,
        "SELECT slug,name,active FROM organizations WHERE id=$1 FOR SHARE",
      );
      f.sql(
        "membership-lock",
        f.transaction,
        "SELECT role,active FROM organization_memberships WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND email=$4 AND scim_deleted_at IS NULL FOR SHARE",
      );
      f.database = f.sql(
        "sql",
        f.transaction,
        "SELECT password_hash FROM local_credentials WHERE user_id=$1 FOR UPDATE",
      );
      f.sql("clock-failure", f.transaction, "SELECT clock_timestamp()");
      f.attemptWrites = [
        f.sql("attempt-organization-failure", f.transaction, attemptWrite),
        f.sql("attempt-account-failure", f.transaction, attemptWrite),
      ];
      f.commit = f.sql("commit", f.transaction, "commit", 0);
      f.transaction.duration =
        f.commit.startTime + f.commit.duration - f.transaction.startTime + 1;
      f.server.duration =
        f.transaction.startTime +
        f.transaction.duration -
        f.server.startTime +
        1;
      f.client.duration =
        f.server.startTime + f.server.duration - f.client.startTime + 1;
      f.root.duration =
        f.client.startTime + f.client.duration - f.root.startTime + 1;
    } else {
      setTag(f.decision, resolvePrefix + "outcome", "rejected");
      setTag(f.decision, "otel.status_code", "ERROR");
      setTag(f.decision, "error", true);
      setTag(f.database, "pgx.rows_affected", 0);
    }
    for (const span of [f.client, f.server])
      setTag(span, "http.response.status_code", 401);
    for (const span of [f.root, f.client]) {
      setTag(span, "error", true);
      setTag(span, "otel.status_code", "ERROR");
    }
    setTag(f.root, "error.type", "operation_failed");
    setTag(f.client, "error.type", "401");
    event(f.root, {
      "error.type": "operation_failed",
      "antnest.error.stage": "request",
      "antnest.error.cause_types": JSON.stringify([
        login ? "*identity.RemoteError" : "*errors.errorString",
      ]),
      "antnest.error.message":
        "Operation failed; unclassified error text was not exported",
    });
    const failure = {
      "error.type": "unauthenticated",
      "antnest.error.type": "unauthenticated",
      "antnest.error.code": "unauthenticated",
      "antnest.error.stage": "protocol",
      "antnest.error.cause_types": '["*domain.Error"]',
      "antnest.error.message": "Authentication failed",
    };
    for (const [key, value] of Object.entries(failure))
      setTag(f.server, key, value);
    setTag(f.server, "antnest.outcome", "rejected");
    setTag(f.server, "antnest.result", "rejected");
    event(f.server, failure);
    if (login) {
      f.server.logs[0].timestamp = f.server.startTime + f.server.duration - 1;
      f.root.logs[0].timestamp = f.root.startTime + f.root.duration - 1;
    }
  }
  for (const c of evidence.recovery.cases) {
    mutation(c);
    rejection(c.old_session);
    if (c.name !== "logout") rejection(c.peer_session);
    if (c.old_password) rejection(c.old_password, true);
    if (c.deactivated_login) rejection(c.deactivated_login, true);
    if (c.restore) {
      c.restore.credential_scope = c.mutation.credential_scope;
      mutation(c, c.restore, "restore");
      rejection(c.restored_old_session);
    }
  }
  return { evidence, traces, archivedTraceIDs, parts };
}
