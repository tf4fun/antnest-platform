import assert from "node:assert/strict";
import test from "node:test";
import { fields, databaseRequest } from "../observability/trace-fixtures.mjs";
import { verifyIdentityEvidence } from "../identity-closeout/trace.mjs";
import { inspectLifecycleTrace } from "./scim-lifecycle-evidence.mjs";
import { recoveryHTTPFixture } from "./resolve-cache-recovery-http-fixtures.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { sharedResolutionFixture } from "../observability/gateway-resolution-fixtures.mjs";

const traceID = "a".repeat(32);
const expected = {
  traceID,
  method: "PATCH",
  status: 412,
  route: "/scim/v2/Users/{id}",
  clientService: "edge-gateway",
  errorCode: "precondition_failed",
  responseBytes: 128,
};
const setTag = (span, key, value) => {
  span.tags = span.tags.filter((field) => field.key !== key);
  span.tags.push({ key, value });
};
function fixture(expectation = expected) {
  const child = (spanID) => [{ refType: "CHILD_OF", traceID, spanID }];
  const http = (spanID, kind, parent, route) => ({
    traceID,
    spanID,
    processID: "edge",
    operationName: `HTTP ${expectation.method}`,
    duration: 100,
    startTime: 1000,
    references: parent ? child(parent) : [],
    tags: fields({
      "span.kind": kind,
      "http.request.method": expectation.method,
      "http.response.status_code": expectation.status,
      "http.request.body.size": 24,
      "http.response.body.size": expectation.responseBytes,
      ...(route ? { "http.route": route } : {}),
    }),
  });
  const [server, sql] = databaseRequest(
    traceID,
    "identity",
    "client",
    "identity",
    expectation.route,
    expectation.method,
  );
  setTag(server, "http.response.status_code", expectation.status);
  setTag(server, "http.response.body.size", expectation.responseBytes);
  const trace = {
    traceID,
    processes: {
      edge: { serviceName: "edge-gateway" },
      identity: { serviceName: "identity-service" },
    },
    spans: [
      http("root", "server", undefined, "/scim/v2/{path...}"),
      http("client", "client", "root"),
      server,
      sql,
    ],
  };
  if (expectation.errorCode) {
    server.tags.push(
      ...fields({
        "antnest.outcome": "rejected",
        "antnest.error.code": expectation.errorCode,
        "error.type": expectation.errorCode,
      }),
    );
    server.logs = [
      {
        fields: fields({
          event: "antnest.error",
          "antnest.error.code": expectation.errorCode,
        }),
      },
    ];
    trace.spans[1].tags.push(
      ...fields({
        "otel.status_code": "ERROR",
        "error.type": String(expectation.status),
      }),
    );
  }
  return trace;
}

test("SCIM expected rejections retain raw strict failure with exact separate attribution", async () => {
  const trace = fixture(),
    original = structuredClone(trace);
  const report = inspectLifecycleTrace(trace, expected, []);
  assert.equal(report.expected_errors.length, 2);
  assert.equal(report.unexpected_errors, 0);
  const reports = await verifyIdentityEvidence(
    "http://fixture",
    [expected],
    [],
    {
      inspect: inspectLifecycleTrace,
      wait: async () => {},
      attempts: 3,
      request: async () => Response.json({ data: [trace] }),
    },
  );
  assert.equal(reports[0].strict_trace, "failed");
  assert.equal(reports[0].error_spans, 2);
  assert.deepEqual(trace, original);
});

