import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectPlanRequestTrace,
  requestBoundary,
  selectRequestTrace,
} from "./requests.mjs";
import {
  inspectCommandTrace,
  selectCommandTrace,
} from "../acp-commands/trace.mjs";
import { fixture as commandFixture } from "../acp-commands/trace-fixtures.mjs";
import { requestFixture } from "./trace-fixture.mjs";
import { privateBoundaryFixture } from "./private-boundary.fixture.mjs";

for (const version of [1, 2]) {
  test(`private v${version} replay binds its actual upgrade and has no Gateway timing`, () => {
    const f = privateBoundaryFixture(undefined, { version });
    const result = inspectPlanRequestTrace(f.trace, f.expected);
    assert.equal(result.no_execution, true);
    assert.equal(result.transport_boundary, "private-acp");
    assert.deepEqual(result.source_trace_ids, [f.connectionTrace.traceID]);
    assert.equal(result.timing.acp_start_minus_gateway_us, undefined);
    assert.equal(result.timing.acp_start_minus_upgrade_us, 2);
    assert.equal(selectRequestTrace([f.trace], f.expected), f.trace.traceID);
    const boundary = requestBoundary(f.trace, f.expected);
    assert.equal(boundary.forwarded, undefined);
    assert.equal(boundary.root, f.request);
    assert.notEqual(f.request.processID, f.connectionTrace.spans[1].processID);
  });

  test(`private v${version} command keeps durable Run checks without claiming Gateway ancestry`, () => {
    const f = privateBoundaryFixture(commandFixture(), { version });
    const result = inspectCommandTrace(f.trace, f.expected, []);
    assert.equal(result.runs, 1);
    assert.equal(result.run_id, "run");
    assert.equal(result.no_model_or_tools, true);
    assert.equal(result.transport_boundary, "private-acp");
    assert.notEqual(result.gateway_ancestry, true);
    assert.equal(result.timing.acp_start_minus_gateway_us, undefined);
    assert.equal(selectCommandTrace([f.trace], f.expected), f.trace.traceID);
    const missingWrite = structuredClone(f.trace);
    missingWrite.spans = missingWrite.spans.filter((s) => s.spanID !== "write");
    assert.throws(() => inspectCommandTrace(missingWrite, f.expected, []));
  });
}

for (const source of ["request", "upgrade"])
  for (const field of ["host.name", "process.pid", "service.instance.id"])
    for (const change of ["missing", "different", "duplicate", "invalid"])
      test(`private request rejects ${source} ${field} ${change}`, () => {
        const f = privateBoundaryFixture();
        const process =
          source === "request"
            ? f.trace.processes[f.request.processID]
            : f.connectionTrace.processes[f.connectionTrace.spans[1].processID];
        const original = process.tags.find((item) => item.key === field);
        if (change === "missing")
          process.tags = process.tags.filter((item) => item.key !== field);
        else if (change === "duplicate")
          process.tags.push(structuredClone(original));
        else
          original.value =
            field === "process.pid"
              ? change === "invalid"
                ? 0
                : original.value + 1
              : change === "invalid"
                ? ""
                : "another-process";
        const before = structuredClone([f.trace, f.connectionTrace]);
        assert.throws(() => inspectPlanRequestTrace(f.trace, f.expected));
        assert.deepEqual([f.trace, f.connectionTrace], before);
      });

test("private request selection separates repeated SDK IDs on different connections", () => {
  const first = privateBoundaryFixture(undefined, { connection: 1 });
  const second = privateBoundaryFixture(undefined, { connection: 2 });
  for (const select of [selectRequestTrace, selectCommandTrace]) {
    assert.equal(
      select([first.trace, second.trace], second.expected),
      second.trace.traceID,
    );
    assert.equal(select([first.trace], second.expected), undefined);
    assert.throws(() =>
      select([second.trace, structuredClone(second.trace)], second.expected),
    );
    assert.throws(() => select(Array(100).fill(second.trace), second.expected));
  }
});

