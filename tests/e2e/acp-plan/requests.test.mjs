import assert from "node:assert/strict";
import test from "node:test";
import { inspectPlanRequestTrace, selectRequestTrace } from "./requests.mjs";
import { requestFixture } from "./trace-fixture.mjs";
import { privatePlanRequestFixture } from "./private-request.fixture.mjs";
import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import {
  addReadEndpointObservation,
  assertReadEndpointObservations,
  scaleReadFixtureTrace,
} from "../observability/runtime-information-timing-fixture.mjs";

const inspectPrivate = (f) =>
  inspectPlanRequestTrace(f.trace, f.expected, [], { strictPrivate: true });

for (const version of [1, 2])
  for (const method of [
    "session/new",
    "session/load",
    "session/resume",
    "session/fork",
  ]) {
    test(`private v${version} Plan successful ${method} separately binds actual input and result Session`, () => {
      const f = privatePlanRequestFixture({ version, method });
      const result = inspectPrivate(f);
      assert.equal(result.input_session_id, f.expected.inputSessionID);
      assert.equal(result.session_id, f.expected.sessionId);
      assert.equal(result.no_execution, true);
      assert.deepEqual(result.owned_error_spans, []);
    });
    for (const [label, mutate] of [
      [
        "missing application",
        (f) => {
          f.trace.spans = f.trace.spans.filter(
            (span) => span !== f.application,
          );
        },
      ],
      [
        "wrong input",
        (f) => {
          f.expected.inputSessionID = "foreign";
        },
      ],
      [
        "conflicting Session alias",
        (f) => f.field(f.application, "session.id", "foreign"),
      ],
      [
        "conflicting Agent alias",
        (f) => f.field(f.application, "agent.id", "foreign"),
      ],
      [
        "foreign application process",
        (f) => {
          const original = f.trace.processes[f.application.processID];
          f.trace.processes.foreign = structuredClone(original);
          f.trace.processes.foreign.tags.find(
            (field) => field.key === "process.pid",
          ).value++;
          f.application.processID = "foreign";
        },
      ],
    ])
      test(`private v${version} Plan successful ${method} rejects ${label}`, () => {
        const f = privatePlanRequestFixture({ version, method });
        mutate(f);
        assert.throws(() => inspectPrivate(f));
      });
  }

test("private Plan fork cannot reuse its input Session as the returned Session", () => {
  const f = privatePlanRequestFixture({ method: "session/fork" });
  f.expected.sessionId = f.expected.inputSessionID;
  f.field(f.request, "antnest.session.id", f.expected.sessionId);
  assert.throws(() => inspectPrivate(f));
});

for (const [label, mutate] of [
  [
    "negative application duration",
    (f) => {
      f.application.duration = -1;
    },
  ],
  [
    "unfinished application",
    (f) => {
      f.application.duration = NaN;
    },
  ],
  [
    "negative RPC duration",
    (f) => {
      f.request.duration = -1;
    },
  ],
  [
    "unfinished RPC",
    (f) => {
      f.request.duration = NaN;
    },
  ],
  [
    "application preceding its RPC",
    (f) => {
      f.application.startTime = f.request.startTime - 1;
    },
  ],
  [
    "application beyond joined RPC by 1ms",
    (f) => {
      f.application.duration =
        f.request.startTime +
        f.request.duration +
        1000 -
        f.application.startTime;
    },
  ],
  [
    "unqualified sub-ms overhang",
    (f) => {
      f.application.duration =
        f.request.startTime + f.request.duration + 1 - f.application.startTime;
    },
  ],
])
  test(`private successful Plan application rejects ${label}`, () => {
    const f = privatePlanRequestFixture({ method: "session/load" });
    mutate(f);
    assert.throws(() => inspectPrivate(f));
  });

test("private successful Plan application records the existing same-Node sub-ms endpoint observation without changing raw", () => {
  const f = privatePlanRequestFixture({ method: "session/fork" });
  f.request.startTime = 1000000;
  f.request.duration = 500;
  f.application.startTime = 1000000;
  f.application.duration = 900;
  const raw = structuredClone(f.trace);
  const result = inspectPrivate(f);
  assert.equal(result.time_observations.length, 1);
  assert.equal(result.time_observations[0].raw_difference_us, 400);
  assert.equal(
    result.time_observations[0].boundary,
    "plan-application-joined-by-rpc",
  );
  assert.equal(
    result.time_observations[0].reason,
    "deferred-same-node-sdk-sub-ms-endpoint",
  );
  assert.deepEqual(f.trace, raw);
});

