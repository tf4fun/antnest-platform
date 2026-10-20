import assert from "node:assert/strict";
import test from "node:test";
import { inspectPlanTrace } from "./trace.mjs";
import { executionFixture } from "./trace-fixture.mjs";
import { phases } from "./model.mjs";
import { planPromptInputs } from "./evidence.mjs";
import { privateBoundaryFixture } from "./private-boundary.fixture.mjs";
import {
  addPostPromptInformationRead,
  addToolLifecycleReceipt,
} from "../observability/runtime-information-run-fixtures.mjs";

const inspect = ({ trace, requests, expected }) =>
  inspectPlanTrace(trace, requests, [], expected);

const privatePlan = (version = 1, phase = "execute") =>
  privateBoundaryFixture(executionFixture(`v${version}-${phase}`), {
    version,
  });

test("Plan prompt privacy inventory contains every actual wire input", () => {
  assert.deepEqual(planPromptInputs, [
    "v1-create",
    "v1-execute",
    "v1-invalid",
    "v1-clear",
    "v1-recall",
    "v1-fork",
    "v2-create",
    "v2-execute",
    "v2-invalid",
    "v2-clear",
    "v2-recall",
    "v2-fork",
  ]);
});
for (const version of [1, 2])
  for (const { id } of phases)
    for (const boundary of ["request", "connection"])
      test(`private v${version} ${id} rejects actual prompt input in ${boundary} raw telemetry`, () => {
        const f = privatePlan(version, id);
        const trace = boundary === "request" ? f.trace : f.connectionTrace;
        f.field(trace.spans[0], "data", `observed v${version}-${id} input`);
        const raw = structuredClone([f.trace, f.connectionTrace]);
        assert.throws(() =>
          inspectPlanTrace(f.trace, f.requests, planPromptInputs, f.expected),
        );
        assert.deepEqual([f.trace, f.connectionTrace], raw);
      });

test("private Plan preserves all 12 Runs, variable 22 model requests and two actual writes", () => {
  let runs = 0;
  let models = 0;
  let writes = 0;
  for (const version of [1, 2])
    for (const phase of phases) {
      const f = privatePlan(version, phase.id);
      const original = structuredClone([f.trace, f.connectionTrace]);
      const result = inspect(f);
      assert.equal(result.transport_boundary, "private-acp");
      assert.equal(result.gateway_ancestry, undefined);
      assert.equal(result.timing.acp_start_minus_gateway_us, undefined);
      assert.equal(result.model_requests, f.requests.length);
      assert.equal(result.runtime_tool_calls, phase.remote);
      assert.equal(result.strict_trace, "passed");
      assert.deepEqual([f.trace, f.connectionTrace], original);
      runs++;
      models += result.model_requests;
      writes += result.runtime_tool_calls;
    }
  assert.deepEqual(
    { runs, models, writes },
    { runs: 12, models: 22, writes: 2 },
  );
});

for (const version of [1, 2])
  for (const spanID of ["request", "run", "transaction", "http-0"])
    for (const [key, value, event] of [
      ["otel.status_code", 2, false],
      ["exception.type", "UnexpectedFailure", false],
      ["error.type", "TransportFailure", true],
      ["antnest.outcome", "cancelled", false],
      ["level", "WARN", true],
      ["event", "exception", true],
      ["http.response.status_code", 503, false],
    ])
      test(`private v${version} Plan rejects unowned ${spanID} ${key}=${value} ${event ? "event" : "tag"}`, () => {
        const f = privatePlan(version);
        const span = f.trace.spans.find((item) => item.spanID === spanID);
        if (event)
          span.logs = [{ timestamp: span.startTime, fields: [{ key, value }] }];
        else f.field(span, key, value);
        const original = structuredClone([f.trace, f.connectionTrace]);
        assert.throws(() => inspect(f));
        assert.deepEqual([f.trace, f.connectionTrace], original);
      });

