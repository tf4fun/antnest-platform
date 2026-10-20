import assert from "node:assert/strict";
import { committedTransaction } from "../edge-gateway/resolve-cache-recovery-http.mjs";
import {
  databaseChildrenTopology,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";

const sqlText = {
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
const affected = (s) => {
  const n = tag(s, "pgx.rows_affected");
  assert(Number.isSafeInteger(n) && n >= 0, "SQL affected-row receipt missing");
  return n;
};
// This Closeout scenario uses local users with no SCIM-issued credentials.
// The legitimate global SCIM representation-version UPDATE is still required.
export function inspectUserRevocationTransaction(trace, server) {
  const tree = traceTopology(trace),
    database = databaseChildrenTopology(trace, server);
  const { transaction, sql } = committedTransaction(
    trace,
    tree,
    server,
    database,
  );
  const groups = Object.fromEntries(
    Object.keys(sqlText).map((key) => [key, []]),
  );
  for (const span of database) {
    const query = tag(span, "db.query.text").replace(/\s+/gu, " ").trim();
    assert.equal(
      span.processID,
      server.processID,
      "foreign User mutation SQL process",
    );
    affected(span);
    if (/^SELECT /u.test(query)) continue;
    const key = Object.keys(groups).find((key) => sqlText[key] === query);
    assert(key, "unexpected global User mutation SQL write");
    assert.equal(
      tree.parent(span),
      transaction,
      "User mutation write outside committed transaction",
    );
    groups[key].push(span);
  }
  for (const key of Object.keys(groups).filter((key) => key !== "session"))
    assert.equal(groups[key].length, 1, `one User mutation ${key} required`);
  const revoked = affected(groups.token[0]);
  assert(
    revoked > 0,
    "global User mutation revoked no original browser sessions",
  );
  assert.equal(
    groups.session.length,
    revoked,
    "session feed count differs from actual revoked tokens",
  );
  for (const key of ["user", "audit", "principal", "session"])
    for (const span of groups[key]) assert.equal(affected(span), 1);
  for (const key of ["begin", "commit", "principalLock", "sessionLock"])
    assert.equal(affected(groups[key][0]), 0);
  groups.session.sort((a, b) => sql.indexOf(a) - sql.indexOf(b));
  const ordered = [
    "begin",
    "scim",
    "user",
    "token",
    "audit",
    "principalLock",
    "principal",
    "sessionLock",
    "session",
    "commit",
  ].flatMap((key) => groups[key]);
  let previous = -1;
  for (const span of ordered) {
    const index = sql.indexOf(span);
    assert(index > previous, "global User mutation/feed write order changed");
    previous = index;
  }
  return {
    identity_transaction_span_id: transaction.spanID,
    identity_commit_span_id: groups.commit[0].spanID,
    revoked_sessions: revoked,
    session_feed_rows: groups.session.length,
  };
}
