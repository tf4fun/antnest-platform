import assert from "node:assert/strict";
import test from "node:test";
import { inspectRecoveryHTTP } from "./resolve-cache-recovery-http.mjs";
import { recoveryHTTPFixture } from "./resolve-cache-recovery-http-fixtures.mjs";
import {
  setTag,
  sharedResolutionFixture,
  resolvePrefix,
  sourceID,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";
const inspect = (f) =>
  inspectRecoveryHTTP(f.evidence, f, ["private-http-canary"]);
const action = (f, name = "password") => f.parts.find((p) => p.action === name);
const rejected = (f, name = "session") =>
  f.parts.find((p) => p.rejection === name);
const remove = (p, span) => {
  p.trace.spans = p.trace.spans.filter((s) => s !== span);
};

for (const preparation of [undefined, { status: "passed" }]) {
  test(`Bridge recovery HTTP requires raw Rebuild preparation evidence (${preparation ? "forged verdict" : "missing"})`, () => {
    const f = recoveryHTTPFixture();
    f.evidence.policy_revision = 4;
    if (preparation) f.evidence.recovery_preparation = preparation;
    assert.throws(() => inspect(f), /Rebuild preparation/u);
  });
}

test("recovery HTTP binds five committed mutations and ten real refusals without changing raw diagnostics", () => {
  const f = recoveryHTTPFixture();
  action(f).root.warnings = ["raw clock diagnostic"];
  const raw = JSON.stringify([...f.traces.values()]);
  const result = inspect(f);
  assert.equal(result.status, "passed");
  assert.equal(result.mutations.length, 5);
  assert.equal(result.rejections.length, 10);
  assert.equal(result.owned_error_spans.length, 38);
  assert.equal(
    new Set(result.owned_error_spans.map((r) => `${r.trace_id}:${r.span_id}`))
      .size,
    38,
  );
  assert.equal(result.error_spans, 38);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.warning_count, 1);
  assert.equal(JSON.stringify([...f.traces.values()]), raw);
});

test("session revocation count follows actual affected rows, not a recorded Docker count", () => {
  const f = recoveryHTTPFixture(),
    p = action(f);
  setTag(p.revoked, "pgx.rows_affected", 2);
  remove(
    p,
    p.trace.spans.find((s) => s.spanID === "session-feed-2"),
  );
  assert.equal(
    inspect(f).mutations.find((r) => r.action === "password").revoked_sessions,
    2,
  );
});

test("password recovery binds both attempt locks and the committed User reset", () => {
  const f = recoveryHTTPFixture();
  const receipt = inspect(f).mutations.find((r) => r.action === "password");
  assert.equal(receipt.attempt_upserts, 2);
  assert.equal(receipt.attempt_writes, 1);
});

for (const name of ["password", "deactivate"]) {
  test(`${name} login refusal commits its two failure counters before returning 401`, () => {
    const f = recoveryHTTPFixture();
    const c = f.evidence.recovery.cases.find((c) => c.name === name);
    const row = c.old_password ?? c.deactivated_login;
    const receipt = inspect(f).rejections.find(
      (r) => r.trace_id === row.trace_id,
    );
    const part = f.parts.find((p) => p.row === row);
    assert.equal(receipt.transaction_span_id, part.transaction.spanID);
    assert.equal(receipt.sql_span_ids.length, 15);
    assert.equal(receipt.sql_span_id, part.database.spanID);
  });
}

for (const kind of ["password", "login"]) {
  for (const [name, change] of [
    ["missing attempt upsert", (p) => remove(p, p.attemptUpserts[0])],
    ["missing attempt write", (p) => remove(p, p.attemptWrites[0])],
    [
      "wrong attempt upsert rows",
      (p) => setTag(p.attemptUpserts[0], "pgx.rows_affected", 0),
    ],
    [
      "wrong attempt write rows",
      (p) => setTag(p.attemptWrites[0], "pgx.rows_affected", 2),
    ],
    ["attempt SQL error", (p) => setTag(p.attemptWrites[0], "error", true)],
    [
      "attempt outside transaction",
      (p) => {
        p.attemptUpserts[0].references[0].spanID = p.server.spanID;
      },
    ],
    [
      "attempt after COMMIT",
      (p) => {
        p.attemptWrites[0].startTime = p.commit.startTime + p.commit.duration;
      },
    ],
    [
      "attempt from another Identity process",
      (p) => {
        p.trace.processes.foreignIdentity = { serviceName: "identity-service" };
        p.attemptWrites[0].processID = "foreignIdentity";
      },
    ],
    [
      "transaction from another Identity process",
      (p) => {
        p.trace.processes.foreignIdentity = { serviceName: "identity-service" };
        p.transaction.processID = "foreignIdentity";
      },
    ],
    [
      "extra attempt write",
      (p) => {
        const extra = structuredClone(p.attemptWrites[0]);
        extra.spanID = "duplicate-attempt-write";
        p.trace.spans.push(extra);
      },
    ],
  ]) {
    test(`${kind} recovery rejects ${name}`, () => {
      const f = recoveryHTTPFixture();
      change(kind === "password" ? action(f) : rejected(f, "login"));
      assert.throws(() => inspect(f));
    });
  }
}

