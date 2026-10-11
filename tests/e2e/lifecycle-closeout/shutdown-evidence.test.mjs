import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStopped,
  assertRestarted,
  inspectShutdownTrace,
  assertReadyExecutionState,
  assertIdleMaintenance,
} from "./shutdown-evidence.mjs";
import {
  expected,
  traceFixture,
  cancelledTrace,
  dependencyCancellationFixture,
} from "./shutdown-fixtures.mjs";
import { shutdownResolutionFixture } from "./shutdown-resolution-fixtures.mjs";

const project = "antnest-lifecycle-01234567";
const before = [
  {
    id: "container-1",
    name: "edge-gateway",
    project,
    image: "image-1",
    running: true,
    health: "healthy",
    exit: 0,
    oom: false,
    error: "",
    started: "2026-09-10T01:00:00Z",
    finished: "0001-01-01T00:00:00Z",
  },
];
const stopped = [
  { ...before[0], running: false, finished: "2026-09-10T01:01:00Z" },
];
const restarted = [{ ...before[0], started: "2026-09-10T01:02:00Z" }];
test("shutdown and restart preserve exact container ownership and process identity", () => {
  assert.equal(assertStopped(project, before, stopped).length, 1);
  assert.equal(assertRestarted(project, before, restarted).length, 1);
});
for (const [name, mutate] of [
  ["missing container", (rows) => rows.pop()],
  ["duplicate container", (rows) => rows.push({ ...rows[0] })],
  [
    "foreign scope",
    (rows) => {
      rows[0].project = "retained-stack";
    },
  ],
  [
    "replacement container",
    (rows) => {
      rows[0].id = "replacement";
    },
  ],
  [
    "wrong image",
    (rows) => {
      rows[0].image = "different";
    },
  ],
  [
    "still running",
    (rows) => {
      rows[0].running = true;
    },
  ],
  [
    "forced kill",
    (rows) => {
      rows[0].exit = 137;
    },
  ],
  [
    "OOM",
    (rows) => {
      rows[0].oom = true;
    },
  ],
  [
    "daemon failure",
    (rows) => {
      rows[0].error = "private-error";
    },
  ],
  [
    "stale finish",
    (rows) => {
      rows[0].finished = "2026-09-09T01:00:00Z";
    },
  ],
])
  test(`shutdown rejects ${name}`, () => {
    const rows = structuredClone(stopped);
    mutate(rows);
    assert.throws(() => assertStopped(project, before, rows));
  });
test("restart cannot accept an old process or a stopped container", () => {
  assert.throws(() => assertRestarted(project, before, before));
  assert.throws(() => assertRestarted(project, before, stopped));
});

test("shutdown trace reads translated HTTP statuses and still rejects failed dependencies", () => {
  const trace = traceFixture();
  for (const span of trace.spans)
    for (const field of span.tags)
      if (field.key === "http.response.status_code")
        field.key = "http.status_code";
  assert.equal(
    inspectShutdownTrace(trace, expected, ["secret"]).gateway_ancestry,
    true,
  );
  trace.spans
    .at(-1)
    .tags.find((field) => field.key === "http.status_code").value = 503;
  assert.throws(() => inspectShutdownTrace(trace, expected, ["secret"]));
});
test("shutdown trace requires completed servers on the actual Gateway watch path", () => {
  assert.equal(
    inspectShutdownTrace(traceFixture(), expected, ["secret"]).gateway_ancestry,
    true,
  );
});
test("verified shutdown retains a classified Gateway stream cancellation", () => {
  const result = inspectShutdownTrace(cancelledTrace(), expected, ["secret"]);
  assert.equal(result.gateway_outcome, "cancelled_stream");
  assert.equal(result.stop_window_verified, true);
});
for (const [name, mutate] of [
  ["ordinary panic", (t) => t.spans[0].tags.pop()],
  [
    "different failure",
    (t) => {
      t.spans[0].tags.at(-2).value = "other_error";
    },
  ],
  [
    "failed response",
    (t) => {
      t.spans[0].tags[1].value = 500;
    },
  ],
  [
    "unfinished abort",
    (t) => {
      t.spans[0].duration = 0;
    },
  ],
  [
    "abort before stop",
    (t) => {
      t.spans[0].startTime =
        expected.stopWindow.start * 1000 - t.spans[0].duration - 1;
    },
  ],
  [
    "abort after stop",
    (t) => {
      t.spans[0].startTime = 4000000;
    },
  ],
  [
    "dependency abort",
    (t) => {
      t.spans[3].tags.push(...t.spans[0].tags.slice(-3));
    },
  ],
]) {
  test(`shutdown trace rejects ${name} despite a classified Gateway abort`, () => {
    const trace = cancelledTrace();
    mutate(trace);
    assert.throws(() => inspectShutdownTrace(trace, expected, ["secret"]));
  });
}
test("shutdown trace requires the observed stop window", () => {
  for (const stopWindow of [
    undefined,
    { start: 3000, end: 1000 },
    { start: NaN, end: 3000 },
  ]) {
    assert.throws(() =>
      inspectShutdownTrace(cancelledTrace(), { ...expected, stopWindow }, [
        "secret",
      ]),
    );
  }
});
test("shutdown trace checks errors in intermediate client spans", () => {
  const trace = cancelledTrace();
  const client = trace.spans.find((span) => span.spanID === "console-forward");
  assert.equal(
    inspectShutdownTrace(trace, expected, []).gateway_outcome,
    "cancelled_stream",
  );
  client.tags.push({ key: "error", value: true });
  assert.throws(() => inspectShutdownTrace(trace, expected, []));
});

