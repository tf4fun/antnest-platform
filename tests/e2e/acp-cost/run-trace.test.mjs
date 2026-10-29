import assert from "node:assert/strict";
import test from "node:test";
import { tag } from "../observability/trace-tree.mjs";
import { costRunTraceFixture as fixture } from "./run-trace.fixture.mjs";

const url = new URL("./run-trace.mjs", import.meta.url);
const { inspectPrivateCostRunTrace: inspect } = await import(url).catch(
  (error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === url.href)
      return {};
    throw error;
  },
);
const available = () => assert.equal(typeof inspect, "function");
const check = (f) =>
  inspect(f.trace, f.expected, ["PRIVATE_COST_CANARY"], f.requests);
const remove = (f, span) => {
  f.trace.spans = f.trace.spans.filter((item) => item !== span);
};
const parent = (f, span, owner) => {
  span.references = [
    { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: owner.spanID },
  ];
};
const foreign = (f, span) => {
  const resource = structuredClone(f.trace.processes[span.processID]);
  resource.tags.find((field) => field.key === "process.pid").value++;
  f.trace.processes.foreign = resource;
  span.processID = "foreign";
};
const duplicate = (f, span) =>
  f.trace.spans.push({
    ...structuredClone(span),
    spanID: span.spanID + "-duplicate",
  });
const corrupt = (f, span, needle) => {
  const sql = tag(span, "db.query.text");
  assert(sql.includes(needle));
  f.set(span, "db.query.text", sql.replace(needle, ""));
};

