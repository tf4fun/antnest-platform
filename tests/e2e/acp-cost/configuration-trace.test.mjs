import assert from "node:assert/strict";
import test from "node:test";
import { tag } from "../observability/trace-tree.mjs";
import { costConfigurationTraceFixture as fixture } from "./configuration-trace.fixture.mjs";

const target = new URL("./configuration-trace.mjs", import.meta.url);
const { inspectPrivateCostConfigurationTrace: inspect } = await import(
  target.href
).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === target.href)
    return {};
  throw error;
});
const available = () => assert.equal(typeof inspect, "function");
const check = (f) => inspect(f.trace, f.expected, [], f.requests);
const parent = (f, span, owner) => {
  span.references = [
    { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: owner.spanID },
  ];
};
const remove = (f, id) => {
  f.trace.spans = f.trace.spans.filter((span) => span.spanID !== id);
};
const foreign = (f, span) => {
  const resource = structuredClone(f.trace.processes[span.processID]);
  resource.tags.find((field) => field.key === "process.pid").value++;
  f.trace.processes.foreign = resource;
  span.processID = "foreign";
};
const corruptSQL = (f, id, before, after = "") => {
  const span = f.query(id);
  const sql = tag(span, "db.query.text");
  assert(sql.includes(before), "mutation must change actual owning SQL");
  f.set(span, "db.query.text", sql.replace(before, after));
};

const common = [
  ["missing application", (f) => remove(f, "application")],
  [
    "duplicate application",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.application),
        spanID: "duplicate",
      }),
  ],
  ["foreign application process", (f) => foreign(f, f.application)],
  [
    "application outside RPC lifetime",
    (f) => {
      f.application.duration = 31000;
    },
  ],
  [
    "negative application duration",
    (f) => {
      f.application.duration = -1;
    },
  ],
  [
    "wrong projected Agent",
    (f) => f.set(f.application, "antnest.agent.id", "foreign"),
  ],
  ["wrong original Agent", (f) => f.set(f.application, "agent.id", "foreign")],
  [
    "wrong input Session",
    (f) => {
      f.expected.inputSessionID = "foreign";
    },
  ],
  ["unexpected Run", (f) => f.add("run", "request", "agent.run")],
  ["unexpected model", (f) => f.add("model", "request", "model.complete")],
  ["unexpected Tool", (f) => f.add("tool", "request", "runtime.mcp.tool")],
  [
    "foreign Provider receipt",
    (f) => f.requests.push({ trace_id: "foreign", phase: "foreign" }),
  ],
  [
    "unknown error event",
    (f) => {
      f.application.logs = [
        { timestamp: 4000, fields: [{ key: "event", value: "exception" }] },
      ];
    },
  ],
  [
    "payload capture in tags",
    (f) => f.set(f.application, "antnest.payload.json", "{}"),
  ],
  [
    "payload capture in events",
    (f) => {
      f.application.logs = [
        {
          timestamp: 4000,
          fields: [{ key: "antnest.payload.json", value: "{}" }],
        },
      ];
    },
  ],
  ["foreign SQL process", (f) => foreign(f, f.queries[0])],
  ["wrong SQL database", (f) => f.set(f.queries[0], "db.namespace", "other")],
  ["detached SQL", (f) => parent(f, f.queries[0], f.request)],
  [
    "extra write",
    (f) =>
      f.add("extra", "application", "DELETE", undefined, 6000, {
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.namespace": "antnest_agent_acp",
        "db.operation.name": "DELETE",
        "db.query.text": "DELETE FROM session_messages",
      }),
  ],
  [
    "failed original request",
    (f) => {
      f.expected.outcome = "failed";
    },
  ],
];
const configuration = [
  [
    "missing actual SDK receipt",
    (f) => {
      delete f.expected.configurationReceipt;
    },
  ],
  [
    "foreign actual RPC ID",
    (f) => {
      f.expected.configurationReceipt.requestId = "foreign";
    },
  ],
  [
    "foreign SDK Session",
    (f) => {
      f.expected.configurationReceipt.params.sessionId = "foreign";
    },
  ],
  [
    "wrong selection request",
    (f) => {
      f.expected.configurationReceipt.params.value = "agent_default";
    },
  ],
  [
    "wrong returned currentValue",
    (f) => {
      f.expected.configurationReceipt.result.configOptions[0].currentValue =
        "agent_default";
    },
  ],
  [
    "duplicate model option",
    (f) => {
      f.expected.configurationReceipt.result.configOptions.push(
        structuredClone(
          f.expected.configurationReceipt.result.configOptions[0],
        ),
      );
    },
  ],
  [
    "wrong application input Session",
    (f) => f.set(f.application, "session.id", "foreign"),
  ],
  [
    "transaction outside application",
    (f) => parent(f, f.transaction, f.request),
  ],
  ["foreign transaction process", (f) => foreign(f, f.transaction)],
  [
    "rolled back transaction",
    (f) => f.set(f.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  ["missing BEGIN", (f) => remove(f, "begin")],
  ["missing COMMIT", (f) => remove(f, "commit")],
  [
    "duplicate COMMIT",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.query("commit")),
        spanID: "second-commit",
      }),
  ],
  ["missing configuration message", (f) => remove(f, "insert")],
  ["missing configuration update", (f) => remove(f, "update")],
  [
    "weakened revision CAS",
    (f) => corruptSQL(f, "update", "AND configuration_revision = $2"),
  ],
  [
    "wrong message kind",
    (f) => corruptSQL(f, "insert", "'configuration'", "'assistant'"),
  ],
  [
    "insert outside transaction",
    (f) => parent(f, f.query("insert"), f.application),
  ],
  [
    "COMMIT before INSERT",
    (f) => {
      f.query("commit").startTime = f.query("insert").startTime - 2000;
    },
  ],
  [
    "unjoined SQL",
    (f) => {
      f.query("commit").duration = 10000;
    },
  ],
  ["missing ownership read", (f) => remove(f, "session-read")],
  [
    "wrong SQL operation",
    (f) => f.set(f.query("update"), "db.operation.name", "SELECT"),
  ],
];

