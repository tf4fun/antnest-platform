import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { tag } from "../observability/trace-tree.mjs";
import { privateFileTraceFixture } from "./private-trace.fixture.mjs";
import { cases } from "./model.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const url = new URL("./private-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (f, secrets = []) => {
  assert.equal(typeof implementation.inspectPrivateFileTrace, "function");
  return implementation.inspectPrivateFileTrace(
    f.trace,
    f.requests,
    secrets,
    f.expected,
  );
};
for (const version of [1, 2])
  for (const item of cases)
    test(
      "private Files v" +
        version +
        " " +
        item.id +
        " retains actual tool/result and raw diagnostics",
      () => {
        const f = privateFileTraceFixture("v" + version + "-" + item.id);
        const raw = structuredClone(f.trace);
        const result = inspect(f);
        assert.equal(result.transport_boundary, "private-acp");
        assert.equal(result.model_requests, 2);
        assert.equal(result.runtime_tool_calls, 1);
        assert.equal(result.tool_call_id, f.expected.toolCallId);
        assert.equal(
          result.runtime_tool_outcome,
          item.error ? "tool_error" : "success",
        );
        assert.equal(result.owned_error_spans.length, item.error ? 5 : 0);
        assert.equal(result.strict_trace, item.error ? "failed" : "passed");
        assert.deepEqual(f.trace, raw);
      },
    );

for (const phase of ["v1-read", "v2-failed-edit"])
  for (const [label, identity] of [
    ["another Run", (f) => ["foreign-run", 0, f.expected.phase]],
    [
      "another model request",
      (f) => [tag(f.run, "antnest.run.id"), 1, f.expected.phase],
    ],
    [
      "another provider ID",
      (f) => [tag(f.run, "antnest.run.id"), 0, "foreign-provider-id"],
    ],
  ])
    test(
      "Files rejects mutually consistent live/model Tool IDs from " +
        label +
        " for " +
        phase,
      () => {
        const f = privateFileTraceFixture(phase);
        inspect(f);
        const id = createHash("sha256")
          .update(JSON.stringify(identity(f)))
          .digest("hex");
        f.expected.toolCallId = id;
        f.requests[1].tool_result.tool_call_id = id;
        assert.throws(() => inspect(f), /Tool ID/u);
      },
    );

test("Files rejects a live Tool ID differing from the model history", () => {
  const f = privateFileTraceFixture("v1-read");
  inspect(f);
  f.expected.toolCallId = "a".repeat(64);
  assert.throws(() => inspect(f), /Tool ID/u);
});

for (const phase of ["v1-create", "v2-failed-edit"])
  test("Files accepts original Rust u64 decimal telemetry for " + phase, () => {
    const f = privateFileTraceFixture(phase);
    for (const key of [
      "executor.child.pid",
      "executor.duration_ms",
      "antnest.execution.timeout_ms",
    ])
      setTag(f.executor, key, String(tag(f.executor, key)));
    const raw = structuredClone(f.trace);
    inspect(f);
    assert.deepEqual(f.trace, raw);
  });

for (const key of [
  "executor.child.pid",
  "executor.duration_ms",
  "antnest.execution.timeout_ms",
])
  for (const value of [true, null, "", " 30", "3e4", "-1", "9007199254740992"])
    test(
      "Files rejects malformed executor integer " +
        key +
        " " +
        JSON.stringify(value),
      () => {
        const f = privateFileTraceFixture("v1-create");
        inspect(f);
        setTag(f.executor, key, value);
        assert.throws(() => inspect(f));
      },
    );

