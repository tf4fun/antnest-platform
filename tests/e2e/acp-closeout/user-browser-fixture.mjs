import {
  membershipBrowserFixture,
  membershipFeedFixture,
} from "../identity-closeout/agent-access-browser-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

// Independent source-shaped SQL fixture; never manufacture or alter live receipts.
export const userSQL = {
  begin: "begin",
  scim: "UPDATE organization_memberships SET updated_at = GREATEST($2::timestamptz, updated_at + interval '1 microsecond') WHERE user_id = $1 AND source = 'scim' AND scim_deleted_at IS NULL",
  user: "UPDATE users SET active = $2, updated_at = $3 WHERE id = $1",
  token:
    "UPDATE api_tokens SET revoked_at = $2 WHERE id = ANY($1::text[]) AND kind = 'browser' AND revoked_at IS NULL AND ($3 = '' OR organization_id = $3) AND ($4 = '' OR membership_id = $4) AND id <> $5 RETURNING id, user_id, organization_id",
  audit:
    "INSERT INTO identity_events ( id, organization_id, actor_principal_id, actor_scim_token_id, event_type, subject_type, subject_id, request_id, metadata, created_at ) VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5, $6, $7, NULLIF($8, ''), $9, $10)",
  principalLock: "LOCK TABLE principal_revocations IN SHARE ROW EXCLUSIVE MODE",
  principal:
    "INSERT INTO principal_revocations (user_id, organization_id, reason, occurred_at, traceparent) VALUES ($1, NULLIF($2, ''), $3, $4, $5)",
  sessionLock: "LOCK TABLE session_revocations IN SHARE ROW EXCLUSIVE MODE",
  session:
    "INSERT INTO session_revocations (token_id, user_id, organization_id, reason, occurred_at, traceparent) VALUES ($1, $2, $3, $4, $5, $6)",
  commit: "commit",
};
export function userBrowserFixture(feed = true, typed = true) {
  const f = feed ? membershipFeedFixture(typed) : membershipBrowserFixture();
  Object.assign(f.expected.cause, {
    kind: "user_deactivated",
    path: "/api/admin/directory/users/user/active",
    requestBody: { active: false },
    body: { status: "updated" },
    actor: {
      user_id: "system-admin",
      organization_id: "another-org",
      system_role: "admin",
      organization_role: "member",
    },
  });
  setTag(
    f.raw.trace.spans.find((s) => s.spanID === "console"),
    "http.route",
    "/api/admin/directory/users/{user_id}/active",
  );
  setTag(f.identity, "http.route", "/rpc/identity/set-user-active");
  setTag(f.identity, "rpc.method", "set_user_active");
  if (feed)
    f.feed.fields.find((v) => v.key === "antnest.revocation.reason").value =
      "user_deactivated";
  f.expected.offboarding.owner_revocation = {
    event_id: "event-user-revoked",
    event_type: "agent_owner_revoked",
    agent_id: "agent-1",
    trace_id: f.raw.trace.traceID,
    data: {
      owner_user_id: "user",
      organization_id: "",
      reason: "user_deactivated",
      identity_revocation_sequence: 17,
    },
  };
  const add = (id, parent, operationName, fields) => {
    const span = {
      traceID: f.raw.trace.traceID,
      spanID: id,
      processID: f.identity.processID,
      operationName,
      startTime: f.identity.startTime,
      duration: 0,
      references: [
        { refType: "CHILD_OF", traceID: f.raw.trace.traceID, spanID: parent },
      ],
      tags: Object.entries(fields).map(([key, value]) => ({ key, value })),
    };
    f.raw.trace.spans.push(span);
    return span;
  };
  f.transaction = add(
    "user-transaction",
    f.identity.spanID,
    "postgresql transaction",
    {
      "span.kind": "internal",
      "db.system.name": "postgresql",
      "antnest.transaction.outcome": "committed",
    },
  );
  f.sql = {};
  for (const [key, query] of Object.entries(userSQL)) {
    const operation = query.split(" ")[0].toUpperCase();
    f.sql[key] = add("user-sql-" + key, f.transaction.spanID, operation, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": operation,
      "db.query.text": query,
      "pgx.rows_affected": [
        "begin",
        "commit",
        "scim",
        "principalLock",
        "sessionLock",
      ].includes(key)
        ? 0
        : 1,
    });
  }
  return f;
}
