import assert from "node:assert/strict";
import test from "node:test";
import { inspectTrace } from "./trace.mjs";
import {
  progressTraceFixture as fixture,
  addProgressOutput,
} from "./trace.fixture.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { privateACPDiagnosticInventory } from "../observability/private-acp-inventory.mjs";
const inspect = (f) =>
  inspectTrace(f.trace, f.expected, ["progress-payload-canary"], f.requests);
const phases = [1, 2].flatMap((version) =>
  ["bash", "managed"].flatMap((kind) =>
    ["success", "failure", "cancel"].map(
      (ending) => `v${version}-${kind}-${ending}`,
    ),
  ),
);

function admittedResponse(
  phase,
  endpointDifference = 230,
  eventDifference = 235,
) {
  const f = fixture(phase, { refresh: false });
  const { trace, expected, request, run } = f;
  const admission = {
    traceID: trace.traceID,
    spanID: "progress-admission",
    processID: run.processID,
    operationName: "acp.session.prompt",
    startTime: run.startTime,
    duration: 1,
    references: [
      { refType: "CHILD_OF", traceID: trace.traceID, spanID: request.spanID },
    ],
    tags: Object.entries({
      "span.kind": "internal",
      "antnest.agent.id": expected.agentId,
      "agent.id": expected.agentId,
      "antnest.session.id": expected.sessionId,
      "session.id": expected.sessionId,
      "antnest.operation.phase": "admit",
      "antnest.outcome": "ok",
    }).map(([key, value]) => ({ key, value })),
    logs: [],
  };
  run.references[0].spanID = admission.spanID;
  trace.spans.push(admission);
  const runEnd = run.startTime + run.duration;
  request.duration = runEnd - endpointDifference - request.startTime;
  if (expected.closedBeforeResponse)
    request.logs[0].timestamp = runEnd - eventDifference;
  return { ...f, admission };
}

for (const phase of phases.filter((value) => value.startsWith("v1-")))
  for (const endpointDifference of phase.endsWith("success")
    ? [230, -5]
    : [230])
    test(`${phase} retains original response timing across the actual admission parent (${endpointDifference})`, () => {
      const f = admittedResponse(phase, endpointDifference);
      const before = structuredClone(f.trace);
      const report = inspect(f);
      const observations = report.time_observations.filter((row) =>
        [
          "progress-run-joined-by-v1-prompt",
          "progress-run-before-closed-v1-response",
        ].includes(row.boundary),
      );
      assert.equal(
        observations.length,
        Number(endpointDifference > 0) +
          Number(f.expected.closedBeforeResponse),
      );
      for (const row of observations) {
        assert.equal(row.reason, "deferred-same-node-sdk-sub-ms-endpoint");
        assert.equal(row.span_id, f.run.spanID);
        assert.equal(row.parent_span_id, f.admission.spanID);
        assert.equal(row.request_span_id, f.request.spanID);
        assert.equal(row.raw_left_us, f.run.startTime + f.run.duration);
        assert.equal(
          row.raw_right_us,
          row.boundary === "progress-run-joined-by-v1-prompt"
            ? f.request.startTime + f.request.duration
            : f.request.logs[0].timestamp,
        );
        assert.equal(row.raw_difference_us, row.raw_left_us - row.raw_right_us);
      }
      assert.deepEqual(f.trace, before);
    });