for (const [name, mutate] of [
  ["outer status", (t) => setTag(t.spans[0], "http.response.status_code", 200)],
  [
    "forwarding method",
    (t) => setTag(t.spans[1], "http.request.method", "DELETE"),
  ],
  [
    "outer route",
    (t) => setTag(t.spans[0], "http.route", "/api/admin/{path...}"),
  ],
  ["non-HTTP root", (t) => setTag(t.spans[0], "span.kind", "internal")],
  [
    "transport cancellation",
    (t) => setTag(t.spans[1], "antnest.error.code", "cancelled"),
  ],
  [
    "unknown Identity error",
    (t) => setTag(t.spans[2], "antnest.error.code", "internal_error"),
  ],
  [
    "server ERROR status",
    (t) => setTag(t.spans[2], "otel.status_code", "ERROR"),
  ],
  ["unrelated SQL failure", (t) => setTag(t.spans[3], "error", true)],
  ["unrelated Gateway failure", (t) => setTag(t.spans[0], "error", true)],
  [
    "private SQL parameters",
    (t) => setTag(t.spans[3], "db.query.parameters", "private-canary"),
  ],
])
  test(`lifecycle refuses ${name}`, () => {
    const trace = fixture();
    mutate(trace);
    assert.throws(() =>
      inspectLifecycleTrace(trace, expected, ["private-canary"]),
    );
  });

test("success cannot absorb expected or source-trace errors", () => {
  const success = { ...expected, status: 200, errorCode: undefined };
  const trace = fixture(success);
  assert.equal(inspectLifecycleTrace(trace, success, []).unexpected_errors, 0);
  setTag(trace.spans[3], "error", true);
  assert.throws(() => inspectLifecycleTrace(trace, success, []));
  const primary = fixture();
  const source = fixture(success);
  source.traceID = "b".repeat(32);
  for (const span of source.spans) {
    span.traceID = source.traceID;
    for (const ref of span.references) ref.traceID = source.traceID;
  }
  setTag(source.spans[3], "error", true);
  assert.throws(() =>
    inspectLifecycleTrace(primary, expected, [], {
      traces: new Map([
        [primary.traceID, primary],
        [source.traceID, source],
      ]),
    }),
  );
});

test("raw warning diagnostics are preserved for explicit review", async () => {
  const trace = fixture();
  trace.spans[2].warnings = ["raw clock diagnostic"];
  const reports = await verifyIdentityEvidence(
    "http://fixture",
    [expected],
    [],
    {
      inspect: inspectLifecycleTrace,
      wait: async () => {},
      attempts: 3,
      request: async () => Response.json({ data: [trace] }),
    },
  );
  assert.equal(reports[0].warning_count, 1);
  assert.equal(reports[0].strict_trace, "failed");
  assert.equal(trace.spans[2].warnings[0], "raw clock diagnostic");
});

for (const [name, mutate] of [
  ["unfinished forwarding span", (t) => delete t.spans[1].duration],
  [
    "truncated forwarding body",
    (t) => setTag(t.spans[1], "http.response.body.size", 12),
  ],
  [
    "missing forwarding byte count",
    (t) => {
      t.spans[1].tags = t.spans[1].tags.filter(
        (field) => field.key !== "http.response.body.size",
      );
    },
  ],
  [
    "inserted internal ancestor",
    (t) => {
      t.spans.push({
        traceID,
        spanID: "interposed",
        processID: "edge",
        operationName: "unrelated",
        tags: fields({ "span.kind": "internal" }),
        references: [{ refType: "CHILD_OF", traceID, spanID: "root" }],
      });
      t.spans[1].references[0].spanID = "interposed";
    },
  ],
])
  test(`lifecycle refuses ${name} on an otherwise successful request`, () => {
    const success = { ...expected, status: 200, errorCode: undefined };
    const trace = fixture(success);
    mutate(trace);
    assert.throws(() => inspectLifecycleTrace(trace, success, []));
  });

