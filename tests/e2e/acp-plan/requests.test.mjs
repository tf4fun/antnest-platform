import assert from "node:assert/strict";
import test from "node:test";
import { inspectPlanRequestTrace, selectRequestTrace } from "./requests.mjs";
import { requestFixture } from "./trace-fixture.mjs";

test("repeated Session/method requests are selected by their actual socket link", () => {
  const first = requestFixture("session/load", "first"),
    second = requestFixture("session/load", "second");
  assert.equal(
    selectRequestTrace([first.trace, second.trace], second.expected),
    second.trace.traceID,
  );
  assert.equal(selectRequestTrace([first.trace], second.expected), undefined);
  assert.throws(() =>
    selectRequestTrace(
      [second.trace, structuredClone(second.trace)],
      second.expected,
    ),
  );
  assert.throws(() => selectRequestTrace({}, second.expected));
});
test("all replay methods require exact identity/link/ancestry, no execution, no capture or errors", () => {
  for (const method of ["session/load", "session/resume", "session/fork"]) {
    const f = requestFixture(method);
    assert.equal(
      inspectPlanRequestTrace(f.trace, f.expected).no_execution,
      true,
    );
    for (const mutate of [
      (t) => {
        t.spans[0].references = [];
      },
      (t) => {
        t.spans[2].tags.find((t) => t.key === "antnest.session.id").value =
          "foreign";
      },
      (t) => {
        t.spans[2].tags.find((t) => t.key === "antnest.agent.id").value =
          "foreign";
      },
      (t) => {
        t.spans[2].references[0].spanID = "missing";
      },
      (t) => {
        t.spans[2].tags.push({ key: "error", value: true });
      },
      (t) => {
        t.spans[2].tags.push({ key: "data", value: "private" });
      },
      (t) => {
        t.spans[2].logs = [
          { fields: [{ key: "antnest.payload.json", value: "{}" }] },
        ];
      },
    ]) {
      const bad = structuredClone(f.trace);
      mutate(bad);
      assert.throws(() =>
        inspectPlanRequestTrace(bad, f.expected, ["private"]),
      );
    }
    f.trace.spans[0].warnings = ["clock skew adjustment disabled"];
    assert.equal(
      inspectPlanRequestTrace(f.trace, f.expected).strict_trace,
      "failed",
    );
    for (const [name, service] of [
      ["agent.run", "agent-acp-service"],
      ["model.complete", "agent-acp-service"],
      ["HTTP POST /mcp", "antnest-runtime"],
    ]) {
      const bad = requestFixture(method);
      bad.add("unexpected", "request", name, service);
      assert.throws(() => inspectPlanRequestTrace(bad.trace, bad.expected));
    }
  }
});
test("denial permits only its exact rejected ACP boundary and matching domain operation", () => {
  const f = requestFixture();
  f.expected.denial = "session_access_denied";
  assert.throws(() => inspectPlanRequestTrace(f.trace, f.expected));
  const boundary = f.trace.spans[2];
  boundary.tags.push(
    { key: "antnest.outcome", value: "rejected" },
    { key: "rpc.response.status_code", value: -32020 },
    { key: "antnest.error.code", value: "-32020" },
  );
  boundary.logs = [{ fields: [{ key: "event", value: "antnest.error" }] }];
  f.add("domain", "request", "acp.session.resume", undefined, 3, {
    "antnest.outcome": "rejected",
    "error.type": "DomainError",
  });
  assert.equal(
    inspectPlanRequestTrace(f.trace, f.expected).denial,
    "session_access_denied",
  );
  for (const mutate of [
    (t) => {
      t.spans[2].tags.find((t) => t.key === "rpc.response.status_code").value =
        -32603;
    },
    (t) => {
      t.spans[3].operationName = "postgresql transaction";
    },
    (t) => {
      t.spans[3].tags.push({
        key: "antnest.error.code",
        value: "dependency_failed",
      });
    },
    (t) => {
      t.spans[0].tags.push({ key: "error", value: true });
    },
  ]) {
    const bad = structuredClone(f.trace);
    mutate(bad);
    assert.throws(() => inspectPlanRequestTrace(bad, f.expected));
  }
  const foreign = requestFixture("session/new");
  foreign.expected.sessionId = undefined;
  foreign.expected.denial = "access_denied";
  foreign.trace.spans[2].tags = foreign.trace.spans[2].tags.filter(
    (t) => t.key !== "antnest.session.id",
  );
  foreign.trace.spans[2].tags.push(...boundary.tags.slice(-3));
  assert.equal(
    inspectPlanRequestTrace(foreign.trace, foreign.expected).denial,
    "access_denied",
  );
});
function catalogRead(f, method = "resources/read") {
  f.add(
    "catalog-client",
    "request",
    "HTTP POST antnest-runtime",
    undefined,
    5,
    {
      "span.kind": "client",
    },
  );
  f.add(
    "catalog-server",
    "catalog-client",
    "HTTP POST /mcp",
    "antnest-runtime",
    5,
    {
      "span.kind": "server",
      "rpc.method": method,
    },
  );
  f.add(
    "catalog-operation",
    "catalog-server",
    "runtime.mcp.operation",
    "antnest-runtime",
    5,
    { "rpc.method": method },
  );
  return f;
}
test("replays may refresh the Skill catalog but never call executable Runtime methods", () => {
  for (const method of ["session/load", "session/resume", "session/fork"]) {
    const f = catalogRead(requestFixture(method));
    const result = inspectPlanRequestTrace(f.trace, f.expected);
    assert.equal(result.no_execution, true);
    assert.equal(result.runtime_information_reads, 1);
    const executable = catalogRead(requestFixture(method), "tools/call");
    assert.throws(() =>
      inspectPlanRequestTrace(executable.trace, executable.expected),
    );
  }
  const denied = catalogRead(requestFixture());
  denied.expected.denial = "session_access_denied";
  denied.trace.spans[2].tags.push(
    { key: "antnest.outcome", value: "rejected" },
    { key: "rpc.response.status_code", value: -32020 },
    { key: "antnest.error.code", value: "-32020" },
  );
  denied.trace.spans[2].logs = [
    { fields: [{ key: "event", value: "antnest.error" }] },
  ];
  assert.throws(
    () => inspectPlanRequestTrace(denied.trace, denied.expected),
    /cannot refresh Skill catalog/,
  );
});