for (const [name, change] of [
  ["missing COMMIT", (p) => remove(p, p.commit)],
  [
    "rolled back transaction",
    (p) => setTag(p.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  ["SQL ERROR", (p) => setTag(p.database, "otel.status_code", "ERROR")],
  [
    "credential write",
    (p) =>
      setTag(
        p.database,
        "db.query.text",
        "UPDATE local_credentials SET password_hash=$1 WHERE user_id=$2",
      ),
  ],
  [
    "unexpected SELECT",
    (p) =>
      setTag(
        p.database,
        "db.query.text",
        "SELECT password_hash FROM local_credentials",
      ),
  ],
  [
    "reordered attempt locks",
    (p) => {
      const first = p.attemptUpserts[0];
      first.startTime = p.attemptUpserts[1].startTime + 1;
    },
  ],
  [
    "transaction ends after refusal",
    (p) => {
      p.transaction.duration = p.server.duration + 1;
    },
  ],
]) {
  test(`login refusal rejects ${name}`, () => {
    const f = recoveryHTTPFixture();
    change(rejected(f, "login"));
    assert.throws(() => inspect(f));
  });
}

for (const [name, change] of [
  [
    "COMMIT after owning response",
    (f) => {
      const p = action(f);
      p.commit.startTime = p.root.startTime + p.root.duration + 1;
    },
  ],
  [
    "COMMIT after transaction end",
    (f) => {
      const p = action(f);
      p.transaction.duration = p.commit.startTime - p.transaction.startTime;
    },
  ],
  [
    "SQL bare error code",
    (f) => setTag(action(f).revoked, "error.code", "db_failed"),
  ],
  [
    "missing COMMIT",
    (f) => {
      const p = action(f);
      remove(p, p.commit);
    },
  ],
  [
    "COMMIT outside owning transaction",
    (f) => {
      const p = action(f);
      p.commit.references[0].spanID = p.server.spanID;
    },
  ],
  [
    "rolled back transaction",
    (f) =>
      setTag(
        action(f).transaction,
        "antnest.transaction.outcome",
        "rolled_back",
      ),
  ],
  ["SQL ERROR", (f) => setTag(action(f).revoked, "error", true)],
  [
    "SQL numeric ERROR",
    (f) => setTag(action(f).revoked, "otel.status_code", 2),
  ],
  [
    "SQL error type only",
    (f) => setTag(action(f).revoked, "error.type", "postgres_failure"),
  ],
  ["feed mismatch", (f) => setTag(action(f).revoked, "pgx.rows_affected", 4)],
  [
    "zero actual revoked sessions",
    (f) => setTag(action(f).revoked, "pgx.rows_affected", 0),
  ],
  [
    "string row count",
    (f) => setTag(action(f).revoked, "pgx.rows_affected", "3"),
  ],
  [
    "unscoped token revocation",
    (f) =>
      setTag(
        action(f).revoked,
        "db.query.text",
        "UPDATE api_tokens SET revoked_at = $1",
      ),
  ],
  [
    "missing replacement token",
    (f) => {
      const p = action(f);
      remove(p, p.replacement);
    },
  ],
  [
    "missing password CAS",
    (f) => {
      const p = action(f);
      remove(p, p.password);
    },
  ],
  [
    "missing principal feed",
    (f) => {
      const p = action(f, "deactivate");
      remove(p, p.principalFeed);
    },
  ],
  [
    "wrong owning RPC",
    (f) => setTag(action(f).server, "rpc.method", "local_login"),
  ],
  [
    "wrong Console parent",
    (f) => {
      const p = action(f, "role");
      p.client.references[0].spanID = p.root.spanID;
    },
  ],
  [
    "extra SQL write",
    (f) => {
      const p = action(f);
      p.sql("unexpected-write", p.transaction, "DELETE FROM users", 1);
    },
  ],
  [
    "unrelated error event",
    (f) => {
      const p = action(f);
      p.root.logs = [{ fields: fields({ event: "exception" }) }];
    },
  ],
  [
    "missing actual HTTP",
    (f) => {
      f.evidence.http = f.evidence.http.filter((r) => r !== action(f).row);
    },
  ],
  [
    "wrong mutation Membership",
    (f) => {
      action(f, "role").row.body.membership.id = "wrong";
    },
  ],
  [
    "swapped old credential",
    (f) => {
      const c = f.evidence.recovery.cases[1];
      c.old_session.credential_scope = c.peer_login.issued_credential_scope;
    },
  ],
  [
    "restore used revoked principal",
    (f) => {
      const c = f.evidence.recovery.cases[3];
      c.restore.credential_scope = c.login.issued_credential_scope;
    },
  ],
  [
    "wrong restore user",
    (f) => {
      f.evidence.recovery.cases[3].restore.body.membership.user_id = "other";
    },
  ],
  [
    "unarchived mutation",
    (f) => f.archivedTraceIDs.delete(action(f).trace.traceID),
  ],
  [
    "missing rejection SERVER",
    (f) => {
      const p = rejected(f);
      remove(p, p.server);
    },
  ],
  [
    "missing rejection SQL",
    (f) => {
      const p = rejected(f);
      remove(p, p.database);
    },
  ],
  [
    "resolved old token",
    (f) => setTag(rejected(f).database, "pgx.rows_affected", 1),
  ],
  [
    "login missing credential row",
    (f) => setTag(rejected(f, "login").database, "pgx.rows_affected", 0),
  ],
  ["rejection SQL ERROR", (f) => setTag(rejected(f).database, "error", true)],
  [
    "401 converted into 503",
    (f) => setTag(rejected(f).client, "http.response.status_code", 503),
  ],
  [
    "different root cause",
    (f) => {
      rejected(f).root.logs[0].fields.find(
        (v) => v.key === "antnest.error.cause_types",
      ).value = '["*network.Error"]';
    },
  ],
  [
    "different protocol stage",
    (f) => setTag(rejected(f).server, "antnest.error.stage", "database"),
  ],
  [
    "extra rejection exception",
    (f) => {
      rejected(f).client.logs = [{ fields: fields({ event: "exception" }) }];
    },
  ],
  [
    "unrelated refusal error code tag",
    (f) => setTag(rejected(f).root, "antnest.error.code", "database_failed"),
  ],
  [
    "unrelated refusal status description",
    (f) =>
      setTag(rejected(f).client, "otel.status_description", "upstream timeout"),
  ],
  [
    "unrelated mutation error metadata",
    (f) => setTag(action(f).root, "antnest.error.type", "database_failed"),
  ],
  [
    "unexpected rejection forwarding",
    (f) => {
      const p = rejected(f);
      p.http("forwarded", "edge", p.root, "client");
    },
  ],
  [
    "rejection wrote a token",
    (f) => {
      const p = rejected(f, "login");
      p.sql("token-write", p.server, "INSERT INTO api_tokens VALUES ($1)");
    },
  ],
  [
    "missing rejection marker",
    (f) => {
      const p = rejected(f);
      remove(p, p.decision);
    },
  ],
  [
    "wrong actual refusal body",
    (f) => {
      rejected(f).row.body.code = "unavailable";
    },
  ],
  [
    "captured secret",
    (f) => setTag(action(f).root, "private.note", "private-http-canary"),
  ],
  [
    "payload capture",
    (f) => {
      action(f).root.logs = [
        { fields: fields({ "antnest.payload.json": "{}" }) },
      ];
    },
  ],
  [
    "SQL parameters captured",
    (f) => setTag(action(f).revoked, "db.query.parameters.1", "private"),
  ],
])
  test(`recovery HTTP rejects ${name}`, () => {
    const f = recoveryHTTPFixture();
    assert.equal(inspect(f).status, "passed");
    change(f);
    assert.throws(() => inspect(f));
  });

test("successful Runtime Egress placeholder requires its concrete success receipt", () => {
  const f = recoveryHTTPFixture(),
    p = action(f, "deactivate");
  p.trace.processes.egress = { serviceName: "antnest-runtime-egress" };
  const s = p.add("egress-success", "egress", p.root, {
    "span.kind": "server",
    "http.route": "/internal/agent-networks/{agent_id}",
    "http.request.method": "GET",
    "http.response.status_code": 200,
    "antnest.operation.phase": "control_http",
    "antnest.outcome": "success",
    "error.type": "",
  });
  s.logs = [
    {
      fields: fields({
        event: "antnest.complete",
        "antnest.outcome": "success",
        "antnest.response.termination": "eof",
      }),
    },
  ];
  assert.equal(inspect(f).status, "passed");
  for (const [key, value] of [
    ["antnest.outcome", "error"],
    ["http.response.status_code", 503],
    ["error.type", "runtime_failure"],
    ["otel.status_code", 2],
  ]) {
    const before = structuredClone(s.tags);
    setTag(s, key, value);
    assert.throws(() => inspect(f));
    s.tags = before;
  }
});

test("deactivation admits the owning completed Docker delete's explicit absent inspection only", () => {
  const f = recoveryHTTPFixture(),
    p = action(f, "deactivate");
  p.trace.processes.controller = { serviceName: "runtime-controller" };
  const parent = p.add(
    "runtime-delete",
    "controller",
    p.root,
    {
      "span.kind": "internal",
      "antnest.platform": "docker",
      "antnest.platform.operation": "delete",
      "antnest.outcome": "completed",
      "antnest.result": "completed",
      "antnest.error.code": "",
    },
    "runtime.platform.delete",
  );
  const s = p.add(
    "docker-inspection",
    "controller",
    parent,
    {
      "span.kind": "client",
      "http.request.method": "GET",
      "http.response.status_code": 404,
      "server.address": "docker",
      "peer.service": "docker",
      "antnest.outcome": "absent",
    },
    "HTTP GET docker",
  );
  const before = JSON.stringify(p.trace);
  assert.equal(inspect(f).status, "passed");
  assert.equal(JSON.stringify(p.trace), before);
  for (const [span, key, value] of [
    [s, "http.response.status_code", 403],
    [s, "antnest.outcome", "error"],
    [s, "error", true],
    [s, "error.type", "not_found"],
    [s, "server.address", "identity-service"],
    [parent, "antnest.outcome", "failed"],
  ]) {
    const saved = structuredClone(span.tags);
    setTag(span, key, value);
    assert.throws(() => inspect(f));
    span.tags = saved;
  }
  s.references[0].spanID = p.root.spanID;
  assert.throws(() => inspect(f));
});

function sharedMutation(f) {
  const p = action(f),
    shared = sharedResolutionFixture();
  shared.origin.trace.spans.find((s) => s.spanID === "sql").tags =
    structuredClone(p.trace.spans.find((s) => s.spanID === "sql").tags);
  p.decision.tags = structuredClone(shared.decision.tags);
  setTag(p.decision, resolvePrefix + "profile", "session");
  p.decision.references.push(structuredClone(shared.decision.references[1]));
  p.trace.spans = p.trace.spans.filter(
    (s) => !["resolve-client", "resolve-server", "sql"].includes(s.spanID),
  );
  setTag(shared.origin.decision, resolvePrefix + "profile", "session");
  f.traces.set(sourceID, shared.origin.trace);
  f.archivedTraceIDs.add(sourceID);
  return shared.origin.trace;
}
for (const [name, change] of [
  [
    "source wrote during Resolve",
    (_f, t) => {
      const s = t.spans.find((s) => s.spanID === "sql");
      s.operationName = "UPDATE";
      setTag(s, "db.operation.name", "UPDATE");
      setTag(s, "db.query.text", "UPDATE api_tokens SET last_used_at = $1");
    },
  ],
  ["missing source archive", (f) => f.archivedTraceIDs.delete(sourceID)],
  [
    "missing source parent",
    (_f, t) => {
      t.spans = t.spans.filter((s) => s.spanID !== "root");
    },
  ],
  [
    "source SQL error type",
    (_f, t) =>
      setTag(
        t.spans.find((s) => s.spanID === "sql"),
        "error.type",
        "db_failed",
      ),
  ],
  [
    "source capture",
    (_f, t) => {
      t.spans[0].logs = [{ fields: fields({ "antnest.payload.json": "{}" }) }];
    },
  ],
])
  test(`recovery HTTP shared authority rejects ${name}`, () => {
    const f = recoveryHTTPFixture(),
      source = sharedMutation(f);
    assert.equal(inspect(f).status, "passed");
    change(f, source);
    assert.throws(() => inspect(f));
  });
