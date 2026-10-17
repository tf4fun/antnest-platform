import assert from "node:assert/strict";
import test from "node:test";
import * as commandTraces from "./trace.mjs";
import {
  fixture,
  privateHTTPFixture,
  privateHTTPRejectionFixture,
} from "./trace-fixtures.mjs";
import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import {
  addReadEndpointObservation,
  assertReadEndpointObservations,
  scaleReadFixtureTrace,
} from "../observability/runtime-information-timing-fixture.mjs";

const { commandStrictOutcome, inspectCommandTrace, selectCommandTrace } =
  commandTraces;
const inspect = (f) =>
  inspectCommandTrace(f.trace, f.expected, ["PRIVATE"], f.requests ?? []);

for (const sameSpan of [false, true])
  for (const [method, rejection] of [
    ["session/new", "access_denied"],
    ["session/load", "session_access_denied"],
    ["session/resume", "session_access_denied"],
    ["session/fork", "session_access_denied"],
    ["session/prompt", "unsupported_resource_content"],
    ["session/prompt", "unsupported_audio_content"],
  ])
    test(`private HTTP rejection keeps exact application and RPC cause: ${method}/${rejection}/${sameSpan}`, () => {
      const f = privateHTTPRejectionFixture(rejection, { method, sameSpan });
      const original = structuredClone(f.trace);
      const result = inspect(f);
      assert.equal(result.rejection, rejection);
      assert.deepEqual(
        result.owned_error_spans?.map((item) => item.span_id).sort(),
        [f.application.spanID, f.request.spanID].sort(),
      );
      assert.deepEqual(f.trace, original);
    });