test("shutdown accepts only a Gateway HTTP client cancellation in the same stop window", () => {
  const trace = cancelledTrace();
  const client = trace.spans.find((span) => span.spanID === "forward");
  client.tags.push(
    { key: "error", value: true },
    { key: "error.type", value: "cancelled" },
  );
  assert.equal(
    inspectShutdownTrace(trace, expected, []).gateway_outcome,
    "cancelled_stream",
  );
  for (const mutate of [
    (s) =>
      (s.tags.find((t) => t.key === "error.type").value = "deadline_exceeded"),
    (s) =>
      (s.tags.find((t) => t.key === "http.response.status_code").value = 503),
    (s) => (s.tags.find((t) => t.key === "span.kind").value = "server"),
    (s) => (s.startTime = 4000000),
    (s) => (s.references = []),
    (s) => (s.processID = "unknown"),
  ]) {
    const changed = structuredClone(trace);
    mutate(changed.spans.find((span) => span.spanID === "forward"));
    assert.throws(() => inspectShutdownTrace(changed, expected, []));
  }
});
test("shutdown trace checks errors in additional internal spans", () => {
  const trace = cancelledTrace();
  trace.spans.push({
    ...trace.spans[2],
    spanID: "internal-failure",
    tags: [
      { key: "span.kind", value: "internal" },
      { key: "error", value: true },
    ],
  });
  assert.throws(() => inspectShutdownTrace(trace, expected, []));
});
for (const [name, mutate] of [
  ["missing Console", (t) => t.spans.splice(2, 1)],
  ["missing Identity", (t) => t.spans.splice(1, 1)],
  ["missing Controller", (t) => t.spans.splice(3, 1)],
  [
    "detached Controller",
    (t) => {
      t.spans[3].references = [];
    },
  ],
  [
    "Controller bypasses Console",
    (t) => {
      t.spans[3].references[0].spanID = "edge";
    },
  ],
  [
    "unfinished Gateway",
    (t) => {
      t.spans[0].duration = 0;
    },
  ],
  [
    "failed server",
    (t) => {
      t.spans[3].tags.push({ key: "error", value: true });
    },
  ],
  [
    "wrong route",
    (t) => {
      t.spans[0].tags[2].value = "GET /wrong";
    },
  ],
  [
    "wrong Controller route",
    (t) => {
      t.spans[3].tags[2].value = "/internal/wrong";
    },
  ],
  [
    "foreign trace",
    (t) => {
      t.spans[3].traceID = "b".repeat(32);
    },
  ],
  [
    "cycle",
    (t) => {
      t.spans[3].references[0].spanID = "controller";
    },
  ],
  [
    "client masquerading as server",
    (t) => {
      t.spans[3].tags[0].value = "client";
    },
  ],
  [
    "secret disclosure",
    (t) => {
      t.spans[0].tags.push({ key: "bad", value: "secret" });
    },
  ],
])
  test(`shutdown trace rejects ${name}`, () => {
    const trace = traceFixture();
    mutate(trace);
    assert.throws(() => inspectShutdownTrace(trace, expected, ["secret"]));
  });