function consoleFixture(shared = true) {
  const all = recoveryHTTPFixture();
  const part = all.parts.find((item) => item.action === "role");
  const trace = part.trace;
  if (shared) {
    const source = sharedResolutionFixture();
    part.decision.tags = structuredClone(source.decision.tags);
    setTag(part.decision, "antnest.identity.resolve.profile", "console");
    part.decision.references = source.decision.references.map((ref) => ({
      ...ref,
      ...(ref.refType === "CHILD_OF" ? { traceID: trace.traceID } : {}),
    }));
    for (const [id, value] of source.traces) {
      if (id === source.trace.traceID) continue;
      for (const span of value.spans) {
        if (tag(span, "antnest.identity.resolve.profile"))
          setTag(span, "antnest.identity.resolve.profile", "console");
        if (span.spanID === "root")
          setTag(span, "http.route", "/api/admin/directory");
      }
      all.traces.set(id, value);
    }
  }
  const expected = {
    traceID: trace.traceID,
    console: true,
    consoleRoute: "/api/admin/directory/memberships/{membership_id}",
    route: "/rpc/identity/update-membership",
    rpcMethod: "update_membership",
    method: "POST",
    status: 200,
    clientService: "admin-console",
    resolveProfile: "console",
    resolveTTLms: 10000,
    responseBytes: 128,
  };
  for (const span of trace.spans)
    if (tag(span, "http.request.method"))
      setTag(span, "http.response.body.size", 128);
  const traces = new Map();
  const visit = (id) => {
    if (traces.has(id)) return;
    const value = all.traces.get(id);
    assert(value);
    traces.set(id, value);
    for (const span of value.spans)
      for (const ref of span.references ?? [])
        if (ref.refType === "FOLLOWS_FROM") visit(ref.traceID);
  };
  visit(trace.traceID);
  return {
    trace,
    expected,
    options: { traces, archivedTraceIDs: new Set(traces.keys()) },
  };
}

test("real Console chain shape includes the archived Resolve source", () => {
  const f = consoleFixture();
  const result = inspectLifecycleTrace(f.trace, f.expected, [], f.options);
  assert.equal(result.http_hops, 5);
  assert.equal(result.unexpected_errors, 0);
  assert(result.gateway_resolution);
});
test("Console cache hit validates its budget without inventing a source link", () => {
  const f = consoleFixture(false);
  const result = inspectLifecycleTrace(f.trace, f.expected, [], f.options);
  assert.equal(result.gateway_resolution.source, "cache");
  assert.equal(result.http_hops, 5);
});
for (const [name, mutate] of [
  [
    "Console status",
    (f) =>
      setTag(
        f.trace.spans.find((span) => span.spanID === "console-server"),
        "http.response.status_code",
        500,
      ),
  ],
  [
    "Console parent",
    (f) => {
      f.trace.spans.find(
        (span) => span.spanID === "console-server",
      ).references[0].spanID = "command-client";
    },
  ],
  [
    "Resolve profile",
    (f) => {
      f.expected.resolveProfile = "workspace";
    },
  ],
  ["missing source archive", (f) => f.options.archivedTraceIDs.clear()],
])
  test(`lifecycle refuses ${name}`, () => {
    const f = consoleFixture();
    mutate(f);
    assert.throws(() =>
      inspectLifecycleTrace(f.trace, f.expected, [], f.options),
    );
  });