for (const version of [1, 2]) {
  for (const [label, mutate] of [
    [
      "upgrade WARN",
      (f) => {
        f.connectionTrace.spans[1].logs = [
          { timestamp: 0, fields: [{ key: "level", value: "WARN" }] },
        ];
      },
    ],
    [
      "conflicting upgrade status",
      (f) => f.field(f.connectionTrace.spans[0], "http.status_code", 503),
    ],
    [
      "closed prompt",
      (f) => {
        f.expected.closedBeforeResponse = true;
      },
    ],
  ])
    test(`private v${version} Plan execution rejects ${label}`, () => {
      const f = privatePlan(version);
      mutate(f);
      assert.throws(() => inspect(f));
    });

  test(`private v${version} Plan keeps proven Runtime cleanup and protocol-specific reads in original raw form`, () => {
    const f = privatePlan(version);
    for (const id of ["list", "call"])
      addToolLifecycleReceipt(
        f.trace,
        f.trace.spans.find((span) => span.spanID === id),
        {
          cancelledClients: ["discover", "tools/list", "tools/call"],
          cancelledServers: ["discover", "tools/list", "tools/call"],
        },
      );
    if (version === 1)
      addPostPromptInformationRead(f.trace, {
        runtimeOutcome: "canceled",
        clientOutcome: "cancelled",
      });
    const original = structuredClone([f.trace, f.connectionTrace]);
    const result = inspect(f);
    assert.equal(result.post_prompt_information_reads, version === 1 ? 1 : 0);
    assert.equal(result.neutral_diagnostics.length, version === 1 ? 10 : 8);
    for (const record of result.neutral_diagnostics) {
      assert.equal(record.trace_id, f.trace.traceID);
      const span = f.trace.spans.find((item) => item.spanID === record.span_id);
      assert.equal(
        span.logs[record.event_index].timestamp,
        record.event_timestamp_us,
      );
    }
    assert.deepEqual([f.trace, f.connectionTrace], original);
    f.field(
      f.trace.spans.find((span) => span.spanID === "http-0"),
      "otel.status_code",
      2,
    );
    assert.throws(() => inspect(f));
  });

  test(`private v${version} Plan preserves strict raw warnings independently of business success`, () => {
    const f = privatePlan(version, "invalid");
    f.request.warnings = ["clock skew adjustment disabled"];
    f.connectionTrace.spans[1].warnings = ["clock skew adjustment disabled"];
    const original = structuredClone([f.trace, f.connectionTrace]);
    const result = inspect(f);
    assert.equal(result.strict_trace, "failed");
    assert.equal(result.warning_count, 2);
    assert.deepEqual([f.trace, f.connectionTrace], original);
  });
}

test("private v2 Plan cannot borrow the v1 post-prompt Skill catalog refresh", () => {
  const f = privatePlan(2);
  addPostPromptInformationRead(f.trace);
  assert.throws(() => inspect(f), /v2 prompt cannot refresh/u);
});
test("all 12 plan Runs correlate current HTTP spans, persistence and exact local/remote work", () => {
  for (const version of [1, 2])
    for (const phase of phases) {
      const fixture = executionFixture(`v${version}-${phase.id}`);
      const result = inspect(fixture);
      assert.equal(result.runtime_tool_calls, phase.remote);
      assert.equal(result.model_requests, fixture.requests.length);
      assert.equal(result.run_id, "run");
      assert.equal(result.strict_trace, "passed");
    }
});
test("plan trace rejects absent preparation/persistence, extra or misattributed execution", () => {
  for (const mutate of [
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "list");
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "call").tags[0].value = "foreign";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "tool").references[0].spanID =
        "request";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "call").tags[1].value =
        "update_plan";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "model-0").references[0].spanID =
        "request";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "transaction").operationName =
        "postgres.transaction";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "transaction").tags[1].value =
        "rolled_back";
    },
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "insert");
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "info").startTime =
        f.trace.spans.find((s) => s.spanID === "model-0").startTime + 5000;
    },
    (f) => {
      f.trace.spans.push({
        ...structuredClone(f.trace.spans.find((s) => s.spanID === "call")),
        spanID: "extra",
      });
    },
    (f) => {
      f.trace.spans.push({
        ...structuredClone(f.trace.spans.find((s) => s.spanID === "model-0")),
        spanID: "extra",
      });
    },
    (f) => {
      f.requests[0].model_span_id = "model-0";
    },
    (f) => {
      f.requests[1].model_span_id = f.requests[0].model_span_id;
    },
    (f) => {
      f.requests[1].stage = 0;
    },
    (f) => {
      f.expected.sessionId = "foreign";
    },
    (f) => {
      f.expected.connectionTraceID = "foreign";
    },
    (f) => {
      f.add("management", "run", "HTTP POST /internal", "agent-controller");
    },
  ]) {
    const fixture = executionFixture();
    mutate(fixture);
    assert.throws(() => inspect(fixture));
  }
  const local = executionFixture("v1-create");
  local.add("unexpected-tool", "run", "runtime.mcp.tool", "antnest-runtime");
  assert.throws(() => inspect(local));
});
test("invalid-plan is a handled Tool result; execution errors, capture and secrets never pass", () => {
  const fixture = executionFixture("v2-invalid");
  assert.equal(inspect(fixture).strict_trace, "passed");
  fixture.trace.spans[0].warnings = ["clock skew adjustment disabled"];
  assert.equal(inspect(fixture).strict_trace, "failed");
  fixture.trace.spans[0].tags.push({ key: "error", value: true });
  assert.throws(() => inspect(fixture));
  const leaked = executionFixture();
  leaked.trace.spans[0].tags.push({ key: "data", value: "F04_PRIVATE_PLAN" });
  assert.throws(() =>
    inspectPlanTrace(
      leaked.trace,
      leaked.requests,
      ["F04_PRIVATE_PLAN"],
      leaked.expected,
    ),
  );
  const captured = executionFixture();
  captured.trace.spans[0].logs = [
    { fields: [{ key: "antnest.payload.json", value: "{}" }] },
  ];
  assert.throws(() => inspect(captured));
  assert.throws(() =>
    inspectPlanTrace(undefined, fixture.requests, [], fixture.expected),
  );
  assert.throws(() =>
    inspectPlanTrace(fixture.trace, [], [], fixture.expected),
  );
});
