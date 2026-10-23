import assert from "node:assert/strict";
import test from "node:test";
import { inspect as showError } from "node:util";
import { tag } from "../observability/trace-tree.mjs";
import { costSessionTraceFixture as fixture } from "./session-trace.fixture.mjs";

const url = new URL("./session-trace.mjs", import.meta.url);
const { inspectPrivateCostSessionTrace: inspect } = await import(url).catch(
  (error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === url.href)
      return {};
    throw error;
  },
);
const available = () => assert.equal(typeof inspect, "function");
const check = (f) =>
  inspect(f.trace, f.expected, ["PRIVATE_SESSION_CANARY"], f.requests);
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
const mutations = [
  [
    "missing SDK receipt",
    (f) => {
      delete f.expected.requestReceipt;
    },
  ],
  [
    "wrong SDK wire ID",
    (f) => {
      f.expected.requestReceipt.requestId = "foreign";
    },
  ],
  [
    "wrong SDK workspace",
    (f) => {
      f.expected.requestReceipt.params.cwd = "/foreign";
    },
  ],
  [
    "missing model configuration",
    (f) => {
      delete f.expected.requestReceipt.result.configOptions;
    },
  ],
  [
    "wrong operation",
    (f) => {
      f.application.operationName = "acp.session.delete";
    },
  ],
  [
    "foreign application Agent",
    (f) => f.set(f.application, "agent.id", "foreign"),
  ],
  [
    "foreign configuration Session",
    (f) => f.set(f.configuration, "session.id", "foreign"),
  ],
  [
    "configuration moved into mutation",
    (f) => parent(f, f.configuration, f.application),
  ],
  ["missing configuration read", (f) => remove(f, f.configurationQueries[1])],
  ["missing committed transaction", (f) => remove(f, f.transaction)],
  [
    "rollback transaction",
    (f) => f.set(f.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  [
    "transaction outside application",
    (f) => parent(f, f.transaction, f.request),
  ],
  ["foreign transaction process", (f) => foreign(f, f.transaction)],
  ["missing COMMIT", (f) => remove(f, f.queries.at(-1))],
  ["SQL outside transaction", (f) => parent(f, f.queries[1], f.application)],
  ["foreign SQL process", (f) => foreign(f, f.queries[1])],
  [
    "unknown write",
    (f) =>
      f.add("extra", f.application.spanID, "DELETE", undefined, 5000, {
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.namespace": "antnest_agent_acp",
        "db.operation.name": "DELETE",
        "db.query.text": "DELETE FROM session_messages",
      }),
  ],
  [
    "complete output subtree missing",
    (f) => {
      for (const { application, queries } of f.outputs)
        for (const span of [application, ...queries]) remove(f, span);
    },
  ],
  [
    "foreign output Session",
    (f) => f.set(f.outputs[0].application, "antnest.session.id", "foreign"),
  ],
  ["output missing snapshot", (f) => remove(f, f.outputs[0].queries[1])],
  [
    "output write",
    (f) =>
      f.set(
        f.outputs[0].queries[1],
        "db.query.text",
        "UPDATE acp_sessions SET state='deleted'",
      ),
  ],
  ["unexpected Run", (f) => f.add("run", f.request.spanID, "agent.run")],
  [
    "unexpected Tool",
    (f) => f.add("tool", f.request.spanID, "runtime.mcp.tool"),
  ],
  ["Provider receipt", (f) => f.requests.push({ trace_id: "foreign" })],
  ["unowned error", (f) => f.set(f.queries[1], "otel.status_code", "ERROR")],
  [
    "private content",
    (f) => f.set(f.queries[1], "message", "PRIVATE_SESSION_CANARY"),
  ],
  ["payload capture", (f) => f.set(f.queries[1], "antnest.payload.json", "{}")],
];

for (const profile of [{ version: 1 }, { version: 2 }, { http: true }]) {
  for (const method of [
    "session/new",
    profile.version === 2 ? "session/resume" : "session/load",
    "session/fork",
  ]) {
    const options = { ...profile, method },
      label = JSON.stringify(options);
    if (method !== "session/new") {
      for (const mutation of ["missing", "owner columns", "row lock"])
        test(`Cost Session refuses altered Run guard (${mutation}) ${label}`, () => {
          const f = fixture(options);
          check(f);
          const guard = f.queries.find((span) =>
            tag(span, "db.query.text")?.includes(
              "execution_owner_registration_id",
            ),
          );
          assert(guard);
          if (mutation === "missing") remove(f, guard);
          else
            f.set(
              guard,
              "db.query.text",
              tag(guard, "db.query.text").replace(
                mutation === "owner columns"
                  ? "execution_owner_epoch::text"
                  : "FOR UPDATE",
                "",
              ),
            );
          assert.throws(() => check(f));
        });
    }
    test(`Cost Session owns actual receipt and persistence ${label}`, () => {
      available();
      const f = fixture(options);
      const raw = structuredClone([f.trace, f.expected]);
      const report = check(f);
      assert.equal(report.no_execution, true);
      assert.equal(report.session_transactions, 1);
      assert.equal(report.sql_parameters_observed, false);
      assert.deepEqual([f.trace, f.expected], raw);
    });
    for (const [name, mutate] of mutations)
      test(`Cost Session refuses ${name} ${label}`, () => {
        available();
        const f = fixture(options);
        check(f);
        mutate(f);
        assert.throws(() => check(f));
      });
    test(`Cost Session preserves additional asynchronous output ${label}`, () => {
      available();
      const outputReads =
        profile.version === 2 && method !== "session/resume" ? 3 : 2;
      const f = fixture({ ...options, outputReads });
      const additional = f.outputs.at(-1);
      for (const span of [additional.application, ...additional.queries])
        span.startTime += 100000;
      const raw = structuredClone(f.trace);
      const report = check(f);
      assert.equal(report.output_reads, outputReads);
      assert.equal(report.asynchronous_output_reads.length, 1);
      assert.deepEqual(f.trace, raw);
    });
    test(`Cost Session retains a selected profile and mode configuration ${label}`, () => {
      available();
      const f = fixture({ ...options, modelSelection: "profile:cost-priced" });
      assert.equal(check(f).model_selection, "profile:cost-priced");
    });
    if (method === "session/new" || method === "session/fork")
      test(`Cost Session rejects borrowed result Session ${label}`, () => {
        available();
        const f = fixture(options);
        check(f);
        f.expected.requestReceipt.result.sessionId = "foreign";
        assert.throws(() => check(f));
      });
    if (method === "session/fork") {
      for (const needle of [
        "NULL, sequence",
        "to_jsonb(copied_id)",
        "FROM context_checkpoints",
        "source.configuration - 'toolRules'",
      ])
        test(`Cost fork retains complete copy clause ${needle} ${label}`, () => {
          available();
          const f = fixture(options);
          check(f);
          const span = f.queries.find((span) =>
            tag(span, "db.query.text").includes(needle),
          );
          assert(span);
          f.set(
            span,
            "db.query.text",
            tag(span, "db.query.text").replace(needle, ""),
          );
          assert.throws(() => check(f));
        });
    }
    if (["session/load", "session/resume"].includes(method))
      test(`Cost replay keeps its snapshot outside unchanged MCP transaction ${label}`, () => {
        available();
        const f = fixture(options);
        assert.equal(check(f).replay_writes, 0);
        parent(f, f.direct[1], f.transaction);
        assert.throws(() => check(f));
      });
  }
}
test("Cost Session accepts its HTTP receiver reused as RPC", () => {
  available();
  check(fixture({ http: true, sameSpan: true, method: "session/fork" }));
});
test("Cost Session preserves optional complete Runtime catalog proof", () => {
  available();
  assert.equal(check(fixture({ catalog: true })).runtime_information_reads, 1);
});

for (const method of ["session/new", "session/fork"]) {
  for (const mutation of ["missing", "asynchronous", "overlapping"]) {
    test(`Cost v2 ${method} refuses ${mutation} required second output read`, () => {
      available();
      const f = fixture({ version: 2, method });
      check(f);
      const second = f.outputs[1];
      if (mutation === "missing") {
        for (const span of [second.application, ...second.queries])
          remove(f, span);
      } else {
        const delta = mutation === "asynchronous" ? 100000 : -2000;
        for (const span of [second.application, ...second.queries])
          span.startTime += delta;
      }
      assert.throws(() => check(f));
    });
  }
}
test("Cost v1 Session catalog cannot precede configuration", () => {
  available();
  const f = fixture({ catalog: true });
  check(f);
  const shifted = new Set([f.catalog.read.spanID]);
  for (const span of f.trace.spans) {
    if (
      !shifted.has(span.spanID) &&
      !span.references?.some((ref) => shifted.has(ref.spanID))
    )
      continue;
    shifted.add(span.spanID);
    span.startTime -= 23000;
    for (const event of span.logs ?? []) event.timestamp -= 23000;
  }
  assert.throws(() => check(f));
});
test("Cost v2 Session cannot invent a Skill catalog refresh", () => {
  available();
  assert.throws(() => check(fixture({ version: 2, catalog: true })));
});

for (const field of ["name", "currentValue", "cwd"]) {
  test(`Cost Session refuses SDK receipt secret in ${field} without exposing it`, () => {
    available();
    const f = fixture();
    check(f);
    if (field === "cwd")
      f.expected.requestReceipt.params.cwd = "PRIVATE_SESSION_CANARY";
    else
      f.expected.requestReceipt.result.configOptions[0][field] =
        "PRIVATE_SESSION_CANARY";
    let failure;
    try {
      check(f);
    } catch (error) {
      failure = error;
    }
    assert(failure, "SDK receipt secret was accepted");
    assert.equal(showError(failure).includes("PRIVATE_SESSION_CANARY"), false);
  });
}
for (const peer of ["identity-service", "unowned.invalid"]) {
  test(`Cost Session rejects unowned successful CLIENT to ${peer}`, () => {
    available();
    const f = fixture();
    check(f);
    f.add(
      "extra-client",
      f.application.spanID,
      "HTTP POST unowned",
      undefined,
      5000,
      {
        "span.kind": "client",
        "http.request.method": "POST",
        "http.response.status_code": 200,
        "peer.service": peer,
      },
    );
    assert.throws(() => check(f));
  });
}
