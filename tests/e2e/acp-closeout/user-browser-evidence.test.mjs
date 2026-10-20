import assert from "node:assert/strict";
import test from "node:test";
import * as implementation from "../identity-closeout/agent-access-browser-evidence.mjs";
import { userBrowserFixture } from "./user-browser-fixture.mjs";
import { membershipFeedFixture } from "../identity-closeout/agent-access-browser-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

function inspect(f) {
  assert.equal(typeof implementation.inspectUserBrowserClosure, "function");
  return implementation.inspectUserBrowserClosure(
    f.trace,
    f.expected,
    [],
    f.collection,
  );
}
for (const [feed, typed] of [
  [true, true],
  [true, false],
  [false, false],
])
  test(`global User closure binds original User mutation, committed feeds and original browser (feed ${feed}, typed ${typed})`, () => {
    const f = userBrowserFixture(feed, typed),
      before = structuredClone([...f.collection.traces]);
    const result = inspect(f);
    assert.equal(result.authorizationCauseVerified, true);
    assert.equal(result.cause_proof.kind, "user_deactivated");
    assert.equal(
      result.cause_proof.identity_transaction_span_id,
      f.transaction.spanID,
    );
    assert.equal(result.cause_proof.owner_revocation_sequence, 17);
    assert.equal(result.private_owner_close_verified, false);
    assert.deepEqual([...f.collection.traces], before);
  });
test("Membership proof cannot stand in for global User loss", () => {
  assert.throws(() => inspect(membershipFeedFixture()));
});
const remove = (f, key) => {
  f.raw.trace.spans = f.raw.trace.spans.filter((s) => s !== f.sql[key]);
};
for (const [name, mutate] of [
  ["activation", (f) => (f.expected.cause.requestBody.active = true)],
  [
    "extra mutation field",
    (f) => (f.expected.cause.requestBody.membership_id = "member-b"),
  ],
  ["wrong original User", (f) => (f.expected.cause.target.user_id = "another")],
  [
    "wrong route User",
    (f) =>
      (f.expected.cause.path = "/api/admin/directory/users/another/active"),
  ],
  [
    "organization-only administrator",
    (f) =>
      Object.assign(f.expected.cause.actor, {
        system_role: "user",
        organization_role: "admin",
      }),
  ],
  [
    "Membership response",
    (f) =>
      (f.expected.cause.body = {
        membership: { id: "member-b", user_id: "user", active: false },
      }),
  ],
  ["Logout response", (f) => (f.expected.cause.status = 204)],
  [
    "Membership RPC",
    (f) => setTag(f.identity, "http.route", "/rpc/identity/update-membership"),
  ],
  [
    "User mutation not committed",
    (f) => setTag(f.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  [
    "missing transaction",
    (f) =>
      (f.raw.trace.spans = f.raw.trace.spans.filter(
        (s) => s !== f.transaction,
      )),
  ],
  ["missing user write", (f) => remove(f, "user")],
  ["missing token revoke", (f) => remove(f, "token")],
  ["missing audit", (f) => remove(f, "audit")],
  ["missing principal feed", (f) => remove(f, "principal")],
  ["missing session feed", (f) => remove(f, "session")],
  ["missing commit", (f) => remove(f, "commit")],
  [
    "principal feed before user",
    (f) => {
      const a = f.raw.trace.spans.indexOf(f.sql.user),
        b = f.raw.trace.spans.indexOf(f.sql.principal);
      [f.raw.trace.spans[a], f.raw.trace.spans[b]] = [
        f.raw.trace.spans[b],
        f.raw.trace.spans[a],
      ];
    },
  ],
  [
    "detached feed write",
    (f) => (f.sql.session.references[0].spanID = f.identity.spanID),
  ],
  ["foreign SQL process", (f) => (f.sql.user.processID = "agent-controller")],
  [
    "missing Controller receipt",
    (f) => delete f.expected.offboarding.owner_revocation,
  ],
  [
    "wrong Controller User",
    (f) =>
      (f.expected.offboarding.owner_revocation.data.owner_user_id = "other"),
  ],
  [
    "membership-scoped Controller receipt",
    (f) =>
      (f.expected.offboarding.owner_revocation.data.organization_id = "org"),
  ],
  [
    "wrong Controller sequence",
    (f) =>
      (f.expected.offboarding.owner_revocation.data.identity_revocation_sequence = 18),
  ],
  [
    "foreign Controller event source",
    (f) => (f.expected.offboarding.owner_revocation.trace_id = "a".repeat(32)),
  ],
  [
    "wrong feed reason",
    (f) =>
      (f.feed.fields.find((v) => v.key === "antnest.revocation.reason").value =
        "membership_deactivated"),
  ],
  [
    "global scope substituted for browser organization",
    (f) =>
      (f.feed.fields.find((v) => v.key === "antnest.organization.id").value =
        ""),
  ],
  [
    "wrong browser User",
    (f) =>
      (f.feed.fields.find((v) => v.key === "antnest.principal.id").value =
        "other"),
  ],
  [
    "foreign feed source",
    (f) =>
      (f.feed.fields.find(
        (v) => v.key === "antnest.revocation.trace_id",
      ).value = "a".repeat(32)),
  ],
  ["no original authorization witness", (f) => (f.root.logs = [])],
  [
    "locally cancelled stream",
    (f) => (f.expected.closure.kind = "local-abort"),
  ],
  [
    "mutation before checkpoint",
    (f) => (f.expected.cause.startedMono = f.expected.checkpoint.at - 1),
  ],
  [
    "denial before mutation response",
    (f) => (f.expected.denial.startedMono = f.expected.cause.completedMono - 1),
  ],
])
  test("global User closure rejects " + name, () => {
    const f = userBrowserFixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });
test("a global User can revoke multiple tokens without inventing one session feed per Agent", () => {
  const f = userBrowserFixture(),
    second = structuredClone(f.sql.session);
  second.spanID = "user-sql-session-2";
  setTag(f.sql.token, "pgx.rows_affected", 2);
  f.raw.trace.spans.splice(f.raw.trace.spans.indexOf(f.sql.commit), 0, second);
  assert.equal(inspect(f).authorizationCauseVerified, true);
});

test("multiple token feed writes use actual time order independently of raw span array order", () => {
  const f = userBrowserFixture(),
    second = structuredClone(f.sql.session);
  second.spanID = "user-sql-session-2";
  setTag(f.sql.token, "pgx.rows_affected", 2);
  f.raw.trace.spans.splice(f.raw.trace.spans.indexOf(f.sql.commit), 0, second);
  const sql = f.raw.trace.spans.filter(
    (s) => s.references?.[0]?.spanID === f.transaction.spanID,
  );
  f.identity.duration = f.transaction.duration = 100;
  sql.forEach((s, index) => {
    s.startTime += index * 2;
    s.duration = 1;
  });
  const a = f.raw.trace.spans.indexOf(f.sql.session),
    b = f.raw.trace.spans.indexOf(second);
  [f.raw.trace.spans[a], f.raw.trace.spans[b]] = [
    f.raw.trace.spans[b],
    f.raw.trace.spans[a],
  ];
  assert.equal(inspect(f).authorizationCauseVerified, true);
});