for (const version of [1, 2])
  for (const [method, denial] of [
    ["session/new", "access_denied"],
    ["session/load", "session_access_denied"],
    ["session/resume", "session_access_denied"],
    ["session/fork", "session_access_denied"],
  ]) {
    test(`private v${version} Plan ${method} binds the actual ${denial} receipt and original error origin`, () => {
      const f = privatePlanRequestFixture({ version, method, denial });
      const raw = structuredClone([f.trace, f.connectionTrace]);
      const result = inspectPrivate(f);
      assert.equal(result.denial, denial);
      assert.equal(result.no_execution, true);
      assert.deepEqual(
        result.owned_error_spans?.map((span) => span.span_id).sort(),
        ["application", "request"],
      );
      assert.deepEqual([f.trace, f.connectionTrace], raw);
    });
    for (const [label, mutate] of [
      [
        "absent SDK receipt",
        (f) => {
          delete f.expected.rejectionReceipt;
        },
      ],
      [
        "another SDK code",
        (f) => {
          f.expected.rejectionReceipt.code = "dependency_failed";
        },
      ],
      [
        "retryable SDK denial",
        (f) => {
          f.expected.rejectionReceipt.retryable = true;
        },
      ],
      [
        "another error origin",
        (f) => f.field(f.request, "antnest.error.origin_span_id", "missing"),
      ],
      [
        "missing application cause",
        (f) => {
          f.trace.spans = f.trace.spans.filter(
            (span) => span !== f.application,
          );
        },
      ],
      [
        "unowned error event",
        (f) => {
          f.application.logs[0].fields.push({
            key: "exception.type",
            value: "UnrelatedFailure",
          });
        },
      ],
      [
        "another input Session",
        (f) => f.field(f.application, "antnest.session.id", "foreign"),
      ],
    ])
      test(`private v${version} Plan ${method} denial rejects ${label}`, () => {
        const f = privatePlanRequestFixture({ version, method, denial });
        mutate(f);
        const raw = structuredClone([f.trace, f.connectionTrace]);
        assert.throws(() => inspectPrivate(f));
        assert.deepEqual([f.trace, f.connectionTrace], raw);
      });
  }

for (const version of [1, 2])
  for (const method of ["session/load", "session/resume", "session/fork"])
    for (const [label, mutate] of [
      [
        "numeric OTel failure",
        (f) => f.field(f.request, "otel.status_code", 2),
      ],
      [
        "unowned WARN",
        (f) => {
          f.application.logs = [
            {
              timestamp: f.application.startTime,
              fields: [{ key: "level", value: "WARN" }],
            },
          ];
        },
      ],
      [
        "duplicate diagnostic",
        (f) => {
          f.request.tags.push(
            { key: "error.type", value: "" },
            { key: "error.type", value: "HiddenFailure" },
          );
        },
      ],
      [
        "upgrade HTTP failure",
        (f) => f.field(f.connectionTrace.spans[0], "http.status_code", 503),
      ],
      [
        "upgrade WARN",
        (f) => {
          f.connectionTrace.spans[1].logs = [
            { timestamp: 0, fields: [{ key: "level", value: "WARN" }] },
          ];
        },
      ],
    ])
      test(`private v${version} Plan ${method} replay rejects ${label}`, () => {
        const f = privatePlanRequestFixture({ version, method });
        mutate(f);
        assert.throws(() => inspectPrivate(f));
      });

for (const version of [1, 2])
  test(`private v${version} Plan replay retains only proven Runtime read cleanup`, () => {
    const f = privatePlanRequestFixture({
      version,
      catalog: { runtimeOutcome: "canceled", clientOutcome: "cancelled" },
    });
    const raw = structuredClone(f.trace);
    const result = inspectPrivate(f);
    assert.equal(result.runtime_information_reads, 1);
    assert.equal(result.neutral_diagnostics.length, 2);
    assert.deepEqual(f.trace, raw);
    f.field(f.request, "otel.status_code", 2);
    assert.throws(() => inspectPrivate(f));
  });