for (const [name, mutate] of Object.entries({
  missing_admission: (f) => {
    f.run.references[0].spanID = f.request.spanID;
    f.trace.spans = f.trace.spans.filter((span) => span !== f.admission);
  },
  wrong_admission_operation: (f) => {
    f.admission.operationName = "acp.session.output";
  },
  wrong_admission_phase: (f) =>
    f.set(f.admission, "antnest.operation.phase", "execute"),
  rejected_admission: (f) => f.set(f.admission, "antnest.outcome", "rejected"),
  wrong_admission_kind: (f) => f.set(f.admission, "span.kind", "server"),
  foreign_agent: (f) => f.set(f.admission, "antnest.agent.id", "foreign"),
  foreign_session: (f) => f.set(f.admission, "antnest.session.id", "foreign"),
  foreign_agent_alias: (f) => f.set(f.admission, "agent.id", "foreign"),
  foreign_session_alias: (f) => f.set(f.admission, "session.id", "foreign"),
  foreign_run_agent: (f) => f.set(f.run, "antnest.agent.id", "foreign"),
  foreign_run_agent_alias: (f) => f.set(f.run, "agent.id", "foreign"),
  foreign_run_session_alias: (f) => f.set(f.run, "session.id", "foreign"),
  extra_parent: (f) => {
    const other = structuredClone(f.admission);
    other.spanID = "intermediate";
    f.trace.spans.push(other);
    f.admission.references[0].spanID = other.spanID;
  },
  foreign_process: (f) => {
    f.trace.processes.foreign = structuredClone(
      f.trace.processes[f.admission.processID],
    );
    f.admission.processID = "foreign";
  },
  foreign_request: (f) => {
    const other = structuredClone(f.request);
    other.spanID = "foreign-request";
    other.operationName = "unrelated";
    f.trace.spans.push(other);
    f.admission.references[0].spanID = other.spanID;
  },
  non_millisecond_admission: (f) => f.admission.startTime--,
  non_millisecond_request: (f) => f.request.startTime--,
  non_millisecond_run: (f) => f.run.startTime++,
  whole_millisecond_response: (f) => {
    f.request.duration =
      f.run.startTime + f.run.duration - 1000 - f.request.startTime;
    f.request.logs[0].timestamp = f.request.startTime + f.request.duration;
  },
  whole_millisecond_event: (f) => {
    f.request.duration =
      f.run.startTime + f.run.duration + 5 - f.request.startTime;
    f.request.logs[0].timestamp = f.run.startTime + f.run.duration - 1000;
  },
}))
  test(`Progress response timing rejects ${name}`, () => {
    const f = admittedResponse("v1-managed-success");
    mutate(f);
    const before = structuredClone(f.trace);
    assert.throws(() => inspect(f));
    assert.deepEqual(f.trace, before);
  });

for (const phase of phases)
  test(`${phase} accounts for successful ACP progress persistence and output under the Tool`, () => {
    const f = fixture(phase);
    const branches = addProgressOutput(f);
    const before = structuredClone(f.trace);
    const result = inspect(f);
    assert.deepEqual(f.trace, before);
    assert(
      !result.owned_error_spans.some((claim) =>
        branches.spans.some((span) => span.spanID === claim.span_id),
      ),
    );
  });
for (const phase of ["v1-bash-success", "v2-managed-cancel"])
  for (const [name, mutate] of [
    ["failed progress SQL", (f, b) => f.set(b.statements[1], "error", true)],
    [
      "foreign output Session",
      (f, b) => f.set(b.output, "antnest.session.id", "foreign"),
    ],
    [
      "foreign output Agent",
      (f, b) => f.set(b.output, "antnest.agent.id", "foreign"),
    ],
    [
      "contradictory Agent alias",
      (f, b) => f.set(b.output, "agent.id", "foreign"),
    ],
    [
      "contradictory Session alias",
      (f, b) => f.set(b.output, "session.id", "foreign"),
    ],
    [
      "COMMIT starts before BEGIN",
      (_f, b) => {
        [b.statements[0].startTime, b.statements.at(-1).startTime] = [
          b.statements.at(-1).startTime,
          b.statements[0].startTime,
        ];
      },
    ],
    [
      "configuration starts before authorization",
      (_f, b) => {
        [b.reads[0].startTime, b.reads.at(-1).startTime] = [
          b.reads.at(-1).startTime,
          b.reads[0].startTime,
        ];
      },
    ],
    [
      "rolled-back persistence",
      (f, b) =>
        f.set(b.transaction, "antnest.transaction.outcome", "rolled_back"),
    ],
    [
      "missing COMMIT",
      (f, b) => {
        f.trace.spans = f.trace.spans.filter((s) => s !== b.statements.at(-1));
      },
    ],
    [
      "foreign SQL database",
      (f, b) => f.set(b.reads[0], "db.namespace", "foreign"),
    ],
    [
      "unrelated SELECT",
      (f, b) => f.set(b.reads[0], "db.query.text", "SELECT * FROM unrelated"),
    ],
    [
      "missing output query",
      (f, b) => {
        f.trace.spans = f.trace.spans.filter((s) => s !== b.reads[0]);
      },
    ],
    [
      "extra successful query",
      (f, b) => {
        f.trace.spans.push({
          ...structuredClone(b.reads[0]),
          spanID: "extra-progress-query",
        });
      },
    ],
    [
      "wrong progress INSERT",
      (f, b) =>
        f.set(
          b.statements[5],
          "db.query.text",
          "INSERT INTO unrelated VALUES ($1)",
        ),
    ],
    [
      "foreign output process",
      (f, b) => {
        b.output.processID = f.tool.processID;
      },
    ],
    [
      "unknown Tool branch",
      (_f, b) => {
        b.output.operationName = "unexpected.work";
      },
    ],
    [
      "hidden work below SQL",
      (_f, b) => {
        b.reads[1].references[0].spanID = b.reads[0].spanID;
      },
    ],
    [
      "nested protocol request",
      (f, b) => f.set(b.reads[0], "rpc.method", "tools/call"),
    ],
    [
      "SQL outlives its awaited output parent",
      (f, b) => {
        b.reads[0].duration =
          b.output.startTime + b.output.duration - b.reads[0].startTime + 2000;
      },
    ],
  ])
    test(`${phase} rejects ${name} without borrowing Tool error ownership`, () => {
      const f = fixture(phase),
        b = addProgressOutput(f);
      inspect(f);
      mutate(f, b);
      assert.throws(() => inspect(f));
    });
