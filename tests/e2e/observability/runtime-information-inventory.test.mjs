import assert from "node:assert/strict";
import test from "node:test";
import * as runModule from "./runtime-information-run.mjs";
import { inspectRuntimeToolLifecycle } from "./runtime-tool-lifecycle.mjs";
import { execution } from "../acp-files/trace-fixtures.mjs";
import { setTag } from "./gateway-resolution-fixtures.mjs";

function fixture() {
  const f = execution("v2-create");
  f.options = { request: f.information.request, run: f.information.run };
  f.call = f.trace.spans.find(
    (span) => span.operationName === "mcp.tools.call",
  );
  return f;
}
function composed(f, inspectCall) {
  assert.equal(
    typeof runModule.inspectRunInformationReadsWithToolCalls,
    "function",
  );
  return runModule.inspectRunInformationReadsWithToolCalls(
    f.trace,
    f.options,
    inspectCall,
  );
}
function cancelled(f, owner = f.call) {
  setTag(owner, "antnest.mcp.tool_result.outcome", "not_received");
  setTag(owner, "antnest.mcp.caller_cancelled", true);
  owner.logs = owner.logs.filter(
    (event) =>
      !event.fields.some(
        ({ key, value }) =>
          key === "event" && value === "antnest.mcp.tool.result.parsed",
      ),
  );
}

test("default Run inventory still rejects unparsed cancellation even with a data-level override", () => {
  const f = fixture();
  cancelled(f);
  let calls = 0;
  assert.throws(() =>
    runModule.inspectRunInformationReads(f.trace, {
      ...f.options,
      inspectCall: () => {
        calls++;
      },
    }),
  );
  assert.equal(calls, 0);
});
test("default Run inventory still retains the complete original successful proof", () => {
  const f = fixture(),
    before = structuredClone(f.trace);
  const result = runModule.inspectRunInformationReads(f.trace, f.options);
  assert.equal(result.toolLifecycles.length, 2);
  assert.deepEqual(f.trace, before);
});
test("owning call composition visits each original call once while tools/list remains fixed", () => {
  const f = fixture(),
    before = structuredClone(f.trace),
    seen = [];
  const result = composed(f, (trace, owner, identity) => {
    assert.strictEqual(trace, f.trace);
    assert.strictEqual(owner, f.call);
    assert.deepEqual(identity, {
      agentId: "agent",
      executionId: "execution_test",
    });
    seen.push(owner);
    return inspectRuntimeToolLifecycle(trace, owner, identity);
  });
  assert.deepEqual(seen, [f.call]);
  assert.deepEqual(
    result,
    runModule.inspectRunInformationReads(f.trace, f.options),
  );
  assert.deepEqual(f.trace, before);
});
test("tools/list cannot use the owning cancellation inspector", () => {
  const f = fixture();
  cancelled(f, f.information.list);
  let calls = 0;
  assert.throws(() =>
    composed(f, () => {
      calls++;
    }),
  );
  assert.equal(calls, 0);
});
test("the explicit composed entry requires an actual inspector", () => {
  const f = fixture();
  for (const inspector of [undefined, null, {}, true])
    assert.throws(() => composed(f, inspector));
});
test("an owning inspector failure is retained as the original exception", () => {
  const f = fixture(),
    original = new Error("owning cancellation evidence rejected");
  assert.throws(
    () =>
      composed(f, () => {
        throw original;
      }),
    (error) => error === original,
  );
});