test("repeated Session/method requests are selected by their actual socket link", () => {
  const first = requestFixture("session/load", "first"),
    second = requestFixture("session/load", "second");
  assert.equal(
    selectRequestTrace([first.trace, second.trace], second.expected),
    second.trace.traceID,
  );
  assert.equal(selectRequestTrace([first.trace], second.expected), undefined);
  assert.throws(() =>
    selectRequestTrace(
      [second.trace, structuredClone(second.trace)],
      second.expected,
    ),
  );
  assert.throws(() => selectRequestTrace({}, second.expected));
});
test("all replay methods require exact identity/link/ancestry, no execution, no capture or errors", () => {
  for (const method of ["session/load", "session/resume", "session/fork"]) {
    const f = requestFixture(method);
    assert.equal(
      inspectPlanRequestTrace(f.trace, f.expected).no_execution,
      true,
    );
    for (const mutate of [
      (t) => {
        t.spans[0].references = [];
      },
      (t) => {
        t.spans[2].tags.find((t) => t.key === "antnest.session.id").value =
          "foreign";
      },
      (t) => {
        t.spans[2].tags.find((t) => t.key === "antnest.agent.id").value =
          "foreign";
      },
      (t) => {
        t.spans[2].references[0].spanID = "missing";
      },
      (t) => {
        t.spans[2].tags.push({ key: "error", value: true });
      },
      (t) => {
        t.spans[2].tags.push({ key: "data", value: "private" });
      },
      (t) => {
        t.spans[2].logs = [
          { fields: [{ key: "antnest.payload.json", value: "{}" }] },
        ];
      },
    ]) {
      const bad = structuredClone(f.trace);
      mutate(bad);
      assert.throws(() =>
        inspectPlanRequestTrace(bad, f.expected, ["private"]),
      );
    }
    f.trace.spans[0].warnings = ["clock skew adjustment disabled"];
    assert.equal(
      inspectPlanRequestTrace(f.trace, f.expected).strict_trace,
      "failed",
    );
    for (const [name, service] of [
      ["agent.run", "agent-acp-service"],
      ["model.complete", "agent-acp-service"],
      ["HTTP POST /mcp", "antnest-runtime"],
    ]) {
      const bad = requestFixture(method);
      bad.add("unexpected", "request", name, service);
      assert.throws(() => inspectPlanRequestTrace(bad.trace, bad.expected));
    }
  }
});
test("denial permits only its exact rejected ACP boundary and matching domain operation", () => {
  const f = requestFixture();
  f.expected.denial = "session_access_denied";
  assert.throws(() => inspectPlanRequestTrace(f.trace, f.expected));
  const boundary = f.trace.spans[2];
  boundary.tags.push(
    { key: "antnest.outcome", value: "rejected" },
    { key: "rpc.response.status_code", value: -32020 },
    { key: "antnest.error.code", value: "-32020" },
  );
  boundary.logs = [{ fields: [{ key: "event", value: "antnest.error" }] }];
  f.add("domain", "request", "acp.session.resume", undefined, 3, {
    "antnest.outcome": "rejected",
    "error.type": "DomainError",
  });
  assert.equal(
    inspectPlanRequestTrace(f.trace, f.expected).denial,
    "session_access_denied",
  );
  for (const mutate of [
    (t) => {
      t.spans[2].tags.find((t) => t.key === "rpc.response.status_code").value =
        -32603;
    },
    (t) => {
      t.spans[3].operationName = "postgresql transaction";
    },
    (t) => {
      t.spans[3].tags.push({
        key: "antnest.error.code",
        value: "dependency_failed",
      });
    },
    (t) => {
      t.spans[0].tags.push({ key: "error", value: true });
    },
  ]) {
    const bad = structuredClone(f.trace);
    mutate(bad);
    assert.throws(() => inspectPlanRequestTrace(bad, f.expected));
  }
  const foreign = requestFixture("session/new");
  foreign.expected.sessionId = undefined;
  foreign.expected.denial = "access_denied";
  foreign.trace.spans[2].tags = foreign.trace.spans[2].tags.filter(
    (t) => t.key !== "antnest.session.id",
  );
  foreign.trace.spans[2].tags.push(...boundary.tags.slice(-3));
  assert.equal(
    inspectPlanRequestTrace(foreign.trace, foreign.expected).denial,
    "access_denied",
  );
});
function catalogRead(f, method = "resources/read", options = {}) {
  const request = f.trace.spans.find((span) => span.spanID === "request");
  request.duration = 100;
  f.catalog = addCompletedRead(f.trace, request, "ws", f.expected.agentId, {
    preserveRequest: true,
    runtimeOutcome: "success",
    clientOutcome: "success",
    ...options,
  });
  setTag(f.catalog.server, "rpc.method", method);
  setTag(f.catalog.operation, "rpc.method", method);
  return f;
}