test("private selectors bind method, request, Agent, Session, protocol and exact Link span", () => {
  const cases = [
    ["method", (f) => f.field(f.request, "rpc.method", "session/fork")],
    ["request", (f) => f.field(f.request, "antnest.request.id", "3")],
    ["Agent", (f) => f.field(f.request, "antnest.agent.id", "another")],
    ["Session", (f) => f.field(f.request, "antnest.session.id", "another")],
    ["protocol", (f) => f.field(f.request, "antnest.protocol.version", "v2")],
    [
      "Link span",
      (f) => {
        f.request.references[0].spanID = "3".repeat(16);
      },
    ],
    [
      "Link trace",
      (f) => {
        f.request.references[0].traceID = "4".repeat(32);
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const f = privateBoundaryFixture();
    mutate(f);
    assert.equal(selectRequestTrace([f.trace], f.expected), undefined, label);
    assert.equal(selectCommandTrace([f.trace], f.expected), undefined, label);
    assert.throws(() => requestBoundary(f.trace, f.expected), undefined, label);
  }
});

const invalidConnections = [
  [
    "missing raw upgrade",
    (f) => {
      delete f.expected.connectionTrace;
    },
  ],
  [
    "wrong raw trace",
    (f) => {
      f.connectionTrace.traceID = "9".repeat(32);
    },
  ],
  [
    "missing actual CLIENT",
    (f) => {
      f.connectionTrace.spans.shift();
    },
  ],
  [
    "wrong CLIENT identity",
    (f) => {
      f.expected.clientSpanID = "9".repeat(16);
    },
  ],
  [
    "missing upgrade parent",
    (f) => {
      f.connectionTrace.spans[1].references = [];
    },
  ],
  [
    "wrong upgrade parent",
    (f) => {
      f.connectionTrace.spans[1].references[0].spanID = "9".repeat(16);
    },
  ],
  [
    "control listener",
    (f) => f.field(f.connectionTrace.spans[1], "antnest.listener", "control"),
  ],
  [
    "wrong upgrade route",
    (f) => f.field(f.connectionTrace.spans[1], "http.route", "/v2/acp"),
  ],
  [
    "denied upgrade",
    (f) =>
      f.field(f.connectionTrace.spans[1], "http.response.status_code", 401),
  ],
  [
    "failed CLIENT",
    (f) => f.field(f.connectionTrace.spans[0], "otel.status_code", "ERROR"),
  ],
  [
    "unexported random parent",
    (f) => {
      f.connectionTrace.spans[0].references = [
        {
          refType: "CHILD_OF",
          traceID: f.connectionTrace.traceID,
          spanID: "9".repeat(16),
        },
      ];
    },
  ],
  [
    "duplicate upgrade",
    (f) => {
      const other = structuredClone(f.connectionTrace.spans[1]);
      other.spanID = "9".repeat(16);
      f.connectionTrace.spans.push(other);
    },
  ],
  [
    "credential canary",
    (f) => f.field(f.connectionTrace.spans[0], "private", "PRIVATE"),
  ],
  [
    "captured upgrade content",
    (f) => {
      f.connectionTrace.spans[1].logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ];
    },
  ],
];
for (const [label, mutate] of invalidConnections)
  test(`private boundary rejects ${label}`, () => {
    const f = privateBoundaryFixture();
    mutate(f);
    assert.throws(() => requestBoundary(f.trace, f.expected, ["PRIVATE"]));
  });

test("private boundary rejects duplicate, extra-root and incomplete request parentage", () => {
  for (const mutate of [
    (f) => f.trace.spans.push(structuredClone(f.request)),
    (f) => {
      const other = structuredClone(f.request);
      other.spanID = "other";
      f.trace.spans.push(other);
    },
    (f) =>
      f.request.references.push({
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: "missing",
      }),
    (f) =>
      f.request.references.push({
        refType: "FOLLOWS_FROM",
        traceID: "9".repeat(32),
        spanID: "9".repeat(16),
      }),
  ]) {
    const f = privateBoundaryFixture();
    mutate(f);
    assert.throws(() => requestBoundary(f.trace, f.expected));
  }
});

test("private raw warnings remain strict failures across the request and upgrade", () => {
  const f = privateBoundaryFixture();
  f.connectionTrace.spans[1].warnings = ["upgrade warning"];
  f.request.warnings = ["request warning"];
  const result = inspectPlanRequestTrace(f.trace, f.expected);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.warning_count, 2);
  assert.deepEqual(result.warnings, ["request warning", "upgrade warning"]);
});

