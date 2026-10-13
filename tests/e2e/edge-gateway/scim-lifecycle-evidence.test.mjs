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
