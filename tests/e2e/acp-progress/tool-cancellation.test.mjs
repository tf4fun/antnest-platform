import assert from "node:assert/strict";
import test from "node:test";
import { inspectProgressCancellation } from "./tool-cancellation.mjs";
import { cancellationFixture } from "./tool-cancellation.fixture.mjs";
import { requireRuntimeToolInventory } from "../observability/runtime-tool-inventory.mjs";

const inspect = (f) =>
  inspectProgressCancellation(f.trace, f.owner, f.identity, {
    kind: f.kind,
    toolName: f.toolName,
  });
for (const kind of ["bash", "managed"])
  for (const protocolFailed of [false, true])
    for (const heldDiscovery of [false, true])
      test(`dispatched ${kind} cancellation retains original errors (HTTP failed=${protocolFailed}, held discovery=${heldDiscovery})`, () => {
        const f = cancellationFixture({ kind, protocolFailed, heldDiscovery }),
          before = structuredClone(f.trace);
        const result = inspect(f);
        requireRuntimeToolInventory(f.trace, f.owner, f.identity, result);
        assert.deepEqual(result.neutralDiagnostics, []);
        assert.equal(result.parsedOutcome, "not_received");
        assert.strictEqual(result.tool, f.tool);
        assert.strictEqual(result.work, f.work);
        assert.equal(result.checkedSpans.size, f.trace.spans.length);
        assert.deepEqual(f.trace, before);
      });

