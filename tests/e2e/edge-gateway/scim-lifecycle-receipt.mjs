import assert from "node:assert/strict";
import { tag, traceTopology } from "../observability/trace-tree.mjs";

const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const normalize = (value) =>
  String(value ?? "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
const value = (span, key) =>
  one(
    (span.tags ?? []).filter((field) => field.key === key),
    `one receipt ${key} required`,
  ).value;
const same = (span, key, expected) =>
  assert.equal(value(span, key), expected, `wrong receipt ${key}`);
const finished = (span) =>
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
    "unfinished SCIM revocation span",
  );

// These are the receipt's complete driver operations for the freshly-created
// SCIM user, which owns no Agents. SQL values are not exported; the observer's
// Identity JOIN establishes the User/organization/sequence relationship.
const receiptQueries = [
  ["begin", 0],
  [
    "SELECT last_sequence FROM agent_controller.identity_revocation_cursor WHERE singleton FOR UPDATE",
    1,
  ],
  [
    "SELECT DISTINCT organization_id FROM agent_controller.agents WHERE owner_user_id=$1 AND ($2='' OR organization_id=$2) AND lifecycle_state<>'deleted' AND owner_authorization_sequence<$3 AND identity_revocation_sequence<$3",
    0,
  ],
  [
    "SELECT DISTINCT hashtext(organization_id) AS key FROM unnest($1::text[]) AS organization_id ORDER BY key",
    0,
  ],
  [
    "INSERT INTO agent_controller.owner_revocations (user_id, organization_id, sequence, reason, occurred_at, trace_parent) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, organization_id) DO UPDATE SET sequence=EXCLUDED.sequence, reason=EXCLUDED.reason, occurred_at=EXCLUDED.occurred_at, trace_parent=EXCLUDED.trace_parent",
    1,
  ],
  [
    "SELECT id, organization_id, aggregate_sequence, owner_authorization_sequence, identity_revocation_sequence, desired_state FROM agent_controller.agents WHERE owner_user_id=$1 AND ($2='' OR organization_id=$2) AND lifecycle_state <> 'deleted' AND owner_authorization_sequence < $3 AND identity_revocation_sequence < $3 ORDER BY id FOR UPDATE",
    0,
  ],
  [
    "UPDATE agent_controller.identity_revocation_cursor SET last_sequence=$1 WHERE singleton",
    1,
  ],
  ["commit", 0],
];

