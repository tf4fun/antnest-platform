import assert from "node:assert/strict";
import test from "node:test";
import { privateFileRequestFixture } from "./private-request.fixture.mjs";

const url = new URL("./requests.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspectPrivate = (f) => {
  assert.equal(
    typeof implementation.inspectPrivateFileRequestTrace,
    "function",
  );
  return implementation.inspectPrivateFileRequestTrace(f.trace, f.expected);
};

for (const version of [1, 2])
  for (const method of [
    "session/new",
    "session/load",
    "session/resume",
    "session/fork",
  ]) {
    test(`private v${version} Files successful ${method} separately binds actual input and result Session`, () => {
      const f = privateFileRequestFixture({ version, method });
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
      test(`private v${version} Files successful ${method} rejects ${label}`, () => {
        const f = privateFileRequestFixture({ version, method });
        mutate(f);
        assert.throws(() => inspectPrivate(f));
      });
  }

test("private Files fork cannot reuse its input Session as the returned Session", () => {
  const f = privateFileRequestFixture({ method: "session/fork" });
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
  test(`private successful Files application rejects ${label}`, () => {
    const f = privateFileRequestFixture({ method: "session/load" });
    mutate(f);
    assert.throws(() => inspectPrivate(f));
  });

test("private successful Files application records the existing same-Node sub-ms endpoint observation without changing raw", () => {
  const f = privateFileRequestFixture({ method: "session/fork" });
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
    "files-application-joined-by-rpc",
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
    test(`private v${version} Files ${method} binds the actual ${denial} receipt and original error origin`, () => {
      const f = privateFileRequestFixture({ version, method, denial });
      const raw = structuredClone([f.trace, f.connectionTrace]);
      const result = inspectPrivate(f);
      assert.equal(result.denial, denial);
      assert(
        result.owned_error_spans.every(
          (row) => row.reason === "files-rejection",
        ),
      );
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
      test(`private v${version} Files ${method} denial rejects ${label}`, () => {
        const f = privateFileRequestFixture({ version, method, denial });
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
      test(`private v${version} Files ${method} replay rejects ${label}`, () => {
        const f = privateFileRequestFixture({ version, method });
        mutate(f);
        assert.throws(() => inspectPrivate(f));
      });

for (const version of [1, 2])
  test(`private v${version} Files replay retains only proven Runtime read cleanup`, () => {
    const f = privateFileRequestFixture({
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