test("catalog replay exports its original read endpoint observation", () => {
  const f = catalogRead(requestFixture());
  scaleReadFixtureTrace(f.trace);
  const baseline = inspectPlanRequestTrace(f.trace, f.expected);
  const expected = addReadEndpointObservation(f.trace, f.catalog.read);
  const raw = structuredClone(f.trace);
  assertReadEndpointObservations(
    inspectPlanRequestTrace(f.trace, f.expected),
    [expected],
    baseline,
  );
  assert.deepEqual(f.trace, raw);
});
test("replay without a Runtime read exports an empty timing inventory", () => {
  const f = requestFixture();
  assertReadEndpointObservations(
    inspectPlanRequestTrace(f.trace, f.expected),
    [],
  );
});

test("replays may refresh the Skill catalog but never call executable Runtime methods", () => {
  for (const method of ["session/load", "session/resume", "session/fork"]) {
    const f = catalogRead(requestFixture(method));
    const result = inspectPlanRequestTrace(f.trace, f.expected);
    assert.equal(result.no_execution, true);
    assert.equal(result.runtime_information_reads, 1);
    const executable = catalogRead(requestFixture(method), "tools/call");
    assert.throws(() =>
      inspectPlanRequestTrace(executable.trace, executable.expected),
    );
  }
  const denied = catalogRead(requestFixture());
  denied.expected.denial = "session_access_denied";
  denied.trace.spans[2].tags.push(
    { key: "antnest.outcome", value: "rejected" },
    { key: "rpc.response.status_code", value: -32020 },
    { key: "antnest.error.code", value: "-32020" },
  );
  denied.trace.spans[2].logs = [
    { fields: [{ key: "event", value: "antnest.error" }] },
  ];
  assert.throws(
    () => inspectPlanRequestTrace(denied.trace, denied.expected),
    /cannot refresh Skill catalog/,
  );
});

for (const [name, mutate] of [
  [
    "missing parsed receipt",
    (f) => {
      f.catalog.read.logs = f.catalog.read.logs.filter(
        (event) => event !== f.catalog.validated,
      );
    },
  ],
  [
    "caller cancellation",
    (f) => setTag(f.catalog.read, "antnest.mcp.caller_cancelled", true),
  ],
  [
    "failed close",
    (f) =>
      setTag(f.catalog.read, "antnest.mcp.connection.close.outcome", "failed"),
  ],
  [
    "foreign Agent",
    (f) => {
      for (const span of f.trace.spans)
        if (
          f.trace.processes[span.processID]?.serviceName === "antnest-runtime"
        ) {
          for (const group of [
            span.tags,
            ...(span.logs ?? []).map((event) => event.fields),
          ])
            for (const field of group)
              if (field.key === "antnest.agent.id") field.value = "other";
        }
    },
  ],
  [
    "Run metadata borrowed by replay",
    (f) => {
      const wrapper = f.add(
        "run-info",
        "request",
        "mcp.runtime.info",
        undefined,
        2,
        { "span.kind": "internal" },
      );
      wrapper.duration = 100;
      f.catalog.read.references[0].spanID = wrapper.spanID;
    },
  ],
  [
    "extra read without Runtime children",
    (f) => {
      f.trace.spans.push({
        ...structuredClone(f.catalog.read),
        spanID: "extra-read",
      });
    },
  ],
  [
    "legacy read without lifecycle",
    (f) => {
      for (const span of [f.catalog.client, f.catalog.handshake.client])
        span.references[0].spanID = "request";
      f.trace.spans = f.trace.spans.filter((span) => span !== f.catalog.read);
    },
  ],
])
  test("replay catalog rejects " + name, () => {
    const f = catalogRead(requestFixture());
    mutate(f);
    assert.throws(() => inspectPlanRequestTrace(f.trace, f.expected));
  });

for (const runtimeOutcome of ["success", "canceled"])
  test(
    "replay catalog accepts only proven owned cleanup: " + runtimeOutcome,
    () => {
      const f = catalogRead(requestFixture(), "resources/read", {
        runtimeOutcome,
        clientOutcome: "cancelled",
      });
      const before = structuredClone(f.trace);
      assert.equal(
        inspectPlanRequestTrace(f.trace, f.expected).runtime_information_reads,
        1,
      );
      assert.deepEqual(f.trace, before);
    },
  );