const readyState = {
  agent_id: "agent",
  availability: "ready",
  access_allowed: true,
  configuration_revision: "a".repeat(64),
  active_session_id: null,
  unavailable_reason: null,
};
test("shutdown consumes current ACP ready state, not legacy aggregate revisions", () => {
  assertReadyExecutionState(readyState, "agent");
  for (const state of [
    { ...readyState, agent_id: "foreign" },
    { ...readyState, agent_revision: 7 },
    { ...readyState, configuration_revision: 7 },
    { ...readyState, configuration_revision: null },
    { ...readyState, active_session_id: "session" },
    { ...readyState, access_allowed: false },
    { ...readyState, unavailable_reason: "agent_unavailable" },
  ])
    assert.throws(() => assertReadyExecutionState(state, "agent"));
});
test("idle maintenance cannot execute a Run or reach the model", () => {
  assertIdleMaintenance(
    { items: [], next_cursor: null },
    { requests: [], errors: [] },
  );
  for (const [audit, model] of [
    [
      { items: [{ run_id: "run" }], next_cursor: null },
      { requests: [], errors: [] },
    ],
    [
      { items: [], next_cursor: "more" },
      { requests: [], errors: [] },
    ],
    [
      { items: [], next_cursor: null },
      { requests: [{}], errors: [] },
    ],
    [
      { items: [], next_cursor: null },
      { requests: [], errors: ["error"] },
    ],
  ])
    assert.throws(() => assertIdleMaintenance(audit, model));
});
test("restarted services must be healthy", () => {
  assert.throws(() =>
    assertRestarted(project, before, [
      { ...restarted[0], health: "unhealthy" },
    ]),
  );
});
test("watch topology validates all spans, preserves warnings and retains cancellation strict failure", () => {
  const trace = traceFixture();
  trace.spans[0].warnings = ["clock skew adjustment disabled; fixture"];
  const original = structuredClone(trace);
  assert.equal(
    inspectShutdownTrace(trace, expected, []).strict_trace,
    "failed",
  );
  assert.deepEqual(trace, original);
  assert.equal(
    inspectShutdownTrace(cancelledTrace(), expected, []).strict_trace,
    "failed",
  );
  for (const mutate of [
    (t) =>
      t.spans.push({
        ...t.spans[1],
        spanID: "orphan",
        references: [
          { refType: "CHILD_OF", traceID: t.traceID, spanID: "missing" },
        ],
      }),
    (t) =>
      (t.spans[0].logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ]),
    (t) => t.spans[1].tags.push({ key: "otel.status_code", value: "ERROR" }),
  ]) {
    const changed = traceFixture();
    mutate(changed);
    assert.throws(() => inspectShutdownTrace(changed, expected, []));
  }
});
test("execution state watch requires the ACP POST RPC and rejects a Controller substitute", () => {
  const {
    trace,
    receiver: span,
    expected: want,
  } = shutdownResolutionFixture("rpc", true);
  assert.equal(inspectShutdownTrace(trace, want, []).gateway_ancestry, true);
  span.processID = "agent-controller";
  assert.throws(() => inspectShutdownTrace(trace, want, []));
});

for (const executionState of [false, true]) {
  test(`verified ${executionState ? "ACP state" : "lifecycle event"} shutdown cancellations retain strict failure`, () => {
    const { trace, want } = dependencyCancellationFixture(executionState);
    const original = structuredClone(trace);
    const result = inspectShutdownTrace(trace, want, []);
    assert.equal(result.gateway_ancestry, true);
    assert.equal(result.strict_trace, "failed");
    assert.equal(result.cancellation_error_spans, executionState ? 2 : 4);
    assert.deepEqual(trace, original);
  });
  for (const [label, mutate] of [
    ["outside stop window", (t) => (t.spans.at(-1).startTime = 4000000)],
    [
      "failed status",
      (t) =>
        (t.spans
          .at(-1)
          .tags.find((x) => x.key === "http.response.status_code").value = 503),
    ],
    [
      "different error",
      (t) =>
        (t.spans.at(-1).tags.find((x) => x.key === "error.type").value =
          "dependency_unavailable"),
    ],
    [
      "foreign dependency",
      (t) => (t.spans.at(-1).processID = "identity-service"),
    ],
    [
      "unrelated client",
      (t) => (t.spans[2].operationName = "HTTP GET unrelated"),
    ],
    ["detached client", (t) => (t.spans[2].references = [])],
  ])
    test(`${executionState ? "state" : "events"} cancellation rejects ${label}`, () => {
      const { trace, want } = dependencyCancellationFixture(executionState);
      mutate(trace);
      assert.throws(() => inspectShutdownTrace(trace, want, []));
    });
}

test("cancellation classification rejects conflicting error events on an otherwise matched span", () => {
  const { trace, want } = dependencyCancellationFixture(false);
  trace.spans[3].logs[0].fields.push({
    key: "antnest.error.code",
    value: "dependency_unavailable",
  });
  assert.throws(() => inspectShutdownTrace(trace, want, []));
});

test("Controller cancellation cannot use another HTTP method", () => {
  const { trace, want } = dependencyCancellationFixture(false);
  trace.spans.at(-1).tags.find((t) => t.key === "http.request.method").value =
    "POST";
  assert.throws(() => inspectShutdownTrace(trace, want, []));
});