for (const [label, mutate] of [
  [
    "application starts after completed RPC",
    (f) => {
      f.application.startTime = f.request.startTime + f.request.duration + 5000;
      f.application.logs[0].timestamp = f.application.startTime;
    },
  ],
  [
    "application precedes RPC",
    (f) => {
      f.application.startTime = f.request.startTime - 1;
      f.application.logs[0].timestamp = f.application.startTime;
    },
  ],
  [
    "negative application duration",
    (f) => {
      f.application.duration = -1;
    },
  ],
  [
    "unfinished RPC",
    (f) => {
      f.request.duration = NaN;
    },
  ],
  [
    "missing application cause",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s !== f.application);
    },
  ],
  [
    "wrong error origin",
    (f) => f.set(f.request, "antnest.error.origin_span_id", f.receiver.spanID),
  ],
  [
    "foreign input Session",
    (f) => f.set(f.application, "antnest.session.id", "foreign"),
  ],
  ["foreign Agent", (f) => f.set(f.application, "antnest.agent.id", "foreign")],
  [
    "RPC exception",
    (f) => f.set(f.request, "exception.type", "UnexpectedError"),
  ],
  [
    "application exception",
    (f) => f.set(f.application, "exception.type", "UnexpectedError"),
  ],
  [
    "unregistered diagnostic code",
    (f) => f.set(f.application, "error.code", "session_access_denied"),
  ],
  [
    "duplicate code",
    (f) => f.request.tags.push({ key: "error.code", value: "-32600" }),
  ],
  [
    "unowned RPC log",
    (f) => {
      f.request.logs = [
        { timestamp: 3, fields: [{ key: "level", value: "WARN" }] },
      ];
    },
  ],
  [
    "unowned application event field",
    (f) => f.application.logs[0].fields.push({ key: "level", value: "ERROR" }),
  ],
  [
    "unowned application cause",
    (f) => {
      f.application.logs[0].fields.find(
        (x) => x.key === "antnest.error.causes",
      ).value = '[{"type":"Error"}]';
    },
  ],
  [
    "missing actual rejection receipt",
    (f) => {
      delete f.expected.rejectionReceipt;
    },
  ],
  [
    "wrong actual rejection code",
    (f) => {
      f.expected.rejectionReceipt.code = "unsupported_audio_content";
    },
  ],
])
  test(`private HTTP rejection rejects ${label}`, () => {
    const f = privateHTTPRejectionFixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("private rejection records only the existing same-Node sub-ms endpoint observation", () => {
  const f = privateHTTPRejectionFixture();
  f.request.startTime = 1000000;
  f.request.duration = 200;
  f.application.startTime = 1000000;
  f.application.duration = 700;
  f.application.logs[0].timestamp = 1000010;
  const raw = structuredClone(f.trace);
  const checked = inspect(f);
  assert.equal(checked.time_observations.length, 1);
  assert.equal(checked.time_observations[0].raw_difference_us, 500);
  assert.equal(
    checked.time_observations[0].reason,
    "deferred-same-node-sdk-sub-ms-endpoint",
  );
  assert.deepEqual(f.trace, raw);
  f.application.duration = 1200;
  assert.throws(() => inspect(f));
  f.application.duration = 700;
  f.application.startTime++;
  assert.throws(() => inspect(f));
});

for (const sameSpan of [false, true])
  for (const kind of ["request", "command", "ordinary"])
    test(`private HTTP ${kind}: actual CLIENT and ${sameSpan ? "shared" : "direct child"} receiver/RPC preserve business checks`, () => {
      const f = privateHTTPFixture(kind, { sameSpan });
      const raw = structuredClone(f.trace);
      const result = inspect(f);
      assert.equal(result.gateway_ancestry, undefined);
      assert.equal(result.timing.acp_start_minus_gateway_us, undefined);
      assert.equal(
        result.timing.acp_start_minus_http_client_us,
        f.request.startTime - f.client.startTime,
      );
      assert.equal(result.runs, kind === "request" ? 0 : 1);
      assert.deepEqual(f.trace, raw);
    });

for (const method of ["initialize", "session/new", "session/fork"])
  test(`private HTTP ${method} independently binds input and result Session`, () => {
    const f = privateHTTPFixture("request", { method });
    assert.equal(inspect(f).method, method);
    if (method === "session/fork")
      assert.notEqual(f.expected.inputSessionID, f.expected.sessionId);
    f.post.rpcSessionID = "borrowed-input-session";
    assert.throws(() => inspect(f));
  });

const httpMutations = [
  [
    "duplicate CLIENT HTTP status",
    (f) => {
      f.client.tags.push({ key: "http.response.status_code", value: 503 });
    },
  ],
  [
    "duplicate receiver HTTP status",
    (f) => {
      f.receiver.tags.push({ key: "http.response.status_code", value: 503 });
    },
  ],
  [
    "conflicting HTTP status alias",
    (f) => {
      f.client.tags.push({ key: "http.status_code", value: 503 });
    },
  ],
  [
    "unclaimed WARN event",
    (f) => {
      f.client.logs = [
        { timestamp: 1, fields: [{ key: "level", value: "WARN" }] },
      ];
    },
  ],
  [
    "unclaimed ERROR event",
    (f) => {
      f.receiver.logs = [
        { timestamp: 1, fields: [{ key: "level", value: "ERROR" }] },
      ];
    },
  ],
  [
    "duplicate event field",
    (f) => {
      f.client.logs = [
        {
          timestamp: 1,
          fields: [
            { key: "level", value: "INFO" },
            { key: "level", value: "ERROR" },
          ],
        },
      ];
    },
  ],
  [
    "HTTP borrowing closed WS response",
    (f) => {
      f.expected.closedBeforeResponse = true;
      for (const [key, value] of Object.entries({
        error: true,
        "error.type": "Error",
        "antnest.outcome": "error",
        "antnest.operation.phase": "acp.dispatch",
        "exception.type": "unrelated",
      }))
        f.set(f.request, key, value);
    },
  ],
  [
    "another CLIENT span",
    (f) => {
      f.expected.clientSpanID = "9".repeat(16);
    },
  ],
  [
    "another Trace",
    (f) => {
      f.expected.traceID = "9".repeat(32);
    },
  ],
  [
    "another JSON-RPC request",
    (f) => {
      f.set(f.request, "antnest.request.id", "borrowed");
    },
  ],
  [
    "another Session result",
    (f) => {
      f.set(f.request, "antnest.session.id", "borrowed");
    },
  ],
  [
    "another input Session",
    (f) => {
      f.expected.inputSessionID = "borrowed";
    },
  ],
  [
    "another Agent",
    (f) => {
      f.set(f.request, "antnest.agent.id", "borrowed");
    },
  ],
  [
    "missing receiver",
    (f) => {
      f.trace.spans = f.trace.spans.filter((span) => span !== f.receiver);
      f.request.references[0].spanID = f.client.spanID;
    },
  ],
  [
    "indirect receiver",
    (f) => {
      f.add("extra", f.receiver.spanID, "extra");
      f.request.references[0].spanID = "extra";
    },
  ],
  [
    "RPC from another process",
    (f) => {
      f.trace.processes.other = structuredClone(
        f.trace.processes[f.receiver.processID],
      );
      f.trace.processes.other.tags.find((item) => item.key === "process.pid")
        .value++;
      f.request.processID = "other";
    },
  ],
  [
    "missing process identity",
    (f) => {
      f.trace.processes[f.request.processID].tags = [];
    },
  ],
  [
    "a WS Link",
    (f) => {
      f.request.references = [
        {
          refType: "FOLLOWS_FROM",
          traceID: f.trace.traceID,
          spanID: f.receiver.spanID,
        },
      ];
    },
  ],
  [
    "a response-header-only parent",
    (f) => {
      f.trace.spans = f.trace.spans.filter((span) => span !== f.client);
      f.receiver.references = [];
    },
  ],
  [
    "an old Gateway receiver",
    (f) => {
      f.trace.processes[f.receiver.processID].serviceName = "edge-gateway";
    },
  ],
  [
    "control listener",
    (f) => {
      f.set(f.receiver, "antnest.listener", "control");
    },
  ],
  [
    "wrong route",
    (f) => {
      f.set(f.receiver, "http.route", "/v2/acp");
    },
  ],
  [
    "wrong protocol",
    (f) => {
      f.set(f.request, "antnest.protocol.version", "v2");
    },
  ],
  [
    "wrong RPC system",
    (f) => {
      f.set(f.request, "rpc.system.name", "grpc");
    },
  ],
  [
    "wrong RPC service",
    (f) => {
      f.set(f.request, "rpc.service", "other");
    },
  ],
  [
    "wrong receiver status",
    (f) => {
      f.set(f.receiver, "http.response.status_code", 200);
    },
  ],
  [
    "unclosed connection",
    (f) => {
      f.expected.httpConnection.streamJoined = false;
    },
  ],
  [
    "pending body",
    (f) => {
      f.post.bodyOutcome = "pending";
    },
  ],
  [
    "missing DELETE",
    (f) => {
      f.expected.httpConnection.requests.pop();
    },
  ],
  [
    "partial DELETE body",
    (f) => {
      f.expected.httpConnection.requests.at(-1).bodyOutcome = "cancelled";
    },
  ],
  [
    "failed cleanup",
    (f) => {
      f.expected.httpConnection.failures.push({ phase: "delete_status" });
    },
  ],
  [
    "borrowed connection ID",
    (f) => {
      f.post.connectionID = "other";
    },
  ],
  [
    "borrowed HTTP request ID",
    (f) => {
      f.post.requestID = 99;
    },
  ],
  [
    "unexplained raw error event",
    (f) => {
      f.client.logs = [
        {
          timestamp: 1,
          fields: [{ key: "exception.type", value: "UnexpectedError" }],
        },
      ];
    },
  ],
  [
    "model work in command",
    (f) => {
      f.add("model", "run", "model.complete");
    },
  ],
  [
    "uncommitted Run",
    (f) => {
      f.set(
        f.trace.spans.find((span) => span.spanID === "transaction"),
        "antnest.transaction.outcome",
        "rolled_back",
      );
    },
  ],
];
for (const [label, mutate] of httpMutations)
  test(`private HTTP rejects ${label}`, () => {
    const f = privateHTTPFixture();
    assert.equal(inspect(f).runs, 1);
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const kind of ["request", "ordinary"])
  test(`shared Session model inventory isolates the actual ${kind} Trace`, () => {
    assert.equal(
      typeof commandTraces.inspectCommandTraceFromRequests,
      "function",
    );
    const f = fixture(kind);
    const requests = [
      ...(f.requests ?? []),
      { trace_id: "other-trace", stage: "tool", phase: "other-run" },
      { trace_id: "other-trace", stage: "reply", phase: "other-run" },
    ];
    const before = structuredClone({ trace: f.trace, requests });
    assert.deepEqual(
      commandTraces.inspectCommandTraceFromRequests(
        f.trace,
        f.expected,
        ["PRIVATE"],
        requests,
      ),
      inspect(f),
    );
    assert.deepEqual({ trace: f.trace, requests }, before);
    requests.push({
      trace_id: f.trace.traceID,
      stage: "tool",
      phase: "unrelated",
    });
    assert.throws(() =>
      commandTraces.inspectCommandTraceFromRequests(
        f.trace,
        f.expected,
        ["PRIVATE"],
        requests,
      ),
    );
  });
test("Session inventory cannot borrow a missing model reply from another Trace", () => {
  assert.equal(
    typeof commandTraces.inspectCommandTraceFromRequests,
    "function",
  );
  const f = fixture("ordinary");
  const requests = structuredClone(f.requests);
  requests[1].trace_id = "other-trace";
  assert.throws(() =>
    commandTraces.inspectCommandTraceFromRequests(
      f.trace,
      f.expected,
      ["PRIVATE"],
      requests,
    ),
  );
});

function catalogRead(f, options = {}) {
  const request = f.trace.spans.find((span) => span.spanID === "request");
  request.duration = 100;
  f.catalog = addCompletedRead(f.trace, request, "http", f.expected.agentId, {
    preserveRequest: true,
    runtimeOutcome: "success",
    clientOutcome: "success",
    ...options,
  });
  return f;
}

for (const sameSpan of [false, true])
  test(`private HTTP retains exact completed Runtime disconnect with shared receiver=${sameSpan}`, () => {
    const f = catalogRead(privateHTTPFixture("command", { sameSpan }), {
      runtimeOutcome: "canceled",
      clientOutcome: "cancelled",
    });
    const original = structuredClone(f.trace);
    assert.equal(inspect(f).runtime_information_reads, 1);
    assert(inspect(f).neutral_diagnostics.length >= 2);
    assert.deepEqual(f.trace, original);
    const completed = f.catalog.server.logs.find((event) =>
      event.fields.some(
        (field) =>
          field.key === "event" &&
          field.value === "Runtime HTTP request completed",
      ),
    );
    completed.fields.push({ key: "exception.type", value: "UnrelatedError" });
    assert.throws(() => inspect(f));
  });

test("command catalog exports the original read endpoint observation", () => {
  const f = catalogRead(fixture("command"));
  scaleReadFixtureTrace(f.trace);
  const baseline = inspect(f);
  const expected = addReadEndpointObservation(f.trace, f.catalog.read);
  const raw = structuredClone(f.trace);
  assertReadEndpointObservations(inspect(f), [expected], baseline);
  assert.deepEqual(f.trace, raw);
});

test("Session setup and command completion may refresh Skill metadata without model or tool execution", () => {
  for (const http of [false, true])
    for (const [kind, method] of [
      ["request", "initialize"],
      ["request", "session/new"],
      ["request", "session/load"],
      ["request", "session/resume"],
      ["request", "session/fork"],
      ["command", "session/prompt"],
    ]) {
      const f = catalogRead(fixture(kind, http));
      const previous = f.expected.method;
      f.expected.method = method;
      for (const span of f.trace.spans) {
        if (span.operationName === `acp ${previous}`)
          span.operationName = `acp ${method}`;
        for (const tag of span.tags)
          if (tag.key === "rpc.method" && tag.value === previous)
            tag.value = method;
      }
      const result = inspect(f);
      assert.equal(result.runtime_information_reads, 1);
      assert.equal(result.runtime_tool_calls, 0);
      assert.equal(result.no_model_or_tools, true);
      assert.equal(result.no_model_or_runtime, false);
    }
});

test("initialize Skill metadata never permits executable calls, model work or extra reads", () => {
  for (const mutate of [
    (f) => f.add("model", "request", "model.complete"),
    (f) =>
      f.add(
        "tool",
        f.catalog.operation.spanID,
        "runtime.mcp.tool",
        "antnest-runtime",
      ),
    (f) => {
      setTag(f.catalog.server, "rpc.method", "tools/call");
    },
    (f) => {
      f.trace.spans.push({
        ...structuredClone(f.catalog.server),
        spanID: "duplicate-info",
      });
    },
  ]) {
    const f = catalogRead(fixture("request"));
    f.expected.method = "initialize";
    f.expected.sessionId = undefined;
    for (const span of f.trace.spans) {
      if (span.operationName === "acp session/load")
        span.operationName = "acp initialize";
      span.tags = span.tags.filter((tag) => tag.key !== "antnest.session.id");
      for (const tag of span.tags)
        if (tag.key === "rpc.method" && tag.value === "session/load")
          tag.value = "initialize";
    }
    assert.equal(inspect(f).runtime_information_reads, 1);
    mutate(f);
    assert.throws(() => inspect(f));
  }
});

test("Skill catalog refresh cannot hide tool execution, detached calls, extra reads or rejected access", () => {
  for (const http of [false, true])
    for (const mutate of [
      (f) =>
        f.add(
          "hidden-tool",
          f.catalog.operation.spanID,
          "runtime.mcp.tool",
          "antnest-runtime",
        ),
      (f) => {
        setTag(f.catalog.server, "rpc.method", "tools/call");
      },
      (f) => {
        f.trace.spans.find(
          (s) => s.spanID === f.catalog.operation.spanID,
        ).tags[0].value = "tools/call";
      },
      (f) => {
        f.catalog.executor.references[0].spanID =
          f.catalog.handshake.operation.spanID;
      },
      (f) => {
        f.catalog.server.references[0].spanID = "forward";
      },
      (f) =>
        f.add(
          "extra-read",
          f.catalog.client.spanID,
          "HTTP POST /mcp",
          "antnest-runtime",
          5,
          { "span.kind": "server", "rpc.method": "resources/read" },
        ),
      (f) => f.add("hidden-model", "request", "model.complete"),
      (f) => {
        f.trace.spans = f.trace.spans.filter(
          (span) => span !== f.catalog.handshake.operation,
        );
      },
      (f) => {
        f.trace.spans = f.trace.spans.filter(
          (span) =>
            f.trace.processes[span.processID]?.serviceName !==
            "antnest-runtime",
        );
      },
      (f) => {
        f.expected.rejection = "session_access_denied";
      },
      (f) => {
        f.expected.method = "session/list";
        f.trace.spans[2].tags.find((t) => t.key === "rpc.method").value =
          "session/list";
      },
    ]) {
      const f = catalogRead(fixture("request", http));
      mutate(f);
      assert.throws(() => inspect(f));
    }
});

test("ordinary execution verifies the explicitly expected read tool after Rebuild", () => {
  const f = fixture("ordinary");
  f.expected.toolName = "read";
  const tool = f.trace.spans
    .find((s) => s.spanID === "call")
    .tags.find((t) => t.key === "tool.name");
  tool.value = "read";
  assert.equal(inspect(f).runtime_tool_calls, 1);
  tool.value = "bash";
  assert.throws(() => inspect(f));
  delete f.expected.toolName;
  assert.equal(inspect(f).runtime_tool_calls, 1);
});
test("command and replay traces verify actual request IDs across WebSocket and HTTP", () => {
  for (const http of [false, true])
    for (const kind of ["command", "request"]) {
      const f = fixture(kind, http),
        result = inspect(f);
      assert.equal(result.runs, kind === "command" ? 1 : 0);
      assert.equal(result.no_model_or_runtime, true);
      f.trace.spans[0].warnings = ["clock skew adjustment disabled"];
      assert.equal(inspect(f).strict_trace, "failed");
    }
  const first = fixture(),
    second = fixture();
  second.trace.traceID = "other";
  second.trace.spans[2].tags.find((t) => t.key === "antnest.request.id").value =
    "3";
  assert.equal(
    selectCommandTrace([first.trace, second.trace], first.expected),
    first.trace.traceID,
  );
  assert.throws(() =>
    selectCommandTrace([first.trace, first.trace], first.expected),
  );
  assert.equal(selectCommandTrace([second.trace], first.expected), undefined);
});
test("command evidence rejects old admission assumptions, missing persistence, execution and identity errors", () => {
  for (const http of [false, true])
    for (const mutate of [
      (f) => {
        f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "write");
      },
      (f) => {
        f.trace.spans.find((s) => s.spanID === "transaction").tags[1].value =
          "rolled_back";
      },
      (f) => {
        f.trace.spans.find((s) => s.spanID === "run").references[0].spanID =
          "root";
      },
      (f) => {
        f.expected.requestId = "foreign";
      },
      (f) => {
        f.expected.sessionId = "foreign";
      },
      (f) => {
        f.expected.agentId = "foreign";
      },
      (f) => {
        f.add("model", "run", "HTTP POST model");
      },
      (f) => {
        f.add("runtime", "run", "HTTP POST /mcp", "antnest-runtime");
      },
      (f) => {
        f.add(
          "management",
          "run",
          "agent_controller.acquire_run",
          "agent-controller",
        );
      },
      (f) => {
        f.add("credential", "run", "agent_controller.resolve_credential");
      },
      (f) => {
        f.trace.spans[0].tags.push({ key: "body", value: "PRIVATE" });
      },
      (f) => {
        f.trace.spans[0].logs = [
          { fields: [{ key: "antnest.payload.json", value: "{}" }] },
        ];
      },
      (f) => {
        f.trace.spans[2].tags.push({ key: "error", value: true });
      },
      (f) => {
        f.trace.spans.push(structuredClone(f.trace.spans[2]));
      },
    ]) {
      const f = fixture("command", http);
      mutate(f);
      assert.throws(() => inspect(f));
    }
  for (const http of [false, true]) {
    const f = fixture("request", http);
    f.add("run", "request", "agent.run");
    assert.throws(() => inspect(f));
  }
});
test("rejections require precise scoped ACP diagnostics with zero execution", () => {
  for (const http of [false, true])
    for (const rejection of [
      "access_denied",
      "session_access_denied",
      "unsupported_resource_content",
      "unsupported_audio_content",
    ]) {
      const f = fixture("request", http);
      f.expected.rejection = rejection;
      assert.throws(() => inspect(f));
      f.trace.spans[2].tags.push(
        { key: "antnest.outcome", value: "rejected" },
        { key: "rpc.response.status_code", value: -32020 },
        { key: "antnest.error.code", value: "-32020" },
      );
      assert.equal(inspect(f).rejection, rejection);
      f.add(
        "other-failure",
        "request",
        "postgresql transaction",
        undefined,
        3,
        { "antnest.outcome": "error" },
      );
      assert.throws(() => inspect(f));
    }
});
test("ordinary prompt correlates model HTTP spans and actual Bash execution after commands", () => {
  const f = fixture("ordinary");
  assert.equal(inspect(f).runtime_tool_calls, 1);
  for (const mutate of [
    (f) => {
      f.requests[0].model_span_id = "model-0";
    },
    (f) => {
      f.requests[1].model_span_id = f.requests[0].model_span_id;
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "call").tags[0].value = "foreign";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "tool").references[0].spanID =
        "request";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "list").startTime =
        f.trace.spans.find((s) => s.spanID === "model-0").startTime + 5000;
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "call").tags[1].value = "write";
    },
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "tool")
        .tags.push({ key: "error", value: true });
    },
  ]) {
    const f = fixture("ordinary");
    mutate(f);
    assert.throws(() => inspect(f));
  }
});

