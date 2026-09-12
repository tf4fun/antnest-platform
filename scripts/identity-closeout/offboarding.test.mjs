import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  assertDisabled,
  inspectOffboardingTrace,
  failureCategory,
} from "./offboarding-evidence.mjs";

const sourceID = "1".repeat(32);
function fixture() {
  const source = {
    traceID: sourceID,
    processes: {
      e: { serviceName: "edge-gateway" },
      i: { serviceName: "identity-service" },
      c: { serviceName: "agent-controller" },
    },
    spans: [],
  };
  const span = (trace, id, processID, operationName, parent, tags = []) => {
    const value = {
      traceID: trace.traceID,
      spanID: id,
      processID,
      operationName,
      tags,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }]
        : [],
    };
    trace.spans.push(value);
    return value;
  };
  span(source, "edge", "e", "HTTP POST");
  span(source, "identity", "i", "HTTP POST", "edge");
  span(
    source,
    "receipt",
    "c",
    "agent_controller.identity_offboarding.receive",
    "identity",
  );
  span(
    source,
    "schedule",
    "c",
    "agent_controller.identity_offboarding.disable",
    "identity",
    [{ key: "agent.id", value: "agent-a" }],
  );
  const traces = [source];
  for (const [index, phase] of [
    "drain",
    "network_fence",
    "runtime_disable",
    "publish",
  ].entries()) {
    const trace = {
      traceID: String(index + 2).repeat(32),
      processes: {
        c: { serviceName: "agent-controller" },
        d: {
          serviceName:
            phase === "runtime_disable"
              ? "runtime-controller"
              : "antnest-runtime-egress",
        },
      },
      spans: [],
    };
    const root = span(
      trace,
      "root",
      "c",
      "recover Agent lifecycle operation",
      null,
      [
        { key: "antnest.lifecycle.request_id", value: "disable-a" },
        { key: "antnest.lifecycle.kind", value: "disable" },
        { key: "antnest.lifecycle.phase", value: phase },
        { key: "antnest.agent.id", value: "agent-a" },
      ],
    );
    root.references.push({
      refType: "FOLLOWS_FROM",
      traceID: sourceID,
      spanID: "schedule",
    });
    if (phase === "runtime_disable" || phase === "network_fence")
      span(trace, "dependency", "d", "HTTP POST", "root", [
        {
          key: "http.request.method",
          value: phase === "runtime_disable" ? "POST" : "PUT",
        },
        {
          key: "http.route",
          value:
            phase === "runtime_disable"
              ? "/internal/runtimes/{agent_id}/disable"
              : "/internal/agent-network-attachments/{agent_id}",
        },
      ]);
    traces.push(trace);
  }
  return traces;
}
const expected = { sourceID, agentID: "agent-a", requestID: "disable-a" };

test("offboarding requires disabled Agent and independently absent Runtime", () => {
  const agent = {
    agent_id: "agent-a",
    desired_state: "disabled",
    lifecycle_state: "disabled",
  };
  const runtime = {
    agent_id: "agent-a",
    lifecycle_state: "disabled",
    health: "absent",
    runtime_execution_id: "",
    mcp_endpoint: "",
  };
  assertDisabled(agent, runtime, "agent-a");
  for (const patch of [
    { health: "unknown" },
    { lifecycle_state: "deleted" },
    { mcp_endpoint: "http://live/mcp" },
    { agent_id: "agent-b" },
  ])
    assert.throws(() =>
      assertDisabled(agent, { ...runtime, ...patch }, "agent-a"),
    );
  assert.throws(() =>
    assertDisabled({ ...agent, desired_state: "enabled" }, runtime, "agent-a"),
  );
});
test("offboarding accepts exact Gateway source and linked Disable phases", () => {
  assert.equal(
    inspectOffboardingTrace(fixture(), expected, []).phases.length,
    4,
  );
});
test("offboarding rejects missing phase and unrelated dependency spans", () => {
  assert.throws(() =>
    inspectOffboardingTrace(fixture().slice(0, -1), expected, []),
  );
  const traces = fixture();
  traces[3].spans[1].references = [];
  assert.throws(() => inspectOffboardingTrace(traces, expected, []));
});
test("inspection spans cannot substitute for the mutating Disable RPC", () => {
  for (const index of [2, 3]) {
    const traces = fixture();
    traces[index].spans[1].tags = [
      { key: "http.request.method", value: "GET" },
      { key: "http.route", value: "/internal/runtimes/{agent_id}" },
    ];
    assert.throws(() => inspectOffboardingTrace(traces, expected, []));
  }
});
test("failure diagnostics never echo SDK or malformed JSON payloads", () => {
  for (const error of [
    new SyntaxError("bad JSON synthetic-password"),
    new Error("SDK synthetic-password"),
    Object.assign(new Error("synthetic-password"), { code: "ERR_ASSERTION" }),
  ]) {
    assert(!failureCategory(error).includes("synthetic-password"));
  }
});
test("actual fixture process fails safely during bootstrap, cleanup and async Pool errors", () => {
  const module = new URL("./offboarding-evidence.mjs", import.meta.url).href;
  for (const body of [
    `JSON.parse('malformed synthetic-password')`,
    `try {} finally { await Promise.reject(new Error('synthetic-password')); }`,
    `const {EventEmitter}=await import('node:events'); setImmediate(()=>new EventEmitter().emit('error',new Error('synthetic-password')));`,
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {installFailureBoundary} from ${JSON.stringify(module)}; installFailureBoundary(); ${body}`,
      ],
      { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      event: "agent_access_failed",
      reason: "fixture_or_dependency_failed",
    });
    assert(!result.stderr.includes("synthetic-password"));
  }
});
test("offboarding rejects broken, foreign or cyclic source links", () => {
  for (const reference of [
    { refType: "FOLLOWS_FROM", traceID: sourceID, spanID: "missing" },
    { refType: "FOLLOWS_FROM", traceID: "f".repeat(32), spanID: "schedule" },
    { refType: "FOLLOWS_FROM", traceID: "2".repeat(32), spanID: "root" },
  ]) {
    const traces = fixture();
    traces[1].spans[0].references = [reference];
    assert.throws(() => inspectOffboardingTrace(traces, expected, []));
  }
});
test("offboarding rejects another Agent or operation and secret leakage", () => {
  assert.throws(() =>
    inspectOffboardingTrace(fixture(), { ...expected, agentID: "agent-b" }, []),
  );
  assert.throws(() =>
    inspectOffboardingTrace(
      fixture(),
      { ...expected, requestID: "disable-b" },
      [],
    ),
  );
  const traces = fixture();
  traces[0].spans[0].tags = [{ key: "bad", value: "synthetic-password" }];
  assert.throws(() =>
    inspectOffboardingTrace(traces, expected, ["synthetic-password"]),
  );
});
