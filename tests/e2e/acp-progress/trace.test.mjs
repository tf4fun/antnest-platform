import assert from "node:assert/strict";
import test from "node:test";
import { inspectTrace } from "./trace.mjs";
import { progressTraceFixture as fixture } from "./trace.fixture.mjs";
import { tag } from "../observability/trace-tree.mjs";
const inspect = (f) =>
  inspectTrace(f.trace, f.expected, ["progress-payload-canary"], f.requests);
const phases = [1, 2].flatMap((version) =>
  ["bash", "managed"].flatMap((kind) =>
    ["success", "failure", "cancel"].map(
      (ending) => `v${version}-${kind}-${ending}`,
    ),
  ),
);
for (const phase of phases)
  test(`complete private Progress ${phase} retains original evidence`, () => {
    const f = fixture(phase),
      before = structuredClone({
        trace: f.trace,
        expected: f.expected,
        requests: f.requests,
      });
    const report = inspect(f);
    assert.equal(report.phase, phase);
    assert.equal(report.transport_boundary, "private-acp");
    assert.equal(report.gateway_ancestry, undefined);
    assert.equal(report.tool_calls, 1);
    assert.equal(report.runtime_tool_calls, 1);
    assert.equal(report.model_requests, phase.endsWith("cancel") ? 1 : 2);
    assert.equal(report.strict_trace, "passed");
    assert.equal(
      report.post_prompt_information_reads,
      phase.startsWith("v1") ? 1 : 0,
    );
    assert.deepEqual(f.trace, before.trace);
    assert.deepEqual(f.expected, before.expected);
    assert.deepEqual(f.requests, before.requests);
  });
test("twelve complete paths have twenty original model HTTP clients", () =>
  assert.equal(
    phases.reduce(
      (sum, phase) => sum + inspect(fixture(phase)).model_requests,
      0,
    ),
    20,
  ));
for (const phase of [
  "v1-bash-success",
  "v1-managed-cancel",
  "v2-bash-failure",
  "v2-managed-failure",
])
  for (const [name, mutate] of [
    [
      "wrong actual upgrade",
      (f) => (f.request.references[0].spanID = "f".repeat(16)),
    ],
    [
      "foreign Session",
      (f) => f.set(f.request, "antnest.session.id", "foreign"),
    ],
    ["foreign input Session", (f) => (f.expected.inputSessionID = "foreign")],
    ["foreign live Tool ID", (f) => (f.expected.toolCallId = "f".repeat(64))],
    [
      "missing Run request",
      (f) => f.set(f.run, "antnest.request.id", undefined),
    ],
    ["wrong Run terminal", (f) => f.set(f.run, "run.terminal_class", "failed")],
    ["wrong Run effects", (f) => f.set(f.run, "run.tool_effect_state", "none")],
    ["Run exception", (f) => f.set(f.run, "exception.type", "Injected")],
    ["foreign model trace", (f) => (f.requests[0].trace_id = "e".repeat(32))],
    [
      "missing model HTTP",
      (f) =>
        f.trace.spans.splice(
          f.trace.spans.findIndex(
            (s) => s.spanID === f.requests[0].model_span_id,
          ),
          1,
        ),
    ],
    ["duplicate observed model", (f) => f.requests.push({ ...f.requests[0] })],
    [
      "extra model",
      (f) =>
        f.trace.spans.push({
          ...structuredClone(
            f.trace.spans.find((s) => s.operationName === "model.complete"),
          ),
          spanID: "extra-model",
        }),
    ],
    [
      "unrelated SQL error",
      (f) =>
        f.set(
          f.trace.spans.find((s) => s.operationName === "INSERT"),
          "error",
          true,
        ),
    ],
    [
      "extra Runtime work",
      (f) =>
        f.trace.spans.push({
          ...structuredClone(f.work),
          spanID: "extra-work",
        }),
    ],
    ["wrong actual tool", (f) => f.set(f.call, "tool.name", "other")],
    [
      "extra Tool exception",
      (f) => f.set(f.tool, "exception.type", "Injected"),
    ],
    [
      "captured preview",
      (f) => f.set(f.tool, "captured", "progress-payload-canary"),
    ],
  ])
    test(`${phase} rejects ${name}`, () => {
      const f = fixture(phase);
      mutate(f);
      assert.throws(() => inspect(f));
    });
test("v1 replay disconnect requires its exact receipt and original response failure", () => {
  const f = fixture();
  f.expected.closedBeforeResponse = false;
  assert.throws(() => inspect(f));
  for (const mutate of [
    (g) => g.set(g.request, "antnest.error.origin_span_id", g.call.spanID),
    (g) => g.set(g.request, "error.type", "TransportError"),
    (g) => g.eventField(g.request.logs[0], "antnest.error.causes", "[]"),
    (g) => g.request.logs.push(g.event(g.request.startTime + 1, "exception")),
  ]) {
    const g = fixture();
    mutate(g);
    assert.throws(() => inspect(g));
  }
});
test("only deliberate v1 success disconnect may use the closed receipt", () => {
  for (const phase of [
    "v2-bash-success",
    "v1-bash-failure",
    "v1-managed-cancel",
  ]) {
    const f = fixture(phase);
    f.expected.closedBeforeResponse = true;
    assert.throws(() => inspect(f));
  }
});
test("optional v1 refresh is inspected and v2 cannot borrow it", () => {
  assert.equal(
    inspect(fixture("v1-bash-failure", { refresh: false }))
      .post_prompt_information_reads,
    0,
  );
  const f = fixture("v1-bash-success");
  f.expected.protocolVersion = 2;
  f.expected.phase = "v2-bash-success";
  assert.throws(() => inspect(f));
});
test("closed v1 response without refresh retains precise error validation", () =>
  assert.equal(
    inspect(fixture("v1-bash-success", { refresh: false }))
      .post_prompt_information_reads,
    0,
  ));