for (const profile of [
  { name: "v1 WS" },
  { name: "v2 WS", version: 2 },
  { name: "v1 HTTP", http: true },
  { name: "v1 HTTP shared receiver", http: true, sameSpan: true },
]) {
  test(`${profile.name} binds real selection to committed configuration transaction`, () => {
    available();
    const f = fixture(profile);
    const before = structuredClone([f.trace, f.expected]);
    const result = check(f);
    assert.equal(result.configuration_committed, true);
    assert.equal(result.selection, f.expected.modelSelection);
    assert.equal(result.runs, 0);
    assert.equal(result.runtime_tool_calls, 0);
    assert.deepEqual(
      [f.trace, f.expected],
      before,
      "raw evidence was rewritten",
    );
  });
  for (const [name, mutate] of [...common, ...configuration])
    test(`${profile.name} refuses ${name}`, () => {
      available(); // Missing implementation must fail outside assert.throws.
      const f = fixture(profile);
      check(f);
      mutate(f);
      assert.throws(() => check(f));
    });
}

test("observer list binds actual sessions to scoped SELECT without a transaction", () => {
  available();
  const f = fixture({ method: "session/list" });
  const before = structuredClone([f.trace, f.expected]);
  const result = check(f);
  assert.equal(result.list_read_only, true);
  assert.deepEqual(result.list_session_ids, ["observer-session"]);
  assert.equal(result.runs, 0);
  assert.deepEqual([f.trace, f.expected], before);
});
for (const [name, mutate] of [
  ...common,
  [
    "list target Session",
    (f) => {
      f.expected.sessionId = "session";
      f.set(f.request, "antnest.session.id", "session");
    },
  ],
  [
    "list application Session",
    (f) => f.set(f.application, "antnest.session.id", "session"),
  ],
  [
    "missing list receipt",
    (f) => {
      delete f.expected.listReceipt;
    },
  ],
  [
    "foreign list RPC",
    (f) => {
      f.expected.listReceipt.requestId = "foreign";
    },
  ],
  [
    "different actual list filter",
    (f) => {
      f.expected.listReceipt.params.cwd = "/other";
    },
  ],
  [
    "foreign returned Session",
    (f) => {
      f.expected.listReceipt.result.sessions[0].sessionId = "foreign";
    },
  ],
  [
    "truncated list",
    (f) => {
      f.expected.listReceipt.result.nextCursor = "more";
    },
  ],
  [
    "missing principal scope",
    (f) => corruptSQL(f, "list", "principal_id = $1", "true"),
  ],
  ["missing Agent scope", (f) => corruptSQL(f, "list", "AND agent_id = $2")],
  [
    "missing organization scope",
    (f) => corruptSQL(f, "list", "AND organization_id = $7"),
  ],
])
  test(`observer list refuses ${name}`, () => {
    available();
    const f = fixture({ method: "session/list" });
    check(f);
    mutate(f);
    assert.throws(() => check(f));
  });