for (const failed of [false, true])
  for (const [name, mutate] of [
    [
      "wrong wire request",
      (f) => {
        f.expected.requestId = "foreign";
      },
    ],
    [
      "wrong input Session",
      (f) => {
        f.expected.inputSessionID = "foreign";
      },
    ],
    [
      "closed original prompt",
      (f) => {
        f.expected.closedBeforeResponse = true;
      },
    ],
    [
      "foreign phase",
      (f) => {
        f.expected.phase = "v1-missing";
      },
    ],
    [
      "missing final model",
      (f) => {
        f.requests.pop();
      },
    ],
    [
      "foreign model trace",
      (f) => {
        f.requests[1].trace_id = "9".repeat(32);
      },
    ],
    [
      "duplicate model ID",
      (f) => {
        f.requests[1].model_span_id = f.requests[0].model_span_id;
      },
    ],
    [
      "wrong model stages",
      (f) => {
        f.requests.reverse();
      },
    ],
    [
      "missing original tool result",
      (f) => {
        delete f.requests[1].tool_result;
      },
    ],
    [
      "foreign tool result ID",
      (f) => {
        f.requests[1].tool_result.tool_call_id = "foreign";
      },
    ],
    [
      "forged tool effect",
      (f) => {
        f.requests[1].tool_result.result.effect_state = "unknown";
      },
    ],
    ["failed Run", (f) => setTag(f.run, "run.terminal_class", "failed")],
    [
      "unsettled executor",
      (f) => setTag(f.run, "run.executor_state", "unknown"),
    ],
    [
      "wrong Run effect",
      (f) => setTag(f.run, "run.tool_effect_state", "unknown"),
    ],
    ["wrong tool name", (f) => setTag(f.tool, "mcp.tool.name", "bash")],
    [
      "different Runtime generation",
      (f) => setTag(f.executor, "antnest.runtime.generation", "2"),
    ],
    [
      "foreign executor process",
      (f) => {
        f.trace.processes.foreign = structuredClone(
          f.trace.processes[f.executor.processID],
        );
        f.executor.processID = "foreign";
      },
    ],
    [
      "missing executor",
      (f) => {
        f.trace.spans = f.trace.spans.filter((s) => s !== f.executor);
      },
    ],
    [
      "unjoined executor",
      (f) => {
        f.executor.duration += 100000;
      },
    ],
    ["failed executor exit", (f) => setTag(f.executor, "process.exit.code", 1)],
    [
      "contradictory actual exit signal",
      (f) => setTag(f.executor, "executor.exit.signal", 9),
    ],
    [
      "wrong executor classification",
      (f) => setTag(f.executor, "executor.exit.classification", "failed"),
    ],
    [
      "missing child PID",
      (f) => {
        f.executor.tags = f.executor.tags.filter(
          (r) => r.key !== "executor.child.pid",
        );
      },
    ],
    [
      "extra exception",
      (f) =>
        f.tool.tags.push({ key: "exception.type", value: "UnrelatedFailure" }),
    ],
    [
      "duplicate diagnostic field",
      (f) => f.tool.tags.push({ key: "mcp.tool.outcome", value: "success" }),
    ],
    [
      "extra WARN",
      (f) =>
        (f.run.logs = [
          {
            timestamp: f.run.startTime,
            fields: [{ key: "level", value: "WARN" }],
          },
        ]),
    ],
    [
      "foreign diagnostic event",
      (f) => f.setEvent(f.executor.logs.at(-1), "span_id", "foreign"),
    ],
  ])
    test(
      "private Files " +
        (failed ? "failed edit" : "success") +
        " refuses " +
        name,
      () => {
        const f = privateFileTraceFixture(
          failed ? "v2-failed-edit" : "v1-create",
        );
        inspect(f);
        mutate(f);
        const raw = structuredClone(f.trace);
        assert.throws(() => inspect(f));
        assert.deepEqual(f.trace, raw);
      },
    );

for (const layer of ["call", "server", "operation", "tool", "executor"])
  test("failed edit requires the original exact error at " + layer, () => {
    const f = privateFileTraceFixture("v2-failed-edit");
    inspect(f);
    setTag(f[layer], "error.type", "runtime_failed");
    assert.throws(() => inspect(f));
  });
test("failed-edit diagnostics cannot be borrowed by a successful edit", () => {
  const f = privateFileTraceFixture("v1-failed-edit");
  inspect(f);
  f.expected.phase = "v1-edit";
  for (const request of f.requests) request.phase = f.expected.phase;
  f.requests[1].tool_result.tool_call_id = f.expected.phase;
  assert.throws(() => inspect(f));
});
test("failed-edit protocol outcome cannot borrow a preflight rejection", () => {
  const f = privateFileTraceFixture("v2-failed-edit");
  inspect(f);
  setTag(f.operation, "antnest.operation.outcome", "rejected");
  assert.throws(() => inspect(f));
});
test("private file prompt keeps original cross-process clock warnings and rejects secret capture", () => {
  const f = privateFileTraceFixture("v1-read");
  f.connectionTrace.spans[1].warnings = [
    "clock skew adjustment disabled; not applying calculated delta of 2ms",
  ];
  const raw = structuredClone(f.trace);
  assert.equal(inspect(f).strict_trace, "failed");
  assert.equal(inspect(f).warning_count, 1);
  assert.deepEqual(f.trace, raw);
  f.tool.tags.push({ key: "data", value: "PRIVATE-FILE-CANARY" });
  assert.throws(() => inspect(f, ["PRIVATE-FILE-CANARY"]));
});