const field = (event, key, value) => {
  event.fields = event.fields.filter((entry) => entry.key !== key);
  event.fields.push({ key, value });
};
for (const [name, mutate] of [
  [
    "parsed result",
    (f) => f.set(f.owner, "antnest.mcp.tool_result.outcome", "success"),
  ],
  [
    "caller not cancelled",
    (f) => f.set(f.owner, "antnest.mcp.caller_cancelled", false),
  ],
  [
    "failed close",
    (f) => f.set(f.owner, "antnest.mcp.connection.close.outcome", "failed"),
  ],
  [
    "extra parsed event",
    (f) =>
      f.owner.logs.push(
        f.event(9000, "antnest.mcp.tool.result.parsed", { outcome: "success" }),
      ),
  ],
  [
    "wrong cause",
    (f) =>
      field(
        f.owner.logs.at(-1),
        "antnest.error.cause_types",
        '["TimeoutError"]',
      ),
  ],
  [
    "inherited error origin",
    (f) =>
      f.set(f.owner, "antnest.error.origin_span_id", f.invocationClient.spanID),
  ],
  ["close completion before start", (f) => (f.owner.logs[3].timestamp = 10000)],
  ["error before joined close", (f) => (f.owner.logs[4].timestamp = 11499)],
  [
    "invocation not cancelled",
    (f) => f.set(f.invocationClient, "antnest.outcome", "success"),
  ],
  [
    "invocation abort after close",
    (f) => (f.invocationClient.logs[0].timestamp = 11501),
  ],
  [
    "unrelated CLIENT error",
    (f) => f.set(f.invocationClient, "error.type", "TransportError"),
  ],
  [
    "missing SERVER",
    (f) => f.trace.spans.splice(f.trace.spans.indexOf(f.invocationServer), 1),
  ],
  [
    "foreign execution",
    (f) => f.set(f.invocationServer, "antnest.runtime.execution.id", "foreign"),
  ],
  [
    "foreign Runtime resource",
    (f) =>
      (f.trace.processes.runtime.tags.find(
        (v) => v.key === "antnest.agent.id",
      ).value = "foreign"),
  ],
  [
    "wrong HTTP status",
    (f) => f.set(f.invocationServer, "http.status_code", "503"),
  ],
  [
    "successful protocol",
    (f) => f.set(f.invocationServer, "antnest.protocol.outcome", "success"),
  ],
  [
    "successful cleanup claim on cancelled call",
    (f) =>
      f.invocationServer.logs.push(
        f.event(9360, "antnest.cancelled", {
          "antnest.protocol.outcome": "success",
        }),
      ),
  ],
  [
    "wrong operation error",
    (f) => f.set(f.operation, "error.type", "outcome_unknown"),
  ],
  ["missing operation diagnostic", (f) => f.operation.logs.shift()],
  ["wrong actual tool", (f) => f.set(f.operation, "mcp.tool.name", "other")],
  [
    "tool failure looks successful",
    (f) => f.set(f.tool, "mcp.tool.outcome", "success"),
  ],
  [
    "wrong stdio cause",
    (f) => field(f.work.logs[0], "antnest.error.cause_types", '["timeout"]'),
  ],
  [
    "unrelated SQL failure",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.work),
        spanID: "f".repeat(16),
        operationName: "SELECT",
        processID: "acp",
      }),
  ],
  [
    "duplicate stdio",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.work),
        spanID: "e".repeat(16),
      }),
  ],
  [
    "stdio error outside own span",
    (f) => (f.work.logs[0].timestamp = f.work.startTime + f.work.duration + 2),
  ],
  [
    "duplicate diagnostic field",
    (f) => f.work.logs[0].fields.push({ ...f.work.logs[0].fields[0] }),
  ],
  [
    "secret payload field",
    (f) => f.set(f.work, "antnest.payload.arguments", "private"),
  ],
])
  test(`owning cancellation rejects ${name}`, () => {
    const f = cancellationFixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("held discovery can only be cancelled within actual joined close", () => {
  const f = cancellationFixture({ heldDiscovery: true });
  f.discoveryClient.logs[0].timestamp = 9100;
  assert.throws(() => inspect(f));
});
test("same-Node discovery ordering below 1ms retains its precise original observation", () => {
  const f = cancellationFixture({ heldDiscovery: true });
  f.discoveryClient.logs[0].timestamp = 10000;
  const before = structuredClone(f.trace);
  const result = inspect(f);
  assert.equal(result.timeObservations.length, 1);
  assert.equal(result.timeObservations[0].raw_difference_us, 100);
  assert.equal(
    result.timeObservations[0].reason,
    "deferred-same-node-sdk-sub-ms-endpoint",
  );
  assert.deepEqual(f.trace, before);
});
test("Bash cancellation rejects natural exit classification and invented exit code", () => {
  for (const [key, value] of [
    ["executor.exit.classification", "nonzero"],
    ["process.exit.code", 0],
  ]) {
    const f = cancellationFixture({ kind: "bash" });
    f.set(f.work, key, value);
    assert.throws(() => inspect(f));
  }
});

for (const [member, eventName] of [
  ["invocationServer", "Runtime HTTP request completed"],
  ["operation", "Runtime MCP operation completed"],
  ["tool", "Runtime MCP tool failed"],
  ["work", "Runtime Executor completed"],
])
  test(`completion ${member} cannot approve an additional error field`, () => {
    const f = cancellationFixture({ kind: "bash" });
    const event = f[member].logs.find((row) =>
      row.fields.some(
        ({ key, value }) => key === "event" && value === eventName,
      ),
    );
    field(event, "exception.type", "InjectedError");
    assert.throws(() => inspect(f));
  });
test("Bash keeps the original canonical decimal PID representation", () => {
  const f = cancellationFixture({ kind: "bash" });
  f.set(f.work, "executor.child.pid", "39");
  const before = structuredClone(f.trace);
  inspect(f);
  assert.deepEqual(f.trace, before);
});
test("Bash cancellation rejects the actual executor exit signal field", () => {
  const f = cancellationFixture({ kind: "bash" });
  f.set(f.work, "executor.exit.signal", 9);
  assert.throws(() => inspect(f));
});
test("Bash PID must be a canonical positive safe integer", () => {
  for (const value of [
    "039",
    "39.0",
    "+39",
    "39x",
    "9007199254740992",
    0,
    -1,
    null,
  ]) {
    const f = cancellationFixture({ kind: "bash" });
    f.set(f.work, "executor.child.pid", value);
    assert.throws(() => inspect(f));
  }
});
for (const member of ["operation", "tool"])
  test(`${member} cannot classify cancellation before its actual child has completed`, () => {
    const f = cancellationFixture();
    f[member].logs[0].timestamp = 4000;
    f[member].logs[1].timestamp = 4100;
    assert.throws(() => inspect(f));
  });

test("Bash completion cannot follow Tool classification within Jaeger rounding", () => {
  const f = cancellationFixture({ kind: "bash" });
  f.work.duration = 9600 - f.work.startTime;
  f.work.logs[1].timestamp = 9601;
  assert.throws(() => inspect(f));
});

test("HTTP cannot observe protocol failure before its original dispatch error", () => {
  const f = cancellationFixture({ protocolFailed: true });
  f.invocationServer.logs[0].timestamp = 9390;
  assert.throws(() => inspect(f));
});

test("Bash cancellation completion cannot claim a natural exit", () => {
  for (const key of [
    "process.exit.code",
    "process.exit.signal",
    "executor.exit.signal",
  ]) {
    const f = cancellationFixture({ kind: "bash" });
    field(f.work.logs[1], key, 9);
    assert.throws(() => inspect(f), key);
  }
});