test("private success cannot hide request errors, capture, secrets or extra execution", () => {
  for (const mutate of [
    (f) => f.field(f.request, "otel.status_code", "ERROR"),
    (f) => f.field(f.request, "private", "PRIVATE"),
    (f) => {
      f.request.logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ];
    },
    (f) => f.add("model", "request", "model.complete"),
  ]) {
    const f = privateBoundaryFixture();
    mutate(f);
    assert.throws(() =>
      inspectPlanRequestTrace(f.trace, f.expected, ["PRIVATE"]),
    );
  }
});

test("boundary selection is explicit and never inferred from missing Gateway spans", () => {
  const privateFixture = privateBoundaryFixture();
  delete privateFixture.expected.boundary;
  assert.throws(() =>
    requestBoundary(privateFixture.trace, privateFixture.expected),
  );
  const gateway = requestFixture();
  gateway.expected.boundary = "private-acp";
  assert.throws(() => requestBoundary(gateway.trace, gateway.expected));
  gateway.expected.boundary = "unknown";
  assert.throws(() => requestBoundary(gateway.trace, gateway.expected));
  delete gateway.expected.boundary;
  assert.equal(
    requestBoundary(gateway.trace, gateway.expected).forwarded.spanID,
    "forward",
  );
});

for (const value of [null, false, 0, "", "unknown"])
  test(`explicit invalid boundary ${JSON.stringify(value)} cannot select Gateway compatibility`, () => {
    const f = commandFixture("request");
    f.expected.boundary = value;
    for (const select of [selectRequestTrace, selectCommandTrace])
      assert.throws(() => select([f.trace], f.expected));
    for (const inspect of [
      requestBoundary,
      inspectPlanRequestTrace,
      inspectCommandTrace,
    ])
      assert.throws(() => inspect(f.trace, f.expected));
  });

const sessionTag = "antnest.session.id";
function withoutSession(f) {
  delete f.expected.sessionId;
  f.request.tags = f.request.tags.filter(({ key }) => key !== sessionTag);
}
for (const method of [
  "session/load",
  "session/resume",
  "session/fork",
  "session/prompt",
  "session/new",
  "session/close",
  "session/delete",
])
  test(`private ${method} requires a real Session even when both expected and raw omit it`, () => {
    for (const value of [undefined, null, "", "   ", 0, false]) {
      const f = privateBoundaryFixture(requestFixture(method));
      if (value === undefined) withoutSession(f);
      else {
        f.expected.sessionId = value;
        f.field(f.request, sessionTag, value);
      }
      for (const select of [selectRequestTrace, selectCommandTrace])
        assert.throws(() => select([f.trace], f.expected));
      assert.throws(() => requestBoundary(f.trace, f.expected));
    }
  });

test("private initialize can omit Session, while successful session/new binds its returned Session", () => {
  const initial = privateBoundaryFixture(requestFixture("initialize"));
  withoutSession(initial);
  initial.expected.kind = "request";
  assert.equal(inspectCommandTrace(initial.trace, initial.expected).runs, 0);
  assert.equal(
    selectRequestTrace([initial.trace], initial.expected),
    initial.trace.traceID,
  );
  const created = privateBoundaryFixture(requestFixture("session/new"));
  created.expected.kind = "request";
  assert.equal(
    inspectCommandTrace(created.trace, created.expected).session_id,
    "session",
  );
});

for (const version of [1, 2])
  test(`private v${version} session/list binds Agent and connection without a single Session`, () => {
    const f = privateBoundaryFixture(requestFixture("session/list"), {
      version,
    });
    withoutSession(f);
    f.expected.kind = "request";
    assert.equal(inspectCommandTrace(f.trace, f.expected).runs, 0);
    for (const select of [selectRequestTrace, selectCommandTrace])
      assert.equal(select([f.trace], f.expected), f.trace.traceID);
    for (const [key, value] of [
      ["antnest.agent.id", "another"],
      ["antnest.request.id", "another"],
      ["antnest.protocol.version", `v${version === 1 ? 2 : 1}`],
    ]) {
      const changed = structuredClone(f.trace);
      f.field(changed.spans[0], key, value);
      assert.throws(() => inspectCommandTrace(changed, f.expected));
      assert.equal(selectRequestTrace([changed], f.expected), undefined);
    }
    f.request.references[0].spanID = "9".repeat(16);
    assert.throws(() => inspectCommandTrace(f.trace, f.expected));
  });

