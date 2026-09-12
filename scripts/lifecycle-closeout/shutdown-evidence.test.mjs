import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStopped,
  assertRestarted,
  inspectShutdownTrace,
} from "./shutdown-evidence.mjs";

const project = "antnest-lifecycle-01234567";
const before = [
  {
    id: "container-1",
    name: "edge-gateway",
    project,
    image: "image-1",
    running: true,
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

const route = "/api/admin/{path...}";
const expected = {
  traceID: "a".repeat(32),
  route,
  console: true,
  controllerRoute: "/internal/agents/{agent_id}/events/watch",
  stopWindow: { start: 1000, end: 3000 },
};
function traceFixture() {
  const span = (id, service, parent, extra = []) => ({
    spanID: id,
    traceID: expected.traceID,
    processID: service,
    startTime: 1000000,
    duration: 10,
    references: parent
      ? [{ refType: "CHILD_OF", traceID: expected.traceID, spanID: parent }]
      : [],
    tags: [
      { key: "span.kind", value: "server" },
      { key: "http.response.status_code", value: 200 },
      ...extra,
    ],
  });
  return {
    traceID: expected.traceID,
    processes: Object.fromEntries(
      [
        "edge-gateway",
        "identity-service",
        "admin-console",
        "agent-controller",
      ].map((s) => [s, { serviceName: s }]),
    ),
    spans: [
      span("edge", "edge-gateway", null, [
        { key: "http.route", value: route },
        { key: "http.request.method", value: "GET" },
      ]),
      span("identity", "identity-service", "edge"),
      span("console", "admin-console", "edge"),
      span("controller", "agent-controller", "console", [
        { key: "http.route", value: expected.controllerRoute },
      ]),
    ],
  };
}
test("shutdown trace requires completed servers on the actual Gateway watch path", () => {
  assert.equal(
    inspectShutdownTrace(traceFixture(), expected, ["secret"]).gateway_ancestry,
    true,
  );
});
function cancelledTrace() {
  const trace = traceFixture();
  trace.spans[0].tags.push(
    { key: "error", value: true },
    { key: "otel.status_description", value: "handler_aborted" },
    { key: "antnest.http.request_cancelled", value: true },
  );
  return trace;
}
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
      t.spans[0].startTime = 100000;
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
  const client = {
    ...trace.spans[2],
    spanID: "console-client",
    references: [
      { refType: "CHILD_OF", traceID: expected.traceID, spanID: "console" },
    ],
    tags: [{ key: "span.kind", value: "client" }],
  };
  trace.spans.push(client);
  trace.spans[3].references[0].spanID = client.spanID;
  assert.equal(
    inspectShutdownTrace(trace, expected, []).gateway_outcome,
    "cancelled_stream",
  );
  client.tags.push({ key: "error", value: true });
  assert.throws(() => inspectShutdownTrace(trace, expected, []));
});

test("shutdown accepts only a Gateway HTTP client cancellation in the same stop window", () => {
  const trace = cancelledTrace();
  const client = {
    ...trace.spans[0],
    spanID: "gateway-client",
    references: [
      {
        refType: "CHILD_OF",
        traceID: expected.traceID,
        spanID: trace.spans[0].spanID,
      },
    ],
    tags: [
      { key: "span.kind", value: "client" },
      { key: "error", value: true },
      { key: "error.type", value: "cancelled" },
      { key: "http.response.status_code", value: 200 },
    ],
  };
  trace.spans.push(client);
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
    mutate(changed.spans.at(-1));
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
  ["missing Controller", (t) => t.spans.pop()],
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
