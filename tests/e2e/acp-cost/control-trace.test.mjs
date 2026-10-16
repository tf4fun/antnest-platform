import assert from "node:assert/strict";
import test from "node:test";
import { inspect as showError } from "node:util";
import { costControlTraceFixture as fixture } from "./control-trace.fixture.mjs";

const url = new URL("./control-trace.mjs", import.meta.url);
const { inspectPrivateCostControlTrace: inspect } = await import(url).catch(
  (error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === url.href)
      return {};
    throw error;
  },
);
const available = () => assert.equal(typeof inspect, "function");
const check = (f) =>
  inspect(f.trace, f.expected, ["PRIVATE_CONTROL_CANARY"], f.requests);
const remove = (f, span) => {
  f.trace.spans = f.trace.spans.filter((s) => s !== span);
};
const parent = (f, span, owner) => {
  span.references = [
    { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: owner.spanID },
  ];
};
const mutations = [
  ["Provider receipt", (f) => f.requests.push({ trace_id: "foreign" })],
  ["Run", (f) => f.add("run", f.request.spanID, "agent.run")],
  ["Tool", (f) => f.add("tool", f.request.spanID, "runtime.mcp.tool")],
  [
    "extra application",
    (f) => f.add("output", f.request.spanID, "acp.session.output"),
  ],
  [
    "unowned successful CLIENT",
    (f) =>
      f.add(
        "client",
        f.request.spanID,
        "HTTP POST identity-service",
        undefined,
        5000,
        { "span.kind": "client", "http.response.status_code": 200 },
      ),
  ],
  [
    "unowned transaction",
    (f) =>
      f.add("tx", f.request.spanID, "postgresql transaction", undefined, 5000, {
        "span.kind": "internal",
        "db.system.name": "postgresql",
        "antnest.transaction.outcome": "committed",
      }),
  ],
  [
    "unowned SQL",
    (f) =>
      f.add("query", f.request.spanID, "SELECT", undefined, 5000, {
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.namespace": "antnest_agent_acp",
        "db.operation.name": "SELECT",
        "db.query.text": "SELECT 1",
      }),
  ],
  ["payload", (f) => f.set(f.request, "antnest.payload.json", "{}")],
  [
    "private content",
    (f) => f.set(f.request, "message", "PRIVATE_CONTROL_CANARY"),
  ],
  [
    "wrong outcome",
    (f) => {
      f.expected.outcome = "failed";
    },
  ],
];
for (const profile of [{ version: 1 }, { version: 2 }, { http: true }]) {
  for (const method of [
    "initialize",
    "session/new",
    profile.version === 2 ? "session/resume" : "session/load",
    "session/fork",
    "session/prompt",
  ]) {
    const options = { ...profile, method },
      label = JSON.stringify(options);
    test(`Cost control binds actual initialization or rejection ${label}`, () => {
      available();
      const f = fixture(options),
        raw = structuredClone([f.trace, f.expected]);
      const report = check(f);
      assert.equal(report.no_execution, true);
      assert.equal(report.session_transactions, 0);
      assert.equal(
        report.database_queries,
        (profile.http ? 1 : 0) +
          (method !== "initialize" && method !== "session/new" ? 1 : 0),
      );
      assert.deepEqual([f.trace, f.expected], raw);
    });
    for (const [name, mutate] of mutations)
      test(`Cost control rejects ${name} ${label}`, () => {
        available();
        const f = fixture(options);
        check(f);
        mutate(f);
        assert.throws(() => check(f));
      });
    if (method === "initialize") {
      for (const fault of [
        "missing result",
        "wrong version",
        "wrong agent",
        "missing capability",
        "secret receipt",
      ]) {
        test(`Cost initialization rejects ${fault} ${label}`, () => {
          available();
          const f = fixture(options);
          check(f);
          const result = f.expected.initializationResult;
          if (fault === "missing result")
            delete f.expected.initializationResult;
          if (fault === "wrong version") result.protocolVersion = 999;
          if (fault === "wrong agent")
            (result.agentInfo ?? result.info).name = "foreign";
          if (fault === "missing capability") {
            delete result.agentCapabilities;
            delete result.capabilities;
          }
          if (fault === "secret receipt")
            (result.agentInfo ?? result.info).name = "PRIVATE_CONTROL_CANARY";
          let error;
          try {
            check(f);
          } catch (failure) {
            error = failure;
          }
          assert(error);
          assert.equal(
            showError(error).includes("PRIVATE_CONTROL_CANARY"),
            false,
          );
        });
      }
    } else {
      for (const fault of [
        "missing receipt",
        "wrong retryability",
        "missing application",
        "wrong Session",
        "wrong origin",
      ]) {
        test(`Cost rejection refuses ${fault} ${label}`, () => {
          available();
          const f = fixture(options);
          check(f);
          if (fault === "missing receipt") delete f.expected.rejectionReceipt;
          if (fault === "wrong retryability")
            f.expected.rejectionReceipt.retryable = true;
          if (fault === "missing application") remove(f, f.application);
          if (fault === "wrong Session")
            f.set(f.application, "antnest.session.id", "foreign");
          if (fault === "wrong origin")
            f.set(f.request, "antnest.error.origin_span_id", "foreign");
          assert.throws(() => check(f));
        });
      }
      if (method !== "session/new") {
        for (const fault of [
          "missing",
          "wrong SQL",
          "wrong owner",
          "foreign process",
        ]) {
          test(`Cost rejection refuses ${fault} authorization SELECT ${label}`, () => {
            available();
            const f = fixture(options);
            check(f);
            if (fault === "missing") remove(f, f.authorization);
            if (fault === "wrong SQL")
              f.set(f.authorization, "db.query.text", "SELECT 1");
            if (fault === "wrong owner") parent(f, f.authorization, f.request);
            if (fault === "foreign process") {
              f.trace.processes.foreign = structuredClone(
                f.trace.processes[f.authorization.processID],
              );
              f.trace.processes.foreign.tags.find(
                (tag) => tag.key === "process.pid",
              ).value++;
              f.authorization.processID = "foreign";
            }
            assert.throws(() => check(f));
          });
        }
      }
    }
  }
}
for (const http of [false, true]) {
  test(`Cost v1 initialize retains exact optional Runtime catalog (http=${http})`, () => {
    available();
    assert.equal(
      check(fixture({ http, catalog: true })).runtime_information_reads,
      1,
    );
  });
}
test("Cost v2 initialization cannot invent catalog work", () => {
  available();
  assert.throws(() => check(fixture({ version: 2, catalog: true })));
});
for (const method of [
  "initialize",
  "session/new",
  "session/load",
  "session/fork",
  "session/prompt",
]) {
  test(`Cost control retains actual same-span HTTP receiver ${method}`, () => {
    available();
    check(fixture({ http: true, sameSpan: true, method }));
  });
  for (const fault of [
    "missing ready",
    "missing SELECT",
    "foreign parent",
    "write query",
  ]) {
    test(`Cost HTTP control rejects ${fault} ${method}`, () => {
      available();
      const f = fixture({ http: true, method });
      check(f);
      if (fault === "missing ready") remove(f, f.readiness);
      if (fault === "missing SELECT") remove(f, f.readyQuery);
      if (fault === "foreign parent") parent(f, f.readiness, f.request);
      if (fault === "write query")
        f.set(
          f.readyQuery,
          "db.query.text",
          "UPDATE acp_sessions SET state='deleted'",
        );
      assert.throws(() => check(f));
    });
  }
}