test("a v1 prompt whose socket closed mid-Run may fail only its own response dispatch", () => {
  const closed = (f) => {
    f.expected.closedBeforeResponse = true;
    f.trace.spans[2].tags.push(
      { key: "error", value: true },
      { key: "antnest.outcome", value: "error" },
      { key: "antnest.operation.phase", value: "acp.dispatch" },
      { key: "antnest.protocol.version", value: "v1" },
    );
    return f;
  };
  assert.equal(inspect(closed(fixture("ordinary"))).runtime_tool_calls, 1);
  const open = closed(fixture("ordinary"));
  delete open.expected.closedBeforeResponse;
  assert.throws(() => inspect(open), /unexpected command\/replay/);
  const v2 = closed(fixture("ordinary"));
  v2.trace.spans[2].tags.find(
    (t) => t.key === "antnest.protocol.version",
  ).value = "v2";
  assert.throws(() => inspect(v2));
  const tool = closed(fixture("ordinary"));
  tool.trace.spans
    .find((s) => s.spanID === "tool")
    .tags.push({ key: "error", value: true });
  assert.throws(() => inspect(tool));
});

test("command strict outcome accepts only the reviewed clock warning class", () => {
  const clock = {
    strict_trace: "failed",
    warning_count: 1,
    warnings: [
      "clock skew adjustment disabled; not applying calculated delta of -82.81µs",
    ],
  };
  const passed = { strict_trace: "passed" };
  assert.deepEqual(commandStrictOutcome([passed]), {
    strict_trace: "passed",
    accepted: true,
  });
  assert.deepEqual(commandStrictOutcome([passed, clock]), {
    strict_trace: "failed",
    clock_warnings_accepted: true,
    accepted: true,
  });
  assert.deepEqual(
    commandStrictOutcome([clock, { ...clock, warnings: ["missing parent"] }]),
    { strict_trace: "failed", accepted: false },
  );
});

test("a passed summary cannot bypass the error inventory or warning gate", () => {
  for (const patch of [
    { warnings: ["unknown warning"] },
    { error_spans: [] },
    { error_spans: 1 },
    { resolve_source_error_spans: 1 },
    { platform_probe_errors: 1 },
  ])
    assert.equal(
      commandStrictOutcome([{ strict_trace: "passed", ...patch }]).accepted,
      false,
    );
});

for (const runtimeOutcome of ["success", "canceled"])
  test(
    "command catalog retains exact owned cleanup evidence: " + runtimeOutcome,
    () => {
      const f = catalogRead(fixture("command"), {
        runtimeOutcome,
        clientOutcome: "cancelled",
      });
      const before = structuredClone(f.trace);
      assert.equal(inspect(f).runtime_information_reads, 1);
      assert.deepEqual(f.trace, before);
    },
  );

test("command catalog cannot admit a resource read with no parsed and joined lifecycle", () => {
  const f = catalogRead(fixture("command"));
  for (const span of [f.catalog.client, f.catalog.handshake.client])
    span.references[0].spanID = "request";
  f.trace.spans = f.trace.spans.filter((span) => span !== f.catalog.read);
  assert.throws(() => inspect(f));
});