for (const [name, mutate] of [
  ["no receipt", () => undefined],
  ["asynchronous receipt", (proof) => Promise.resolve(proof)],
  ["cloned raw spans", (proof) => structuredClone(proof)],
  ["another owner", (proof, f) => ({ ...proof, owner: f.information.list })],
  ["wrong method", (proof) => ({ ...proof, method: "tools/list" })],
  [
    "missing CLIENT",
    (proof) => ({ ...proof, clients: proof.clients.slice(0, 1) }),
  ],
  [
    "duplicate CLIENT",
    (proof) => ({ ...proof, clients: [proof.clients[0], proof.clients[0]] }),
  ],
  [
    "borrowed read CLIENT",
    (proof, f) => ({
      ...proof,
      clients: [proof.clients[0], f.information.client],
    }),
  ],
  ["missing SERVER", (proof) => ({ ...proof, servers: [] })],
  [
    "duplicate SERVER",
    (proof) => ({ ...proof, servers: [proof.servers[0], proof.servers[0]] }),
  ],
  [
    "missing exchange",
    (proof) => ({ ...proof, exchanges: proof.exchanges.slice(0, 1) }),
  ],
  [
    "borrowed exchange SERVER",
    (proof) => ({
      ...proof,
      exchanges: [
        { ...proof.exchanges[0], server: proof.exchanges[1].server },
        proof.exchanges[1],
      ],
    }),
  ],
  [
    "borrowed exchange operation",
    (proof) => ({
      ...proof,
      exchanges: [
        { ...proof.exchanges[0], operation: proof.exchanges[1].operation },
        proof.exchanges[1],
      ],
    }),
  ],
  [
    "wrong exchange method",
    (proof) => ({
      ...proof,
      exchanges: [
        { ...proof.exchanges[0], method: "resources/read" },
        proof.exchanges[1],
      ],
    }),
  ],
  [
    "wrong generation",
    (proof) => ({
      ...proof,
      exchanges: [
        { ...proof.exchanges[0], generation: "foreign" },
        proof.exchanges[1],
      ],
    }),
  ],
  [
    "unbound discovery",
    (proof) => ({ ...proof, discovery: { ...proof.discovery } }),
  ],
  ["unbound invocation", (proof) => ({ ...proof, invocation: undefined })],
  [
    "foreign cancellation",
    (proof, f) => ({
      ...proof,
      ownedCancellations: new Set([f.information.read]),
    }),
  ],
  [
    "cloned cancellation",
    (proof) => ({
      ...proof,
      ownedCancellations: new Set([structuredClone(proof.clients[0])]),
    }),
  ],
  [
    "foreign neutral diagnostic",
    (proof, f) => ({
      ...proof,
      neutralDiagnostics: [
        {
          trace_id: f.trace.traceID,
          span_id: f.information.read.spanID,
          event_index: 0,
          event_timestamp_us: f.information.read.logs[0].timestamp,
          reason: "parsed-runtime-tool-connection-cleanup",
        },
      ],
    }),
  ],
  [
    "foreign time observation",
    (proof, f) => ({
      ...proof,
      timeObservations: [
        {
          trace_id: f.trace.traceID,
          span_id: f.information.read.spanID,
          reason: "deferred-same-node-sdk-sub-ms-endpoint",
        },
      ],
    }),
  ],
])
  test(`composed Run inventory rejects ${name}`, () => {
    const f = fixture();
    let calls = 0;
    assert.throws(() =>
      composed(f, (trace, owner, identity) => {
        calls++;
        return mutate(inspectRuntimeToolLifecycle(trace, owner, identity), f);
      }),
    );
    assert.equal(calls, 1, "counterexample must reach the owning inspector");
  });

test("an owning inspector cannot rewrite raw evidence before returning a proof", () => {
  const f = fixture();
  assert.throws(() =>
    composed(f, (trace, owner, identity) => {
      const proof = inspectRuntimeToolLifecycle(trace, owner, identity);
      trace.spans[0].duration++;
      return proof;
    }),
  );
});

for (const name of [
  "CLIENT",
  "SERVER",
  "resources/read",
  "external cancellation",
])
  test(`composed inventory still rejects unaccounted ${name}`, () => {
    const f = fixture();
    if (name === "external cancellation") {
      setTag(f.options.request, "antnest.outcome", "cancelled");
    } else {
      const source =
        name === "CLIENT" ? f.information.client : f.information.server;
      const extra = structuredClone(source);
      extra.spanID = "unaccounted-runtime-work";
      extra.references[0].spanID = f.call.spanID;
      if (name === "resources/read") {
        extra.operationName = "hidden-resource-read";
        const tool = f.trace.spans.find(
          (span) => span.operationName === "runtime.mcp.tool",
        );
        extra.references[0].spanID = tool.spanID;
        setTag(extra, "rpc.method", "resources/read");
      }
      f.trace.spans.push(extra);
    }
    assert.throws(() => composed(f, inspectRuntimeToolLifecycle));
  });

for (const role of [
  "SERVER",
  "HTTP route",
  "operation name",
  "operation outcome",
  "duplicate role",
])
  test(`composed inventory rejects a nested renamed Runtime boundary with ${role}`, () => {
    const f = fixture();
    const proof = inspectRuntimeToolLifecycle(f.trace, f.call, {
      agentId: "agent",
      executionId: "execution_test",
    });
    const extra = structuredClone(proof.invocation.server);
    extra.spanID = "nested-unaccounted-boundary";
    extra.operationName = "renamed-runtime-work";
    extra.references[0].spanID = proof.invocation.operation.spanID;
    extra.tags = [];
    if (role === "SERVER") setTag(extra, "span.kind", "server");
    if (role === "HTTP route") {
      setTag(extra, "span.kind", "internal");
      setTag(extra, "http.request.method", "POST");
      setTag(extra, "http.route", "/mcp");
    }
    if (role === "operation name")
      setTag(extra, "mcp.operation.name", "tools/call");
    if (role === "operation outcome")
      setTag(extra, "mcp.operation.outcome", "success");
    if (role === "duplicate role")
      extra.tags.push(
        { key: "span.kind", value: "internal" },
        { key: "span.kind", value: "server" },
      );
    f.trace.spans.push(extra);
    assert.throws(
      () => composed(f, inspectRuntimeToolLifecycle),
      /unproven Runtime protocol boundary|duplicate tool evidence field/u,
    );
  });
