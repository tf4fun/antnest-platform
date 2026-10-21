import assert from "node:assert/strict";
import test from "node:test";
import { inspectOutageWindow } from "./resolve-cache-outage.mjs";

test("business model identity requires the original receive time without Trace", () => {
  const evidence = bridgeOutageFixture();
  inspectOutageWindow(evidence, { requireTrace: false });
  for (const observation of [evidence.model_started, evidence.model_cancelled])
    delete observation.state.requests[0].received_at_ms;
  assert.throws(() => inspectOutageWindow(evidence, { requireTrace: false }));
});
import { bridgeOutageFixture } from "./resolve-cache-bridge-outage-fixtures.mjs";

function stripTraceFields(value) {
  if (!value || typeof value !== "object") return;
  for (const key of ["trace_id", "traceID", "model_span_id"]) delete value[key];
  for (const child of Object.values(value)) stripTraceFields(child);
}

test("policy4 business inspection accepts missing Trace fields only when explicitly requested and preserves raw evidence", () => {
  const value = bridgeOutageFixture();
  const expected = inspectOutageWindow(value);
  stripTraceFields(value);
  const before = structuredClone(value);
  assert.throws(() => inspectOutageWindow(value));
  assert.deepEqual(
    inspectOutageWindow(value, { requireTrace: false }),
    expected,
  );
  assert.deepEqual(value, before);
});

for (const [name, change] of [
  [
    "short business window",
    (value) => (value.identity.restart_started_at = 5999),
  ],
  [
    "surviving Runtime process group child",
    (value) =>
      (value.runtime.quiescent.work.processes += "\n43 (sleep) S 1 30 0 0"),
  ],
  [
    "Run still running in storage",
    (value) => (value.run_storage.after.record.state = "running"),
  ],
]) {
  test(`policy4 business inspection without Trace still rejects ${name}`, () => {
    const value = bridgeOutageFixture();
    stripTraceFields(value);
    inspectOutageWindow(value, { requireTrace: false });
    change(value);
    const before = structuredClone(value);
    assert.throws(() => inspectOutageWindow(value, { requireTrace: false }));
    assert.deepEqual(value, before);
  });
}

test("policy4 accepts HTTP cancellation only after new SSE tool output from the same held Runtime", () => {
  const result = inspectOutageWindow(bridgeOutageFixture());
  assert.equal(result.policy_revision, 4);
  assert.equal(result.transport, "http-sse");
  assert.equal(result.run_id, "run-1");
  assert.equal(result.stopped_ms, 5001);
  assert.equal(result.runtime_quiescent, true);
});

test("accepts the public Admin snapshot while proving hidden Runtime binding from the actual stored Run", () => {
  const value = bridgeOutageFixture();
  for (const row of [value.audit_before, value.audit])
    for (const key of ["agentId", "organizationId", "runtime"])
      assert.equal(key in row.body.execution_snapshot, false);
  assert.equal(value.run_storage.after.record.state, "unresolved");
  assert.doesNotThrow(() => inspectOutageWindow(value));
});

test("accepted running SSE may arrive while the prompt HTTP response is still being read", () => {
  const value = bridgeOutageFixture();
  value.prompt.at = 500;
  assert.doesNotThrow(() => inspectOutageWindow(value));
});

test("terminal SSE may precede a completed cancel HTTP response reporting uncertain", () => {
  const value = bridgeOutageFixture();
  value.cancel.at = 1820;
  value.cancel.body.phase = "uncertain";
  value.cancel.body.errorClass = "cancelled_tool_outcome_unknown";
  value.runtime.quiescent.started_at = 1825;
  value.runtime.quiescent.at = 1835;
  assert.doesNotThrow(() => inspectOutageWindow(value));
});

test("separate process samples allow legitimate running/sleeping state changes of the same held work", () => {
  const value = bridgeOutageFixture();
  value.runtime.before_cancel.work.processes =
    value.runtime.before_cancel.work.processes.replace(
      "42 (bash) S",
      "42 (bash) R",
    );
  assert.doesNotThrow(() => inspectOutageWindow(value));
});

test("held process may be sampled after its SSE tool record while both precede the outage", () => {
  const value = bridgeOutageFixture();
  value.runtime.started.started_at = 450;
  value.runtime.started.at = 460;
  assert.doesNotThrow(() => inspectOutageWindow(value));
});