function asyncReceiptFixture() {
  const expectation = {
    ...expected,
    method: "DELETE",
    status: 204,
    errorCode: undefined,
    responseBytes: 0,
  };
  const trace = fixture(expectation);
  const ids = new Map(
    trace.spans.map((s, index) => [
      s.spanID,
      String(index + 1).padStart(16, "0"),
    ]),
  );
  for (const [index, span] of trace.spans.entries()) {
    span.spanID = ids.get(span.spanID);
    span.startTime = 1000000 + index * 10;
    span.duration = (4 - index) * 1000;
    for (const ref of span.references) ref.spanID = ids.get(ref.spanID);
  }
  const server = trace.spans[2];
  expectation.scimTokenID = "scimtoken_44444444444444444444444444444444";
  setTag(server, "antnest.identity.token.id", expectation.scimTokenID);
  expectation.principalRevocation = {
    sequence: "17",
    user_id: "11111111-1111-4111-8111-111111111111",
    organization_id: "22222222-2222-4222-8222-222222222222",
    membership_id: "33333333-3333-4333-8333-333333333333",
    reason: "membership_deleted",
    traceparent: `00-${traceID}-${server.spanID}-01`,
  };
  setTag(
    server,
    "antnest.organization.id",
    expectation.principalRevocation.organization_id,
  );
  setTag(
    server,
    "antnest.identity.resource.id",
    expectation.principalRevocation.membership_id,
  );
  trace.processes.controller = { serviceName: "agent-controller" };
  const warning =
    "clock skew adjustment disabled; not applying calculated delta of -1.848160342s";
  const add = (processID, operationName, parent, startTime, duration, tags) => {
    const span = {
      traceID,
      spanID: (trace.spans.length + 1).toString(16).padStart(16, "0"),
      processID,
      operationName,
      startTime,
      duration,
      references: [{ refType: "CHILD_OF", traceID, spanID: parent.spanID }],
      tags: fields(tags),
      ...(processID === "controller" ? { warnings: [warning] } : {}),
    };
    trace.spans.push(span);
    return span;
  };
  const transaction = (process, parent, start, duration) =>
    add(process, "postgresql transaction", parent, start, duration, {
      "span.kind": "internal",
      "db.system.name": "postgresql",
      "otel.scope.name":
        process === "identity"
          ? "identity_service.database"
          : "agent_controller.database",
      "antnest.transaction.outcome": "committed",
    });
  const sql = (parent, statement, rows, offset) =>
    add(
      parent.processID,
      statement.split(" ")[0].toUpperCase(),
      parent,
      parent.startTime + offset,
      10,
      {
        "span.kind": "client",
        "db.system.name": "postgresql",
        "otel.scope.name": "github.com/exaring/otelpgx",
        "db.operation.name": statement.split(" ")[0].toUpperCase(),
        "db.query.text": statement,
        "pgx.rows_affected": rows,
      },
    );
  const sourceTransaction = transaction("identity", server, 1000120, 1500);
  const sourceSQL = {
    begin: sql(sourceTransaction, "begin", 0, 10),
    lock: sql(
      sourceTransaction,
      "LOCK TABLE principal_revocations IN SHARE ROW EXCLUSIVE MODE",
      0,
      100,
    ),
    insert: sql(
      sourceTransaction,
      "INSERT INTO principal_revocations (user_id, organization_id, reason, occurred_at, traceparent) VALUES ($1, NULLIF($2, ''), $3, $4, $5)",
      1,
      200,
    ),
    commit: sql(sourceTransaction, "commit", 0, 1400),
  };
  const receive = add(
    "controller",
    "agent_controller.identity_offboarding.receive",
    server,
    3000000,
    5000,
    {
      "span.kind": "consumer",
      "otel.scope.name":
        "github.com/tf4fun/antnest-platform/agent-controller/identity-offboarding",
      "identity.revocation.sequence": 17,
    },
  );
  const receiptTransaction = transaction("controller", receive, 3000010, 4900);
  const receiptSQL = Object.fromEntries(
    [
      ["begin", "begin", 0],
      [
        "cursor",
        "SELECT last_sequence FROM agent_controller.identity_revocation_cursor WHERE singleton FOR UPDATE",
        1,
      ],
      [
        "organizations",
        "SELECT DISTINCT organization_id FROM agent_controller.agents WHERE owner_user_id=$1 AND ($2='' OR organization_id=$2) AND lifecycle_state<>'deleted' AND owner_authorization_sequence<$3 AND identity_revocation_sequence<$3",
        0,
      ],
      [
        "locks",
        "SELECT DISTINCT hashtext(organization_id) AS key FROM unnest($1::text[]) AS organization_id ORDER BY key",
        0,
      ],
      [
        "owner",
        "INSERT INTO agent_controller.owner_revocations (user_id, organization_id, sequence, reason, occurred_at, trace_parent) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, organization_id) DO UPDATE SET sequence=EXCLUDED.sequence, reason=EXCLUDED.reason, occurred_at=EXCLUDED.occurred_at, trace_parent=EXCLUDED.trace_parent",
        1,
      ],
      [
        "agents",
        "SELECT id, organization_id, aggregate_sequence, owner_authorization_sequence, identity_revocation_sequence, desired_state FROM agent_controller.agents WHERE owner_user_id=$1 AND ($2='' OR organization_id=$2) AND lifecycle_state <> 'deleted' AND owner_authorization_sequence < $3 AND identity_revocation_sequence < $3 ORDER BY id FOR UPDATE",
        0,
      ],
      [
        "advance",
        "UPDATE agent_controller.identity_revocation_cursor SET last_sequence=$1 WHERE singleton",
        1,
      ],
      ["commit", "commit", 0],
    ].map(([name, statement, rows], index) => [
      name,
      sql(receiptTransaction, statement, rows, 20 + index * 100),
    ]),
  );
  return {
    trace,
    expected: expectation,
    server,
    sourceTransaction,
    sourceSQL,
    receive,
    receiptTransaction,
    receiptSQL,
    warning,
  };
}