test("private denied session/new permits no Session only with the exact access denial", () => {
  for (const field of ["denial", "rejection"]) {
    const f = privateBoundaryFixture(requestFixture("session/new"));
    withoutSession(f);
    Object.assign(f.expected, { [field]: "access_denied", kind: "request" });
    f.field(f.request, "antnest.outcome", "rejected");
    f.field(f.request, "rpc.response.status_code", -32020);
    f.field(f.request, "antnest.error.code", "-32020");
    const inspect =
      field === "denial" ? inspectPlanRequestTrace : inspectCommandTrace;
    assert.equal(inspect(f.trace, f.expected)[field], "access_denied");
    assert.equal(selectRequestTrace([f.trace], f.expected), f.trace.traceID);
    f.expected[field] = "session_access_denied";
    assert.throws(() => requestBoundary(f.trace, f.expected));
  }
});

test("a denial flag from another inspector cannot disguise a successful session/new without Session", () => {
  const f = privateBoundaryFixture(requestFixture("session/new"));
  withoutSession(f);
  Object.assign(f.expected, { denial: "access_denied", kind: "request" });
  assert.throws(() => inspectCommandTrace(f.trace, f.expected));
  assert.throws(() => requestBoundary(f.trace, f.expected));
  for (const select of [selectRequestTrace, selectCommandTrace])
    assert.equal(select([f.trace], f.expected), undefined);
});

for (const missing of [
  "antnest.outcome",
  "rpc.response.status_code",
  "antnest.error.code",
])
  test(`session/new without Session requires the actual denial ${missing}`, () => {
    const f = privateBoundaryFixture(requestFixture("session/new"));
    withoutSession(f);
    f.expected.rejection = "access_denied";
    f.field(f.request, "antnest.outcome", "rejected");
    f.field(f.request, "rpc.response.status_code", -32020);
    f.field(f.request, "antnest.error.code", "-32020");
    f.request.tags = f.request.tags.filter(({ key }) => key !== missing);
    assert.throws(() => requestBoundary(f.trace, f.expected));
    for (const select of [selectRequestTrace, selectCommandTrace])
      assert.equal(select([f.trace], f.expected), undefined);
  });

for (const [key, value] of [
  ["otel.status_code", 2],
  ["error.type", "UpgradeError"],
  ["exception.type", "UpgradeError"],
  ["antnest.outcome", "failed"],
  ["antnest.outcome", "failure"],
  ["antnest.outcome", "cancelled"],
])
  test(`private upgrade rejects ${key}=${value} on its CLIENT, SERVER or event`, () => {
    for (const position of [0, 1])
      for (const event of [false, true]) {
        const f = privateBoundaryFixture();
        const span = f.connectionTrace.spans[position];
        if (event) span.logs = [{ fields: [{ key, value }] }];
        else f.field(span, key, value);
        for (const select of [selectRequestTrace, selectCommandTrace])
          assert.throws(() => select([f.trace], f.expected));
        assert.throws(() => inspectPlanRequestTrace(f.trace, f.expected));
      }
  });

for (const name of ["error", "exception", "antnest.error"])
  test(`private upgrade rejects ${name} events without an error span status`, () => {
    const f = privateBoundaryFixture();
    f.connectionTrace.spans[1].logs = [
      { fields: [{ key: "event", value: name }] },
    ];
    assert.throws(() => inspectPlanRequestTrace(f.trace, f.expected));
  });

test("private upgrade keeps an empty error.type neutral without suppressing another failure", () => {
  const f = privateBoundaryFixture();
  for (const span of f.connectionTrace.spans) f.field(span, "error.type", "");
  assert.equal(
    inspectPlanRequestTrace(f.trace, f.expected).strict_trace,
    "passed",
  );
  f.field(f.connectionTrace.spans[1], "otel.status_code", 2);
  assert.throws(() => inspectPlanRequestTrace(f.trace, f.expected));
});