for (const profile of [{ version: 1 }, { version: 2 }, { http: true }]) {
  test(`configuration preserves every real output read ${JSON.stringify(profile)}`, () => {
    available();
    const f = fixture({ ...profile, outputReads: 3 });
    const before = structuredClone(f.trace);
    assert.equal(check(f).output_reads, 3);
    assert.deepEqual(f.trace, before);
  });
  for (const [name, mutate] of [
    [
      "foreign output Session",
      (f) => f.set(f.outputs[0].application, "antnest.session.id", "other"),
    ],
    ["foreign output process", (f) => foreign(f, f.outputs[0].application)],
    [
      "output nested in configuration",
      (f) => parent(f, f.outputs[0].application, f.application),
    ],
    ["output query missing", (f) => remove(f, f.outputs[0].queries[1].spanID)],
    [
      "output query moved to configuration",
      (f) => parent(f, f.outputs[0].queries[0], f.application),
    ],
    [
      "output includes write",
      (f) =>
        f.set(
          f.outputs[0].queries[1],
          "db.query.text",
          "UPDATE acp_sessions SET state='deleted'",
        ),
    ],
    [
      "output outlives RPC",
      (f) => {
        f.outputs[0].application.duration = 40000;
      },
    ],
  ])
    test(`configuration refuses ${name} ${JSON.stringify(profile)}`, () => {
      available();
      const f = fixture({ ...profile, outputReads: 3 });
      check(f);
      mutate(f);
      assert.throws(() => check(f));
    });
}
for (const version of [1, 2])
  test(`v${version} configuration requires its original pre-change output read`, () => {
    available();
    assert.throws(() => check(fixture({ version, outputReads: 0 })));
  });

for (const sameSpan of [false, true]) {
  test(`configuration retains actual HTTP readiness ${sameSpan}`, () => {
    available();
    const f = fixture({ http: true, sameSpan });
    const raw = structuredClone(f.trace);
    assert.equal(check(f).http_readiness_checks, 1);
    assert.deepEqual(f.trace, raw);
  });
  for (const [name, mutate] of [
    [
      "missing ready subtree",
      (f) => {
        remove(f, f.readiness.spanID);
        remove(f, f.readyQuery.spanID);
      },
    ],
    ["missing ready SELECT", (f) => remove(f, f.readyQuery.spanID)],
    ["wrong ready parent", (f) => parent(f, f.readiness, f.application)],
    ["foreign ready process", (f) => foreign(f, f.readiness)],
    [
      "write as readiness",
      (f) => f.set(f.readyQuery, "db.query.text", "DELETE FROM runs"),
    ],
    [
      "duplicate ready query",
      (f) =>
        f.trace.spans.push({
          ...structuredClone(f.readyQuery),
          spanID: "ready-extra",
        }),
    ],
  ])
    test(`configuration HTTP readiness refuses ${name} ${sameSpan}`, () => {
      available();
      const f = fixture({ http: true, sameSpan });
      check(f);
      mutate(f);
      assert.throws(() => check(f));
    });
}
