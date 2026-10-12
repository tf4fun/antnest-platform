import assert from "node:assert/strict";
import test from "node:test";
import { inspectTemplateTrace } from "./template-trace.mjs";
import { inspectEgressDatabaseTrace } from "./egress-database-trace.mjs";
import { consoleObservationFixture } from "./console-observation-fixtures.mjs";
import { resolvePrefix, setTag } from "./gateway-resolution-fixtures.mjs";
import { fields } from "./trace-fixtures.mjs";

const span = (f, id) => f.trace.spans.find((s) => s.spanID === id);
function check(f) {
  if (f.kind === "template") {
    const { result, transactions } = inspectTemplateTrace(
      f.trace,
      f.expected,
      f,
    );
    return { ...result, transactions: transactions.length };
  }
  return inspectEgressDatabaseTrace(f.trace, f.values, f.expected, f);
}

for (const kind of ["template", "egress"])
  for (const source of ["rpc", "cache", "shared", "shared-background"])
    test(`${kind} preserves its owning SQL flow with ${source} Resolve`, () => {
      const f = consoleObservationFixture(kind, source);
      const result = check(f);
      assert.equal(result.transactions, 1);
      assert.equal(
        result.gateway_resolution.source,
        source.startsWith("shared") ? "shared" : source,
      );
      assert.equal(result.gateway_resolution.profile, "console");
      assert.equal(
        result.gateway_resolution.database_spans,
        source === "cache" ? 0 : 1,
      );
      assert.equal(
        result.hops.some((hop) => hop.to === "identity-service"),
        source === "rpc",
      );
      assert.equal(
        result.diagnostic_events,
        (source === "rpc" ? 2 : 0) + (kind === "egress" ? 4 : 0),
      );
      if (kind === "egress") {
        assert.equal(result.egress_sql, 9);
        assert.equal(result.transaction_primitives, 5);
        assert.equal(result.policy_unchanged, true);
      }
    });

for (const kind of ["template", "egress"]) {
  for (const [name, mutate] of [
    [
      "missing decision",
      (f) => {
        f.trace.spans = f.trace.spans.filter((s) => s !== f.decision);
      },
    ],
    [
      "wrong profile",
      (f) => setTag(f.decision, resolvePrefix + "profile", "workspace"),
    ],
    [
      "wrong TTL",
      (f) => {
        f.expected.resolveTTLMS = 1;
      },
    ],
    [
      "duplicate decision",
      (f) =>
        f.trace.spans.push({
          ...structuredClone(f.decision),
          spanID: "another-decision",
        }),
    ],
    [
      "wrong Console route",
      (f) => setTag(span(f, "console"), "http.route", "/api/admin/agents"),
    ],
    [
      "caller-selected unrelated route",
      (f) => {
        f.expected.consoleRoute = "/api/admin/agents";
        setTag(span(f, "console"), "http.route", f.expected.consoleRoute);
      },
    ],
    [
      "wrong Controller parent",
      (f) => {
        span(f, "controller-server").references[0].spanID = "upstream";
      },
    ],
    [
      "missing SQL text",
      (f) => {
        for (const s of f.trace.spans)
          if (["controller", "egress"].includes(s.processID))
            setTag(s, "db.query.text", undefined);
      },
    ],
    [
      "missing transaction",
      (f) => {
        f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "transaction");
      },
    ],
    [
      "rolled back transaction",
      (f) =>
        setTag(
          span(f, "transaction"),
          "antnest.transaction.outcome",
          "rolled_back",
        ),
    ],
    [
      "foreign service SQL",
      (f) => {
        span(
          f,
          f.kind === "template" ? "catalog-write" : "inside-0",
        ).processID = "console";
      },
    ],
    [
      "SQL parameters",
      (f) =>
        setTag(span(f, "transaction"), "db.query.parameters", "private-value"),
    ],
  ])
    test(`${kind} rejects ${name} even on a cache hit`, () => {
      const f = consoleObservationFixture(kind);
      mutate(f);
      assert.throws(() => check(f));
    });

  for (const source of ["rpc", "shared", "shared-background"])
    test(`${kind} rejects failed actual Resolve SQL from ${source}`, () => {
      const f = consoleObservationFixture(kind, source);
      const actual = [...f.traces.values()].find((trace) =>
        trace.spans.some((s) => s.spanID === "sql"),
      );
      setTag(
        actual.spans.find((s) => s.spanID === "sql"),
        "otel.status_code",
        "ERROR",
      );
      assert.throws(() => check(f));
    });

  test(`${kind} requires explicit deployment configuration`, () => {
    const f = consoleObservationFixture(kind, "rpc");
    f.captureRpcContent = undefined;
    assert.throws(() => check(f));
    f.captureRpcContent = false;
    assert.throws(() => check(f));
    for (const trace of f.traces.values())
      for (const s of trace.spans) s.logs = [];
    assert.equal(check(f).diagnostic_events, 0);
  });
}

for (const [name, mutate] of [
  [
    "wrong database",
    (f) => {
      f.values.database = "unrelated";
    },
  ],
  [
    "missing SELECT",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "inside-2");
    },
  ],
  [
    "query order",
    (f) => {
      span(f, "begin").startTime = span(f, "commit").startTime + 1;
    },
  ],
  [
    "detached query",
    (f) => {
      span(f, "inside-1").references[0].spanID = "egress-server";
    },
  ],
  ["failed query", (f) => setTag(span(f, "inside-1"), "error", true)],
  [
    "wrong SQL operation",
    (f) => setTag(span(f, "inside-1"), "db.operation.name", "UPDATE"),
  ],
  [
    "wrong database port type",
    (f) => setTag(span(f, "transaction"), "server.port", "5432"),
  ],
])
  test(`Egress retains ${name} rejection`, () => {
    const f = consoleObservationFixture("egress", "rpc");
    mutate(f);
    assert.throws(() => check(f));
  });

test("Template creation remains a metadata-only Controller boundary", () => {
  const f = consoleObservationFixture("template", "rpc");
  span(f, "controller-server").logs = [
    {
      fields: fields({
        event: "antnest.request",
        "antnest.payload.json": '{"credential":"must-not-be-captured"}',
      }),
    },
  ];
  assert.throws(() => check(f));
});