test("one real stdout write can arrive as multiple progress chunks", () => {
  const value = bridgeOutageFixture();
  const item =
    value.stream.records[1].view.selectedView.turns[0].liveProcessDelta.items[0]
      .item;
  const body = item.content.pop().text.slice("stdout: ".length);
  item.content.push(
    { type: "text", text: "stdout: " + body.slice(0, 20) },
    { type: "text", text: "stdout: " + body.slice(20) },
  );
  assert.doesNotThrow(() => inspectOutageWindow(value));
});

test("accepts production ToolProgress accumulating stdout chunks in one text block", () => {
  const value = bridgeOutageFixture();
  const content =
    value.stream.records[1].view.selectedView.turns[0].liveProcessDelta.items[0]
      .item.content;
  const body = content[1].text.slice("stdout: ".length);
  content[1].text = `stdout: ${body.slice(0, 20)}\nstdout: ${body.slice(20)}`;
  assert.doesNotThrow(() => inspectOutageWindow(value));
});

const output = (value) => value.stream.records[1].view.selectedView.turns[0];
const tool = (value) => output(value).liveProcessDelta.items[0].item;
for (const [name, mutate] of [
  [
    "model-held work instead of actual process",
    (v) => delete v.runtime.started,
  ],
  ["marker only in command input", (v) => tool(v).content.splice(1)],
  [
    "duplicate stdout emission",
    (v) => tool(v).content.push(structuredClone(tool(v).content[1])),
  ],
  [
    "duplicate emission in one accumulated progress block",
    (v) => (tool(v).content[1].text += `\n${tool(v).content[1].text}`),
  ],
  [
    "running SSE predates prompt dispatch",
    (v) => {
      v.prompt.started_at = 450;
      v.prompt.at = 500;
    },
  ],
  [
    "terminal SSE predates cancel dispatch",
    (v) => (v.stream.records[2].at = 1500),
  ],
  [
    "marker in synthetic model text",
    (v) => {
      output(v).finalResponse = tool(v).content.slice(1);
      tool(v).content.splice(1);
    },
  ],
  ["other Run output", (v) => (output(v).turnId = "foreign-run")],
  ["other Tool output", (v) => (tool(v).id = "foreign-tool")],
  [
    "completed work instead of held work",
    (v) => (tool(v).status = "completed"),
  ],
  [
    "stale output watermark",
    (v) => (v.stream.records[1].view.selectedView.outputWatermark = 2),
  ],
  ["stale process revision", (v) => (output(v).processVersion = 1)],
  ["output before stopped Identity", (v) => (v.stream.records[1].at = 950)],
  ["emit before stopped Identity", (v) => (v.runtime.emit.started_at = 950)],
  [
    "different emit Runtime",
    (v) => (v.runtime.emit.container_id = "b".repeat(64)),
  ],
  ["wrong gate", (v) => (v.runtime.emit.path += "-release")],
  [
    "natural completion before cancel",
    (v) => (v.runtime.before_cancel.work.processes = "1 (runtime) S 0 1 0 0"),
  ],
  [
    "bash parent gone but child alive",
    (v) => (v.runtime.quiescent.work.processes += "\n43 (sleep) S 1 30 0 0"),
  ],
  [
    "Runtime replaced",
    (v) => (v.runtime.quiescent.container.id = "b".repeat(64)),
  ],
  [
    "Runtime process restarted",
    (v) => (v.runtime.quiescent.status.execution_id = "new-runtime"),
  ],
  [
    "Runtime image changed",
    (v) =>
      (v.runtime.before_cancel.container.image = `sha256:${"c".repeat(64)}`),
  ],
  [
    "foreign Runtime owner",
    (v) => (v.runtime.container.agent_id = "foreign-agent"),
  ],
  ["different work process", (v) => (v.runtime.before_cancel.work.pid = 44)],
  ["different process group", (v) => (v.runtime.quiescent.work.pgid = 42)],
  ["quiescence after restart", (v) => (v.runtime.quiescent.at = 6100)],
  ["terminal after restart", (v) => (v.audit.at = 6100)],
  [
    "wrong cancel intent",
    (v) => (v.cancel.path = v.cancel.path.replace("intent-1", "other-intent")),
  ],
  ["wrong target Run", (v) => (v.cancel.request.expectedRunId = "other-run")],
  ["cancel not accepted", (v) => (v.cancel.status = 503)],
  [
    "local 202 acceptance mistaken for ACP",
    (v) => (v.stream.records[0].view.operations[0].acceptance = "bridge"),
  ],
  [
    "unknown-effect run relabelled settled",
    (v) => (v.audit.body.tool_effect_state = "settled"),
  ],
  [
    "legacy model cancelled terminal",
    (v) => (v.audit.body.state = "cancelled"),
  ],
  ["another user audit", (v) => (v.audit.body.principal_id = "foreign-user")],
  [
    "another execution revision",
    (v) =>
      (v.audit.body.execution_snapshot.executionRevision =
        "different-revision"),
  ],
  [
    "another Runtime revision",
    (v) => (v.run_storage.after.record.runtime_revision = "different-runtime"),
  ],
  [
    "another Runtime execution",
    (v) =>
      (v.run_storage.after.record.runtime_execution_id = "different-process"),
  ],
  ["missing actual Run storage", (v) => delete v.run_storage],
  ["foreign database project", (v) => (v.run_storage.project = "foreign")],
  ["wrong database", (v) => (v.run_storage.database = "antnest_identity")],
  ["missing database identity", (v) => delete v.run_storage.container_id],
  ["stored other Run", (v) => (v.run_storage.after.record.run_id = "other")],
  [
    "stored other Session",
    (v) => (v.run_storage.after.record.session_id = "other"),
  ],
  [
    "stored other Agent",
    (v) => (v.run_storage.after.record.agent_id = "other"),
  ],
  [
    "stored other principal",
    (v) => (v.run_storage.after.record.principal_id = "other"),
  ],
  [
    "stored other intent",
    (v) => (v.run_storage.after.record.bridge_intent_id = "other"),
  ],
  [
    "stored other organization",
    (v) => (v.run_storage.after.record.organization_id = "other"),
  ],
  [
    "stored snapshot other organization",
    (v) => (v.run_storage.after.record.snapshot_organization_id = "other"),
  ],
  [
    "stored other execution",
    (v) => (v.run_storage.after.record.execution_revision = "other"),
  ],
  [
    "stored Run remains running",
    (v) => (v.run_storage.after.record.state = "running"),
  ],
  [
    "stored snapshot changed",
    (v) => (v.run_storage.after.record.snapshot_sha256 = "7".repeat(64)),
  ],
  [
    "missing snapshot digest",
    (v) => delete v.run_storage.before.record.snapshot_sha256,
  ],
  [
    "storage observed after Identity restart",
    (v) => (v.run_storage.after.at = 6100),
  ],
  [
    "storage observed before terminal audit",
    (v) => (v.run_storage.after.started_at = 1800),
  ],
  [
    "initial storage observed after stop started",
    (v) => (v.run_storage.before.at = 950),
  ],
  [
    "Runtime organization differs",
    (v) => (v.runtime.organization_id = "other"),
  ],
  [
    "wrong Bridge terminal operation",
    (v) => (v.stream.records[2].view.operations[0].phase = "cancelled"),
  ],
  [
    "missing Bridge unknown-effect reason",
    (v) => delete v.stream.records[2].view.operations[0].errorClass,
  ],
  [
    "wrong Bridge terminal turn",
    (v) =>
      (v.stream.records[2].view.selectedView.turns[0].outcome = "unresolved"),
  ],
  [
    "continued model request",
    (v) =>
      v.model_cancelled.state.requests.push({
        ...v.model_started.state.requests[0],
        stage: "reply",
      }),
  ],
  [
    "model request held",
    (v) => v.model_started.state.pending.push("c4-cache-runtime-outage"),
  ],
  [
    "stream closed during outage",
    (v) => (v.stream.closure = { kind: "local-close", at: 1400 }),
  ],
  [
    "Identity restarted inside window",
    (v) => (v.identity.stopped_end.started_at = "2026-10-14T00:00:12Z"),
  ],
  ["short outage", (v) => (v.identity.restart_started_at = 5999)],
]) {
  test(`policy4 outage rejects ${name}`, () => {
    const value = bridgeOutageFixture();
    inspectOutageWindow(value);
    const before = JSON.stringify(value);
    mutate(value);
    assert.notEqual(JSON.stringify(value), before);
    assert.throws(() => inspectOutageWindow(value));
  });
}
