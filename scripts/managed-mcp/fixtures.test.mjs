import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, guidance, skillSummary, skillBody } from "./model.mjs";
import { inspectTrace, verifyTraces } from "./trace.mjs";

function payload(phase, results = []) {
  const server = phase === "managed-rebuilt" ? "beta" : "alpha";
  return {
    tools: [{ function: { name: `mcp__${server}__echo` } }],
    messages: [
      {
        role: "system",
        content: `Current Runtime information ${guidance(["managed-fresh", "managed-rebuilt", "managed-draining"].includes(phase) ? 2 : 1)} ${skillSummary} .antnest/skills/fixture/SKILL.md`,
      },
      { role: "user", content: phase },
      ...results.map((content) => ({ role: "tool", content })),
    ],
  };
}
const echo = (phase, calls) =>
  JSON.stringify({
    value: phase,
    calls,
    uid: 1000,
    gid: 1000,
    explicit_env: true,
    supervisor_env: false,
    launcher_env: false,
  });

test("a draining Run uses the same alpha process before and after the rebuild barrier", () => {
  const phase = "managed-draining";
  for (const results of [[], [echo(phase, 3)]]) {
    const response = complete(payload(phase, results));
    assert.equal(response.choices[0].finish_reason, "tool_calls");
    assert.equal(
      response.choices[0].message.tool_calls[0].function.name,
      "mcp__alpha__echo",
    );
  }
  assert.equal(
    complete(payload(phase, [echo(phase, 3), echo(phase, 4)])).choices[0]
      .finish_reason,
    "stop",
  );
  for (const results of [
    [echo(phase, 1)],
    [echo(phase, 3), echo(phase, 1)],
    [echo(phase, 4), echo(phase, 3)],
  ])
    assert.throws(
      () => complete(payload(phase, results)),
      /restarted or replayed/,
    );
  const switched = payload(phase);
  switched.tools = [{ function: { name: "mcp__beta__echo" } }];
  assert.throws(() => complete(switched), /managed tool missing/);
});

test("model fixture rejects appended stale guidance and duplicate Runtime blocks", () => {
  const mixed = payload("managed-fresh");
  mixed.messages[0].content += guidance(1);
  assert.throws(() => complete(mixed), /stale guidance/);
  const duplicate = payload("managed-fresh");
  duplicate.messages.unshift({
    role: "system",
    content: "Current Runtime information old",
  });
  assert.throws(() => complete(duplicate), /Runtime information block/);
});

test("trace oracle rejects a Runtime span masquerading as ACP", () => {
  const fake = trace();
  fake.spans[1].processID = "runtime";
  fake.spans[2].processID = "runtime";
  fake.spans = fake.spans.slice(0, 3);
  assert.throws(() => inspectTrace(fake), /ACP Runtime spans/);
});

test("model fixture drives error recovery, child reuse and rebuilt catalog", () => {
  assert.equal(
    complete(payload("managed-bootstrap")).choices[0].message.tool_calls[0]
      .function.name,
    "write",
  );
  assert.equal(
    complete(payload("managed-exercise", ["fixture tool failed"])).choices[0]
      .message.tool_calls[0].function.name,
    "mcp__alpha__echo",
  );
  for (const [phase, results] of [
    ["managed-exercise", ["fixture tool failed", echo("managed-exercise", 1)]],
    ["managed-fresh", [echo("managed-fresh", 2)]],
    ["managed-rebuilt", [echo("managed-rebuilt", 1)]],
  ])
    assert.equal(
      complete(payload(phase, results)).choices[0].finish_reason,
      "stop",
    );
});

test("model fixture rejects stale guidance, full Skill injection, wrong UID and child restart", () => {
  const stale = payload("managed-fresh");
  stale.messages[0].content = stale.messages[0].content.replace(
    guidance(2),
    guidance(1),
  );
  assert.throws(() => complete(stale), /stale guidance/);
  const leaked = payload("managed-exercise");
  leaked.messages[0].content += skillBody;
  assert.throws(() => complete(leaked), /full Skill/);
  assert.throws(
    () => complete(payload("managed-fresh", [echo("managed-fresh", 1)])),
    /restarted/,
  );
  const root = echo("managed-rebuilt", 1).replace('"uid":1000', '"uid":0');
  assert.throws(() => complete(payload("managed-rebuilt", [root])));
});