export function inspectSCIMRevocationReceipt(trace, expected, server) {
  const source = expected.principalRevocation;
  if (!source) return undefined;
  assert(
    !expected.console &&
      expected.method === "DELETE" &&
      expected.status === 204 &&
      expected.route === "/scim/v2/Users/{id}",
    "unexpected principal revocation observation",
  );
  assert.deepEqual(Object.keys(source).sort(), [
    "membership_id",
    "organization_id",
    "reason",
    "sequence",
    "traceparent",
    "user_id",
  ]);
  for (const key of ["membership_id", "organization_id", "user_id"])
    assert.match(
      source[key] ?? "",
      /^[a-zA-Z0-9_-]{1,128}$/u,
      "invalid observed principal identity",
    );
  assert.equal(source.reason, "membership_deleted");
  assert.match(source.sequence ?? "", /^[1-9][0-9]{0,18}$/u);
  assert(
    BigInt(source.sequence) <= 9223372036854775807n,
    "invalid observed revocation sequence",
  );
  assert.match(source.traceparent ?? "", /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u);
  const [, sourceTrace, sourceSpan] = source.traceparent.split("-");
  assert.match(server.spanID, /^[a-f0-9]{1,16}$/u);
  assert.equal(
    sourceTrace,
    trace.traceID.padStart(32, "0"),
    "wrong revocation source trace",
  );
  assert.equal(
    sourceSpan,
    server.spanID.padStart(16, "0"),
    "wrong revocation source span",
  );
  same(server, "antnest.organization.id", source.organization_id);
  same(server, "antnest.identity.resource.id", source.membership_id);
  assert.match(expected.scimTokenID ?? "", /^[a-zA-Z0-9_-]{1,128}$/u);
  same(server, "antnest.identity.token.id", expected.scimTokenID);
  finished(server);
  const tree = traceTopology(trace);
  const children = (parent) =>
    trace.spans.filter((span) => tree.parent(span) === parent);
  const transaction = (parent, service, scope) => {
    const tx = one(
      children(parent).filter(
        (s) => s.operationName === "postgresql transaction",
      ),
      "one committed revocation transaction required",
    );
    assert.equal(tree.service(tx), service);
    same(tx, "span.kind", "internal");
    same(tx, "otel.scope.name", scope);
    same(tx, "db.system.name", "postgresql");
    same(tx, "antnest.transaction.outcome", "committed");
    finished(tx);
    return tx;
  };
  const driver = (tx, statement, rows) => {
    const span = one(
      children(tx).filter(
        (s) => normalize(tag(s, "db.query.text")) === normalize(statement),
      ),
      "missing or duplicate revocation SQL",
    );
    const query = value(span, "db.query.text");
    assert.equal(typeof query, "string", "receipt SQL must be a string");
    assert.equal(normalize(query), normalize(statement));
    assert.equal(tree.service(span), tree.service(tx));
    same(span, "span.kind", "client");
    same(span, "otel.scope.name", "github.com/exaring/otelpgx");
    same(span, "db.system.name", "postgresql");
    same(span, "db.operation.name", statement.split(" ")[0].toUpperCase());
    assert.equal(span.operationName, value(span, "db.operation.name"));
    same(span, "pgx.rows_affected", rows);
    finished(span);
    return span;
  };
  const sourceTransaction = transaction(
    server,
    "identity-service",
    "identity_service.database",
  );
  driver(
    sourceTransaction,
    "LOCK TABLE principal_revocations IN SHARE ROW EXCLUSIVE MODE",
    0,
  );
  driver(
    sourceTransaction,
    "INSERT INTO principal_revocations (user_id, organization_id, reason, occurred_at, traceparent) VALUES ($1, NULLIF($2, ''), $3, $4, $5)",
    1,
  );
  driver(sourceTransaction, "commit", 0);
  const receive = one(
    trace.spans.filter(
      (s) =>
        s.operationName === "agent_controller.identity_offboarding.receive",
    ),
    "one complete SCIM revocation receipt required",
  );
  assert.equal(tree.service(receive), "agent-controller");
  assert.equal(
    tree.parent(receive),
    server,
    "receipt must directly continue the actual SCIM DELETE",
  );
  assert.equal(
    receive.references.length,
    1,
    "unexpected receipt causal reference",
  );
  same(receive, "span.kind", "consumer");
  same(
    receive,
    "otel.scope.name",
    "github.com/tf4fun/antnest-platform/agent-controller/identity-offboarding",
  );
  const sequence = value(receive, "identity.revocation.sequence");
  assert(
    Number.isSafeInteger(sequence) && sequence > 0,
    "unsafe receipt sequence",
  );
  assert.equal(
    BigInt(sequence),
    BigInt(source.sequence),
    "receipt does not belong to the observed source event",
  );
  finished(receive);
  const tx = transaction(
    receive,
    "agent-controller",
    "agent_controller.database",
  );
  const database = receiptQueries.map(([statement, rows]) =>
    driver(tx, statement, rows),
  );
  const owned = new Set([receive, tx, ...database]);
  assert.deepEqual(
    new Set(trace.spans.filter((s) => tree.chain(s).includes(receive))),
    owned,
    "unexpected work in SCIM revocation receipt",
  );
  const warnings = new Set(
    receive.startTime > server.startTime + server.duration
      ? (receive.warnings ?? []).filter((warning) => {
          if (typeof warning !== "string") return false;
          const match =
            /^clock skew adjustment disabled; not applying calculated delta of -([0-9]+(?:\.[0-9]+)?)(?:ns|µs|ms|s)$/u.exec(
              warning,
            );
          return (
            match && Number.isFinite(Number(match[1])) && Number(match[1]) > 0
          );
        })
      : [],
  );
  // A second calculated shift is a new diagnostic, not the same propagated
  // async-parent warning. Preserve the entire conflict for explicit review.
  if (warnings.size !== 1) warnings.clear();
  return {
    owned,
    warnings,
    summary: {
      ...source,
      token_id: expected.scimTokenID,
      source_span_id: server.spanID,
      receive_span_id: receive.spanID,
      receipt_database_spans: database.length,
    },
  };
}