test("SCIM DELETE requires its committed async receipt and preserves all raw diagnostics", async () => {
  const f = asyncReceiptFixture(),
    original = structuredClone(f.trace);
  const [report] = await verifyIdentityEvidence(
    "http://fixture",
    [f.expected],
    [],
    {
      inspect: inspectLifecycleTrace,
      wait: async () => {},
      attempts: 3,
      request: async () => Response.json({ data: [f.trace] }),
    },
  );
  assert.equal(report.reviewed_warnings.length, 10);
  assert.equal(report.unreviewed_warning_count, 0);
  assert.equal(report.warning_count, 10);
  assert.equal(report.strict_trace, "failed");
  assert.equal(report.principal_revocation.sequence, "17");
  assert.equal(report.principal_revocation.receive_span_id, f.receive.spanID);
  assert.equal(report.principal_revocation.receipt_database_spans, 8);
  assert.deepEqual(f.trace, original);
});

for (const [name, mutate] of [
  [
    "missing receipt",
    (f) =>
      (f.trace.spans = f.trace.spans.filter(
        (s) => s.processID !== "controller",
      )),
  ],
  [
    "missing source feed",
    (f) => f.trace.spans.splice(f.trace.spans.indexOf(f.sourceSQL.insert), 1),
  ],
  [
    "source rollback",
    (f) =>
      setTag(f.sourceTransaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  [
    "source feed without insert",
    (f) => setTag(f.sourceSQL.insert, "pgx.rows_affected", 0),
  ],
  [
    "ambiguous source SQL",
    (f) =>
      f.sourceSQL.insert.tags.push({ key: "db.query.text", value: "SELECT 1" }),
  ],
  [
    "ambiguous receipt SQL",
    (f) =>
      f.receiptSQL.owner.tags.push({ key: "db.query.text", value: "SELECT 1" }),
  ],
  [
    "non-string receipt SQL",
    (f) =>
      setTag(f.receiptSQL.owner, "db.query.text", [
        tag(f.receiptSQL.owner, "db.query.text"),
      ]),
  ],
  [
    "wrong authorizing token",
    (f) => setTag(f.server, "antnest.identity.token.id", "scimtoken_other"),
  ],
  [
    "wrong organization",
    (f) =>
      (f.expected.principalRevocation.organization_id =
        "44444444-4444-4444-8444-444444444444"),
  ],
  [
    "wrong membership",
    (f) =>
      (f.expected.principalRevocation.membership_id =
        "44444444-4444-4444-8444-444444444444"),
  ],
  [
    "wrong source trace",
    (f) =>
      (f.expected.principalRevocation.traceparent = `00-${"b".repeat(32)}-${f.server.spanID}-01`),
  ],
  [
    "wrong source span",
    (f) =>
      (f.expected.principalRevocation.traceparent = `00-${traceID}-ffffffffffffffff-01`),
  ],
  [
    "wrong sequence",
    (f) => setTag(f.receive, "identity.revocation.sequence", 18),
  ],
  [
    "unsafe sequence",
    (f) =>
      setTag(
        f.receive,
        "identity.revocation.sequence",
        Number.MAX_SAFE_INTEGER + 1,
      ),
  ],
  ["wrong kind", (f) => setTag(f.receive, "span.kind", "internal")],
  ["wrong scope", (f) => setTag(f.receive, "otel.scope.name", "other")],
  [
    "wrong direct parent",
    (f) => (f.receive.references[0].spanID = f.trace.spans[0].spanID),
  ],
  [
    "missing parent",
    (f) => (f.receive.references[0].spanID = "ffffffffffffffff"),
  ],
  [
    "receipt rollback",
    (f) =>
      setTag(
        f.receiptTransaction,
        "antnest.transaction.outcome",
        "rolled_back",
      ),
  ],
  [
    "missing receipt commit",
    (f) => f.trace.spans.splice(f.trace.spans.indexOf(f.receiptSQL.commit), 1),
  ],
  [
    "cursor not advanced",
    (f) => setTag(f.receiptSQL.advance, "pgx.rows_affected", 0),
  ],
  [
    "owner not persisted",
    (f) => setTag(f.receiptSQL.owner, "pgx.rows_affected", 0),
  ],
  ["SQL error", (f) => setTag(f.receiptSQL.owner, "error", true)],
])
  test(`SCIM async receipt rejects ${name}`, () => {
    const f = asyncReceiptFixture();
    mutate(f);
    assert.throws(() => inspectLifecycleTrace(f.trace, f.expected, []));
  });

test("SCIM receipt classification leaves side-branch and non-clock warnings unreviewed", () => {
  const f = asyncReceiptFixture();
  f.server.warnings = [f.warning];
  f.receiptSQL.owner.warnings.push("unrelated receipt diagnostic");
  const report = inspectLifecycleTrace(f.trace, f.expected, []);
  assert.equal(report.reviewed_warnings.length, 10);
  assert.equal(report.unreviewed_warning_count, 2);
});

for (const name of ["conflicting deltas", "negative zero"]) {
  test(`SCIM receipt leaves ${name} unreviewed`, () => {
    const f = asyncReceiptFixture();
    const prefix =
      "clock skew adjustment disabled; not applying calculated delta of ";
    if (name === "conflicting deltas") f.receive.warnings.push(`${prefix}-5s`);
    else
      for (const span of f.trace.spans.filter(
        (s) => s.processID === "controller",
      ))
        span.warnings = [`${prefix}-0s`];
    const report = inspectLifecycleTrace(f.trace, f.expected, []);
    assert.equal(report.reviewed_warnings.length, 0);
    assert(report.unreviewed_warning_count > 0);
  });
}

test("SCIM receipt leaves a non-string warning unreviewed", () => {
  const f = asyncReceiptFixture();
  for (const span of f.trace.spans) span.warnings = [];
  f.receive.warnings = [[f.warning]];
  const original = structuredClone(f.trace);
  const report = inspectLifecycleTrace(f.trace, f.expected, []);
  assert.equal(report.reviewed_warnings.length, 0);
  assert.equal(report.unreviewed_warning_count, 1);
  assert.deepEqual(f.trace, original);
});

test("SCIM collection waits for the declared receipt even after three identical HTTP-only snapshots", async () => {
  const f = asyncReceiptFixture(),
    early = structuredClone(f.trace);
  early.spans = early.spans.filter((s) => s.processID !== "controller");
  let reads = 0;
  const [report] = await verifyIdentityEvidence(
    "http://fixture",
    [f.expected],
    [],
    {
      inspect: inspectLifecycleTrace,
      wait: async () => {},
      attempts: 6,
      request: async () =>
        Response.json({ data: [++reads <= 3 ? early : f.trace] }),
    },
  );
  assert.equal(reads, 6);
  assert.equal(report.principal_revocation.receive_span_id, f.receive.spanID);
});

test("a late receipt SQL error prevents full-snapshot convergence", async () => {
  const f = asyncReceiptFixture();
  let reads = 0;
  await assert.rejects(
    verifyIdentityEvidence("http://fixture", [f.expected], [], {
      inspect: inspectLifecycleTrace,
      wait: async () => {},
      attempts: 4,
      request: async () => {
        const trace = structuredClone(f.trace);
        if (++reads >= 3)
          setTag(
            trace.spans.find((s) => s.spanID === f.receiptSQL.owner.spanID),
            "error",
            true,
          );
        return Response.json({ data: [trace] });
      },
    }),
    /unclassified lifecycle/u,
  );
  assert.equal(reads, 4);
});