function trace() {
  const span = (id, parent, operationName, processID) => ({
    spanID: id,
    operationName,
    processID,
    startTime: operationName === "model.complete" ? 20 : 10,
    duration: 2,
    tags: [{ key: "admission.id", value: "admission-1" }],
    references: parent ? [{ refType: "CHILD_OF", spanID: parent }] : [],
  });
  return {
    traceID: "fixture",
    processes: {
      gateway: { serviceName: "edge-gateway" },
      acp: { serviceName: "agent-acp-service" },
      runtime: { serviceName: "antnest-runtime" },
    },
    spans: [
      span("1", null, "GET /acp", "gateway"),
      span("2", "1", "mcp.runtime.info", "acp"),
      span("3", "1", "mcp.tools.call", "acp"),
      span("4", "2", "HTTP POST /mcp", "runtime"),
      span("6", "1", "model.complete", "acp"),
      span("7", "1", "mcp.tools.list", "acp"),
      span("8", "7", "HTTP POST /mcp", "runtime"),
      span("5", "3", "runtime.mcp.tool", "runtime"),
    ],
  };
}
const requestEvidence = [{ phase: "first", model_span_id: "6" }];
test("Tool span must descend from the actual dispatch, not another Runtime request", () => {
  const value = trace();
  const tool = value.spans.find((span) => span.spanID === "5");
  value.spans.push({
    ...tool,
    spanID: "http-child",
    operationName: "HTTP POST /mcp",
  });
  tool.references = [{ refType: "CHILD_OF", spanID: "1" }];
  assert.throws(
    () => inspectTrace(value, requestEvidence),
    /Runtime Tool descendant/,
  );
});
test("trace sampling includes a delayed duplicate before declaring convergence", async (t) => {
  let samples = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const value = trace();
    if (++samples > 1) {
      value.spans.push({
        ...value.spans.find((span) => span.spanID === "3"),
        spanID: "duplicate-call",
      });
      value.spans.push({
        ...value.spans.find((span) => span.spanID === "5"),
        spanID: "duplicate-runtime",
        references: [{ refType: "CHILD_OF", spanID: "duplicate-call" }],
      });
    }
    return Response.json({ data: [value] });
  });
  const result = await verifyTraces("http://fixture", [
    { ...requestEvidence[0], trace_id: "fixture" },
  ]);
  assert.equal(
    result[0].tool_calls,
    2,
    "a partial first sample hid duplicate dispatch",
  );
  assert.equal(samples, 4);
});
test("execution trace evidence rejects caller-supplied cookies and encoded secrets", () => {
  const secret = "acp-session-cookie/value+canary";
  assert.equal(
    inspectTrace(trace(), requestEvidence, [secret]).gateway_ancestry,
    true,
  );
  for (const value of [secret, encodeURIComponent(secret)]) {
    const leaked = trace();
    leaked.spans[2].tags.push({ key: "cookie", value });
    assert.throws(() => inspectTrace(leaked, requestEvidence, [secret]));
  }
});

test("trace evidence requires actual Gateway ancestry and Runtime descendants", () => {
  assert.equal(inspectTrace(trace(), requestEvidence).gateway_ancestry, true);
  const disconnected = trace();
  disconnected.spans[1].references = [];
  assert.throws(
    () => inspectTrace(disconnected, requestEvidence),
    /Gateway ancestry/,
  );
  const missingRuntime = trace();
  missingRuntime.spans.pop();
  assert.throws(
    () => inspectTrace(missingRuntime, requestEvidence),
    /Runtime child/,
  );
  const leaked = trace();
  leaked.spans[0].tags = [{ key: "body", value: "managed-env-canary" }];
  assert.throws(
    () => inspectTrace(leaked, requestEvidence),
    /sensitive context/,
  );
});

test("trace evidence rejects missing or late per-Run catalog reads", () => {
  const cached = trace();
  cached.spans = cached.spans.filter((span) => span.spanID !== "7");
  assert.throws(() => inspectTrace(cached, requestEvidence), /fresh catalog/);
  const late = trace();
  late.spans.find((span) => span.spanID === "7").startTime = 21;
  assert.throws(() => inspectTrace(late, requestEvidence), /before model/);
  const secondRun = trace();
  secondRun.spans.push({
    ...secondRun.spans.find((span) => span.spanID === "6"),
    spanID: "9",
    tags: [{ key: "admission.id", value: "admission-2" }],
  });
  assert.throws(
    () =>
      inspectTrace(secondRun, [
        ...requestEvidence,
        { phase: "second", model_span_id: "9" },
      ]),
    /fresh information/,
  );
});