test("multiple progress writes and merged output do not require one output for each transaction", () => {
  const f = fixture("v2-managed-cancel");
  addProgressOutput(f);
  const merged = addProgressOutput(f);
  f.trace.spans = f.trace.spans.filter(
    (span) => span !== merged.output && !merged.reads.includes(span),
  );
  inspect(f);
});
test("original SQL enumeration order is independent of ordered execution start times", () => {
  const f = fixture(),
    branches = addProgressOutput(f);
  f.set(branches.output, "agent.id", f.expected.agentId);
  f.set(branches.output, "session.id", f.expected.sessionId);
  f.trace.spans.reverse();
  inspect(f);
});
test("queries with the same millisecond start preserve their original precision", () => {
  const f = fixture(),
    branches = addProgressOutput(f);
  for (const span of branches.statements)
    span.startTime = branches.transaction.startTime + 1;
  for (const span of branches.reads)
    span.startTime = branches.output.startTime + 1;
  inspect(f);
});
for (const name of ["output", "transaction"])
  test(`asynchronous progress ${name} retains an original late warning without a Tool timing exemption`, () => {
    const f = fixture(),
      branches = addProgressOutput(f),
      branch = branches[name];
    branch.duration =
      f.call.startTime + f.call.duration - branch.startTime + 2000;
    branch.warnings = ["original asynchronous progress endpoint warning"];
    const before = structuredClone(f.trace),
      result = inspect(f);
    assert.equal(result.strict_trace, "failed");
    assert(result.warnings.includes(branch.warnings[0]));
    assert(
      !result.time_observations.some((row) => row.span_id === branch.spanID),
    );
    assert.deepEqual(f.trace, before);
  });
for (const phase of phases)
  test(`private collector accounts for every original ${phase} error`, () => {
    const f = fixture(phase);
    const report = inspect(f);
    assert(Array.isArray(report.owned_error_spans));
    const inventory = privateACPDiagnosticInventory(
      [f.trace, f.expected.connectionTrace],
      [report],
      new Set([
        "progress-replay-disconnect",
        "progress-run-unresolved",
        "progress-tool-cancelled",
        "progress-managed-tool-error",
        "completed-initialize-mcp-read-disconnect",
        "completed-runtime-tool-http-disconnect",
      ]),
    );
    assert.equal(inventory.diagnostic_inventory_verified, true);
    assert.equal(
      inventory.raw_error_inventory.length,
      report.error_spans.length,
    );
  });
for (const phase of phases.filter((value) => !value.endsWith("cancel")))
  test(`${phase} parsed Tool retains its exact owned discovery cleanup`, () => {
    const f = fixture(phase, { heldDiscovery: true });
    const report = inspect(f);
    const neutral = report.neutral_diagnostics.filter(
      (row) => row.reason === "completed-runtime-tool-http-disconnect",
    );
    assert(neutral.length > 0);
    assert(
      neutral.every(
        (row) =>
          !report.owned_error_spans.some(
            (claim) =>
              claim.trace_id === row.trace_id && claim.span_id === row.span_id,
          ),
      ),
      "original cleanup cannot be claimed twice as a business error",
    );
    privateACPDiagnosticInventory(
      [f.trace, f.expected.connectionTrace],
      [report],
      new Set([
        "progress-replay-disconnect",
        "progress-run-unresolved",
        "progress-tool-cancelled",
        "progress-managed-tool-error",
        "completed-initialize-mcp-read-disconnect",
        "completed-runtime-tool-http-disconnect",
      ]),
    );
  });
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