const mutations = [
  ["missing admission", (f) => remove(f, f.admission)],
  ["Run bypasses admission", (f) => parent(f, f.run, f.request)],
  ["admission outside RPC", (f) => parent(f, f.admission, f.run)],
  ["foreign admission process", (f) => foreign(f, f.admission)],
  ["foreign admission Agent", (f) => f.set(f.admission, "agent.id", "foreign")],
  ...["agent.id", "antnest.agent.id"].map((field) => [
    `contradictory Run ${field}`,
    (f) => f.set(f.run, field, "foreign"),
  ]),
  [
    "foreign admission Session",
    (f) => f.set(f.admission, "session.id", "foreign"),
  ],
  [
    "admission wrong phase",
    (f) => f.set(f.admission, "antnest.operation.phase", "execute"),
  ],
  ["duplicate admission", (f) => duplicate(f, f.admission)],
  [
    "missing admission authorization read",
    (f) => remove(f, f.admissionQueries[0]),
  ],
  ["missing admission MCP read", (f) => remove(f, f.admissionQueries[1])],
  [
    "missing admission temporary scope check",
    (f) => remove(f, f.admissionQueries[2]),
  ],
  [
    "missing admission protection check",
    (f) => remove(f, f.admissionQueries[4]),
  ],
  [
    "admission SQL moved to RPC",
    (f) => parent(f, f.admissionQueries[0], f.request),
  ],
  ["admission SQL foreign process", (f) => foreign(f, f.admissionQueries[0])],
  ["missing intent transaction", (f) => remove(f, f.intent.span)],
  ["missing admitting Run insert", (f) => remove(f, f.intent.queries[3])],
  [
    "intent returns the full prompt body",
    (f) => {
      const sql = tag(f.intent.queries[3], "db.query.text");
      assert(sql.includes("pending_user_message_id, session_configuration"));
      f.set(
        f.intent.queries[3],
        "db.query.text",
        sql.replace(
          "pending_user_message_id, session_configuration",
          "pending_user_message_id, input_prompt, session_configuration",
        ),
      );
    },
  ],
  ["missing append version update", (f) => remove(f, f.intent.queries[4])],
  ["unlocked intent", (f) => corrupt(f, f.intent.queries[1], "FOR UPDATE")],
  ["intent moved to RPC", (f) => parent(f, f.intent.span, f.request)],
  ["intent foreign process", (f) => foreign(f, f.intent.span)],
  [
    "intent rollback",
    (f) => f.set(f.intent.span, "antnest.transaction.outcome", "rolled_back"),
  ],
  [
    "intent after acceptance",
    (f) => {
      f.intent.span.startTime += 400;
      for (const span of f.intent.queries) span.startTime += 400;
    },
  ],
  ["missing acceptance transaction", (f) => remove(f, f.acceptance.span)],
  [
    "acceptance reads the full prompt body",
    (f) =>
      f.set(
        f.acceptance.queries[3],
        "db.query.text",
        "SELECT session_id, client_mcp_revision_id, state, cancel_requested_at, pending_user_message_id, input_prompt FROM runs WHERE id = $1 FOR UPDATE",
      ),
  ],
  [
    "acceptance serializes the user message in the client",
    (f) =>
      f.set(
        f.acceptance.queries.at(-4),
        "db.query.text",
        "INSERT INTO session_messages( id, session_id, run_id, sequence, kind, visible, payload, created_at ) VALUES ($1, $2, $3, $4, 'user_message', true, $5::jsonb, $6)",
      ),
  ],
  [
    "missing accepted user message",
    (f) => remove(f, f.acceptance.queries.at(-4)),
  ],
  ["missing running transition", (f) => remove(f, f.acceptance.queries.at(-3))],
  [
    "missing acceptance Session update",
    (f) => remove(f, f.acceptance.queries.at(-2)),
  ],
  ["acceptance moved to RPC", (f) => parent(f, f.acceptance.span, f.request)],
  [
    "foreign acceptance SQL process",
    (f) => foreign(f, f.acceptance.queries[1]),
  ],
  ["duplicate environment fact", (f) => duplicate(f, f.acceptance.queries[4])],
  ["context missing calibration read", (f) => remove(f, f.context[0])],
  ["context missing checkpoint read", (f) => remove(f, f.context[1])],
  ["context missing pinned task read", (f) => remove(f, f.context[2])],
  ["context missing history read", (f) => remove(f, f.context[3])],
  ["context missing plan read", (f) => remove(f, f.context[4])],
  [
    "context calibration loses organization scope",
    (f) => corrupt(f, f.context[0], "organization_id=$1 AND "),
  ],
  [
    "context checkpoint loses compaction metadata",
    (f) =>
      corrupt(
        f,
        f.context[1],
        ", compaction_prompt_version, pinned_message_ids",
      ),
  ],
  [
    "context pinned task includes excluded history",
    (f) => corrupt(f, f.context[2], "AND NOT context_excluded "),
  ],
  ["context read detached", (f) => parent(f, f.context[0], f.request)],
  [
    "context history after model",
    (f) => {
      f.context[3].startTime = 11000;
    },
  ],
  [
    "missing final temporary scope read",
    (f) => remove(f, f.temporaryCleanupRead),
  ],
  ["missing catalog revision read", (f) => remove(f, f.catalogRevisionRead)],
  [
    "missing prompt receipt",
    (f) => {
      delete f.expected.promptReceipt;
    },
  ],
  [
    "wrong prompt wire ID",
    (f) => {
      f.expected.promptReceipt.requestId = "foreign";
    },
  ],
  [
    "wrong prompt Session",
    (f) => {
      f.expected.promptReceipt.sessionId = "foreign";
    },
  ],
  [
    "wrong input Session",
    (f) => {
      f.expected.inputSessionID = "foreign";
    },
  ],
  [
    "failed prompt",
    (f) => {
      f.expected.outcome = "failed";
    },
  ],
  [
    "unknown phase",
    (f) => {
      f.expected.phase = f.requests[0].phase = "v1-ws:not-a-cost-phase";
    },
  ],
  [
    "wrong protocol phase",
    (f) => {
      f.expected.phase = f.requests[0].phase = "v3-ws:estimated";
    },
  ],
  [
    "wrong Provider phase",
    (f) => {
      f.requests[0].phase += "-foreign";
    },
  ],
  [
    "foreign Provider Trace",
    (f) => {
      f.requests[0].trace_id = "f".repeat(32);
    },
  ],
  [
    "foreign Provider span",
    (f) => {
      f.requests[0].model_span_id = f.model.spanID;
    },
  ],
  [
    "wrong Provider model",
    (f) => {
      f.requests[0].model = "unknown-model";
    },
  ],
  [
    "wrong recorded model",
    (f) => f.set(f.model, "model.name", "unknown-model"),
  ],
  [
    "missing Provider receipt",
    (f) => {
      f.requests = [];
    },
  ],
  [
    "second Provider receipt",
    (f) => f.requests.push(structuredClone(f.requests[0])),
  ],
  ["second Provider span", (f) => duplicate(f, f.provider)],
  ["missing Run", (f) => remove(f, f.run)],
  ["second Run", (f) => duplicate(f, f.run)],
  ["missing internal Run ID", (f) => f.set(f.run, "antnest.request.id", "")],
  ["foreign Run Agent", (f) => f.set(f.run, "antnest.agent.id", "foreign")],
  ["foreign Run Session", (f) => f.set(f.run, "antnest.session.id", "foreign")],
  ["nonterminal Run", (f) => f.set(f.run, "run.terminal_class", "running")],
  ["live executor", (f) => f.set(f.run, "run.executor_state", "active")],
  [
    "unknown Tool effects",
    (f) => f.set(f.run, "run.tool_effect_state", "unknown"),
  ],
  [
    "Tool execution",
    (f) => f.add("tool", f.run.spanID, "runtime.mcp.tool", undefined, 12000),
  ],
  [
    "management call inside Run",
    (f) =>
      f.add("identity", f.run.spanID, "resolve", "identity-service", 12000),
  ],
  ["detached model", (f) => parent(f, f.model, f.request)],
  ["foreign model process", (f) => foreign(f, f.model)],
  ["detached Provider", (f) => parent(f, f.provider, f.run)],
  ["foreign Provider process", (f) => foreign(f, f.provider)],
  ["missing Runtime information read", (f) => remove(f, f.information.read)],
  [
    "failed Runtime close",
    (f) =>
      f.set(
        f.information.read,
        "antnest.mcp.connection.close.outcome",
        "failed",
      ),
  ],
  ["missing durable finish", (f) => remove(f, f.finish)],
  [
    "abbreviated finish CTE",
    (f) =>
      f.set(
        f.finish,
        "db.query.text",
        "WITH finished AS (UPDATE runs SET state = $2 RETURNING id) SELECT id FROM finished",
      ),
  ],
  ["detached finish", (f) => parent(f, f.finish, f.request)],
  ["foreign finish process", (f) => foreign(f, f.finish)],
  ["reply without BEGIN", (f) => remove(f, f.reply[0])],
  ["reply without COMMIT", (f) => remove(f, f.reply.at(-1))],
  ["reply without lock", (f) => remove(f, f.reply[2])],
  ["reply without sequence UPDATE", (f) => remove(f, f.reply[6])],
  ["reply without INSERT", (f) => remove(f, f.reply[5])],
  ["weak reply lock", (f) => corrupt(f, f.reply[2], "FOR UPDATE")],
  ["reply outside model", (f) => parent(f, f.transaction, f.run)],
  ["reply SQL outside transaction", (f) => parent(f, f.reply[5], f.model)],
  ["reply foreign process", (f) => foreign(f, f.reply[5])],
  [
    "reply rollback",
    (f) => f.set(f.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  ["duplicate reply transaction", (f) => duplicate(f, f.transaction)],
  ["usage missing", (f) => remove(f, f.usageTransaction)],
  ["usage inside model", (f) => parent(f, f.usageTransaction, f.model)],
  ["usage without prior accumulated cost", (f) => remove(f, f.usage[5])],
  ["usage without locked receipt check", (f) => remove(f, f.usage[4])],
  ["usage without COMMIT", (f) => remove(f, f.usage.at(-1))],
  ["usage SQL outside transaction", (f) => parent(f, f.usage[6], f.run)],
  [
    "unknown model CLIENT",
    (f) =>
      f.add(
        "extra-client",
        f.model.spanID,
        "HTTP GET unknown",
        undefined,
        13000,
        { "span.kind": "client" },
      ),
  ],
  [
    "foreign output Session",
    (f) => f.set(f.output, "antnest.session.id", "foreign"),
  ],
  ["output missing read", (f) => remove(f, f.outputQueries[1])],
  [
    "complete output subtree missing",
    (f) => {
      for (const span of [f.output, ...f.outputQueries]) remove(f, span);
    },
  ],
  ["output foreign SQL process", (f) => foreign(f, f.outputQueries[0])],
  [
    "output wrong phase",
    (f) => f.set(f.output, "antnest.operation.phase", "execute"),
  ],
  ["unknown error", (f) => f.set(f.finish, "otel.status_code", "ERROR")],
  [
    "unknown warning event",
    (f) => {
      f.finish.logs = [
        {
          timestamp: f.finish.startTime,
          fields: [{ key: "level", value: "WARN" }],
        },
      ];
    },
  ],
  [
    "captured private data",
    (f) => f.set(f.finish, "message", "PRIVATE_COST_CANARY"),
  ],
  ["captured payload", (f) => f.set(f.finish, "antnest.payload.json", "{}")],
  ...["run", "request", "admission"].flatMap((owner) =>
    [
      "DELETE FROM session_messages WHERE id = $1",
      "UPDATE acp_sessions SET last_message_sequence = 0 WHERE id = $1",
    ].map((sql) => [
      `unowned ${sql.split(" ")[0]} under ${owner}`,
      (f) =>
        f.add(
          `extra-sql-${owner}`,
          f[owner].spanID,
          sql.split(" ")[0],
          undefined,
          f[owner].startTime + 10,
          {
            "span.kind": "client",
            "db.system.name": "postgresql",
            "db.namespace": "antnest_agent_acp",
            "db.operation.name": sql.split(" ")[0],
            "db.query.text": sql,
          },
        ),
    ]),
  ),
  ...["request", "admission"].map((owner) => [
    `unowned transaction under ${owner}`,
    (f) =>
      f.add(
        `extra-transaction-${owner}`,
        f[owner].spanID,
        "postgresql transaction",
        undefined,
        f[owner].startTime + 10,
        {
          "span.kind": "internal",
          "db.system.name": "postgresql",
          "antnest.transaction.outcome": "committed",
        },
      ),
  ]),
];

for (const profile of [
  { version: 1 },
  { version: 2 },
  { http: true },
  { http: true, sameSpan: true },
]) {
  test(`Cost Run binds actual Provider, reply, usage and terminal ${JSON.stringify(profile)}`, () => {
    available();
    const f = fixture(profile);
    const raw = structuredClone([f.trace, f.expected, f.requests]);
    const report = check(f);
    assert.equal(report.runs, 1);
    assert.equal(report.provider_requests, 1);
    assert.equal(report.reply_transactions, 1);
    assert.equal(report.usage_transactions, 1);
    assert.equal(report.runtime_tool_calls, 0);
    assert.equal(report.model, "priced-model");
    assert.equal(report.run_request_id, tag(f.run, "antnest.request.id"));
    assert.notEqual(report.run_request_id, report.request_id);
    assert.deepEqual([f.trace, f.expected, f.requests], raw);
  });
  test(`Cost Run inherits Agent identity from its actual admission ${JSON.stringify(profile)}`, () => {
    available();
    const f = fixture(profile);
    f.run.tags = f.run.tags.filter(
      ({ key }) => !["agent.id", "antnest.agent.id"].includes(key),
    );
    const raw = structuredClone([f.trace, f.expected, f.requests]);
    assert.equal(check(f).runs, 1);
    assert.deepEqual([f.trace, f.expected, f.requests], raw);
  });
  for (const [name, mutate] of mutations)
    test(`Cost Run refuses ${name} ${JSON.stringify(profile)}`, () => {
      available();
      const f = fixture(profile);
      check(f);
      mutate(f);
      assert.throws(() => check(f));
    });
  test(`asynchronous output remains owned without fabricated parent joining ${JSON.stringify(profile)}`, () => {
    available();
    const f = fixture(profile);
    for (const span of [f.output, ...f.outputQueries]) span.startTime += 100000;
    const raw = structuredClone(f.trace);
    const report = check(f);
    assert.equal(report.output_reads, 1);
    assert.equal(report.asynchronous_output_reads.length, 1);
    assert.deepEqual(f.trace, raw);
  });
  test(`Run completion output retains its original admission context ${JSON.stringify(profile)}`, () => {
    available();
    const f = fixture(profile);
    check(f);
    parent(f, f.output, f.admission);
    for (const span of [f.output, ...f.outputQueries]) span.startTime += 100000;
    const raw = structuredClone(f.trace);
    const report = check(f);
    assert.equal(report.asynchronous_output_reads.length, 1);
    assert.equal(
      report.asynchronous_output_reads[0].parent_span_id,
      f.admission.spanID,
    );
    assert.deepEqual(f.trace, raw);
  });
  test(`Run starts before its admission span ends ${JSON.stringify(profile)}`, () => {
    available();
    const f = fixture(profile);
    f.admission.duration = 2000;
    const raw = structuredClone(f.trace);
    assert.equal(check(f).runs, 1);
    assert.deepEqual(f.trace, raw);
  });
  for (const environmentChange of [false, true])
    test(`Cost admission preserves optional environment fact ${environmentChange} ${JSON.stringify(profile)}`, () => {
      available();
      const f = fixture({ ...profile, environmentChange });
      const report = check(f);
      assert.equal(report.admission_transactions, 2);
      assert.equal(report.environment_facts, environmentChange ? 1 : 0);
    });
  test(`Cost context compaction preserves its exact owned checkpoint ${JSON.stringify(profile)}`, () => {
    available();
    const f = fixture({ ...profile, checkpoint: true });
    assert.equal(check(f).context_checkpoints, 1);
    f.checkpoint.startTime = 12000;
    assert.throws(() => check(f));
  });
  if (profile.http) {
    for (const [name, mutate] of [
      ["missing HTTP readiness", (f) => remove(f, f.readiness)],
      ["missing HTTP ready SELECT", (f) => remove(f, f.readyQuery)],
      [
        "readiness outside HTTP receiver",
        (f) => parent(f, f.readiness, f.admission),
      ],
      [
        "readiness SQL write",
        (f) => f.set(f.readyQuery, "db.query.text", "DELETE FROM runs"),
      ],
    ])
      test(`Cost Run refuses ${name} ${JSON.stringify(profile)}`, () => {
        available();
        const f = fixture(profile);
        check(f);
        mutate(f);
        assert.throws(() => check(f));
      });
  }
}
for (const action of [
  "unpriced",
  "unpriced-again",
  "fresh-unknown",
  "restored-unpriced",
])
  test(`Cost phase ${action} binds unknown-model without inventing zero price`, () => {
    available();
    const f = fixture({ action, model: "unknown-model" });
    assert.equal(check(f).model, "unknown-model");
    f.set(f.model, "model.name", "priced-model");
    f.requests[0].model = "priced-model";
    assert.throws(() => check(f));
  });
for (const action of [
  "estimated",
  "reported",
  "zero",
  "cache",
  "current-default",
  "selected",
  "fork",
  "post-restart",
  "restored-fork",
  "free",
  "cache-fallback",
  "observer",
  "admission",
  "after-admission",
])
  test(`Cost phase ${action} binds priced-model`, () => {
    available();
    assert.equal(check(fixture({ action })).model, "priced-model");
  });