test("Bash exit7 returns through a successful executor", () => {
  const f = fixture("v2-bash-failure");
  assert.equal(tag(f.work, "process.exit.code"), 0);
  inspect(f);
  f.set(f.work, "process.exit.code", 7);
  assert.throws(() => inspect(f));
});
for (const [member, name] of [
  ["work", "antnest.error"],
  ["tool", "Managed MCP tool finished"],
])
  test(`managed isError requires original ${member} diagnostic`, () => {
    const f = fixture("v2-managed-failure");
    f[member].logs = f[member].logs.filter(
      (entry) => tag({ tags: entry.fields }, "event") !== name,
    );
    assert.throws(() => inspect(f));
  });
test("no additional model follows cancelled execution", () => {
  const f = fixture("v2-bash-cancel");
  f.requests.push({ ...f.requests[0], stage: "final" });
  assert.throws(() => inspect(f));
});
test("original request and actual upgrade warnings stay strict failed", () => {
  const f = fixture("v2-managed-cancel");
  f.work.warnings = [
    "clock skew adjustment disabled; not applying calculated delta of 200us",
  ];
  f.expected.connectionTrace.spans[1].warnings = [
    "clock skew adjustment disabled; not applying calculated delta of 300us",
  ];
  const before = structuredClone(f.trace),
    report = inspect(f);
  assert.equal(report.strict_trace, "failed");
  assert.equal(report.warning_count, 2);
  assert.deepEqual(f.trace, before);
});

test("Run resource request identity is independent of its actual SDK RPC ID", () => {
  const f = fixture("v2-bash-success");
  f.set(
    f.run,
    "antnest.request.id",
    "request_0123456789abcdef0123456789abcdef",
  );
  const before = structuredClone(f.trace);
  inspect(f);
  assert.deepEqual(f.trace, before);
});
test("managed isError retains its actual stdio error type", () => {
  const f = fixture("v2-managed-failure");
  f.set(f.work, "error.type", "managed_tool_error");
  const before = structuredClone(f.trace);
  inspect(f);
  assert.deepEqual(f.trace, before);
});
test("managed dispatch error must precede its completion event", () => {
  const f = fixture("v2-managed-failure");
  f.operation.logs[0].timestamp = f.operation.logs[1].timestamp + 1;
  assert.throws(() => inspect(f));
});
for (const member of ["run", "call", "model", "http"])
  test(`original ${member} cannot begin before its owning ACP span`, () => {
    const f = fixture("v2-bash-success");
    const model = f.trace.spans.find(
      (span) => span.operationName === "model.complete",
    );
    const http = f.trace.spans.find(
      (span) => span.spanID === f.requests[0].model_span_id,
    );
    const span = { run: f.run, call: f.call, model, http }[member];
    const parent = { run: f.request, call: f.run, model: f.run, http: model }[
      member
    ];
    const finish = span.startTime + span.duration;
    span.startTime = parent.startTime - 1;
    span.duration = finish - span.startTime;
    assert.throws(() => inspect(f));
  });

for (const [name, mutate] of [
  [
    "negative SQL duration",
    (f) => {
      f.trace.spans.find((s) => s.operationName === "INSERT").duration = -1;
    },
  ],
  [
    "late model HTTP event",
    (f) => {
      const s = f.trace.spans.find(
        (s) => s.spanID === f.requests[0].model_span_id,
      );
      s.logs = [
        f.event(s.startTime + s.duration + 1, "ordinary completion", {
          level: "INFO",
        }),
      ];
    },
  ],
  [
    "infinite connection duration",
    (f) => {
      f.expected.connectionTrace.spans[0].duration = Infinity;
    },
  ],
  [
    "early connection event",
    (f) => {
      const s = f.expected.connectionTrace.spans[1];
      s.logs = [
        f.event(s.startTime - 1, "ordinary completion", { level: "INFO" }),
      ];
    },
  ],
])
  test(`complete evidence rejects ${name}`, () => {
    const f = fixture("v2-bash-success");
    mutate(f);
    assert.throws(() => inspect(f));
  });
for (const type of [undefined, "ForeignError"])
  test(`managed failure rejects missing or foreign stdio error type ${type}`, () => {
    const f = fixture("v2-managed-failure");
    f.set(f.work, "error.type", type);
    assert.throws(() => inspect(f));
  });
for (const kind of ["bash", "managed"])
  for (const protocolFailed of [false, true])
    for (const heldDiscovery of [false, true])
      test(`complete cancel ${kind} HTTP error=${protocolFailed} held discovery=${heldDiscovery}`, () => {
        const f = fixture(`v2-${kind}-cancel`, {
          protocolFailed,
          heldDiscovery,
        });
        assert.equal(inspect(f).runtime_tool_calls, 1);
      });
