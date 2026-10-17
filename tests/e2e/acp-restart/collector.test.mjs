import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { costCollectorFixture } from "../acp-cost/collector.fixture.mjs";
import { costControlTraceFixture } from "../acp-cost/control-trace.fixture.mjs";
import { costSessionTraceFixture } from "../acp-cost/session-trace.fixture.mjs";
import { barrierTraceFixture } from "../acp-progress/control-trace.fixture.mjs";
import { fixture } from "../acp-commands/trace-fixtures.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { restartStrictOutcome } from "./trace.mjs";

const url = new URL("./collector.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const collect = (f) => {
  assert.equal(typeof implementation.collectPrivateRestartTrace, "function");
  return implementation.collectPrivateRestartTrace(
    "http://jaeger",
    f.expected,
    f.options,
  );
};
function recorded(f) {
  const expected = f.expected;
  expected.version = expected.protocolVersion;
  if (expected.requestReceipt) {
    expected.requestParams = structuredClone(expected.requestReceipt.params);
    expected.requestResult = structuredClone(expected.requestReceipt.result);
    delete expected.requestReceipt;
  }
  if (expected.rejection) {
    expected.outcome = "failed";
    expected.failure = "original Runtime barrier refusal";
    expected.failureCode = -32020;
    expected.failureData = {
      code: "runtime_barrier_required",
      retryable: false,
    };
    expected.requestParams = {
      sessionId: expected.sessionId,
      prompt: [{ type: "text", text: "unresolved-denied" }],
    };
  }
  return f;
}
const cases = [1, 2].flatMap((version) =>
  [
    ["initialize", () => costControlTraceFixture({ version })],
    ["new", () => costSessionTraceFixture({ version })],
    [
      "replay",
      () =>
        costSessionTraceFixture({
          version,
          method: version === 1 ? "session/load" : "session/resume",
        }),
    ],
    ["barrier", () => barrierTraceFixture(version)],
    [
      "ordinary",
      () => {
        const f = privateBoundaryFixture(fixture("ordinary"), { version });
        Object.assign(f.expected, {
          version,
          outcome: "succeeded",
          inputSessionID: f.expected.sessionId,
          requestParams: {
            sessionId: f.expected.sessionId,
            prompt: [{ type: "text", text: f.expected.phase }],
          },
          requestResult:
            version === 1
              ? { stopReason: "end_turn" }
              : { messageId: "original-message" },
        });
        return f;
      },
    ],
  ].map(([name, make]) => ["v" + version + ":" + name, make]),
);

for (const [name, make] of cases)
  test(
    "Restart collector archives the private " +
      name +
      " request and connection",
    async (t) => {
      const f = recorded(costCollectorFixture(t, make())),
        before = structuredClone(f.expected),
        raw = structuredClone([...f.raw]);
      const result = await collect(f);
      assert.equal(result.method, f.expected.method);
      assert.equal(result.request_id, f.expected.requestId);
      assert.equal(result.diagnostic_inventory_verified, true);
      assert.equal(restartStrictOutcome([result]).accepted, true);
      const manifest = JSON.parse(
        readFileSync(join(result.evidence_directory, "manifest.json")),
      );
      assert.equal(manifest.status, "collected");
      assert.equal(manifest.stable_samples, 3);
      assert.deepEqual(f.expected, before);
      assert.deepEqual([...f.raw], raw);
    },
  );

for (const [name, mutate] of [
  [
    "foreign connection",
    (f) => {
      f.expected.connectionTraceID = "f".repeat(32);
    },
  ],
  [
    "foreign request",
    (f) => {
      f.expected.requestId = "foreign";
    },
  ],
  [
    "foreign Session input",
    (f) => {
      f.expected.requestParams.sessionId = "foreign";
    },
  ],
  [
    "missing original result",
    (f) => {
      delete f.expected.requestResult;
    },
  ],
  [
    "completed request borrowing crash exemption",
    (f) => {
      f.expected.kind = "interruption";
    },
  ],
  [
    "Provider on nonexecution Trace",
    (f) => {
      f.options.requests.push({
        trace_id: f.trace.traceID,
        phase: "unexpected",
      });
    },
  ],
  [
    "Provider on connection Trace",
    (f) => {
      f.options.requests.push({
        trace_id: f.connectionTrace.traceID,
        phase: "unexpected",
      });
    },
  ],
])
  test("Restart collector rejects " + name, async (t) => {
    const f = recorded(
      costCollectorFixture(
        t,
        costSessionTraceFixture({ method: "session/load" }),
      ),
    );
    mutate(f);
    await assert.rejects(collect(f));
  });

for (const [name, mutate] of [
  [
    "wrong barrier code",
    (f) => {
      f.expected.rejectionReceipt.code = "agent_busy";
    },
  ],
  [
    "wrong original barrier error",
    (f) => {
      f.expected.failureData.code = "agent_busy";
    },
  ],
  [
    "missing original barrier rejection",
    (f) => {
      f.expected.outcome = "succeeded";
    },
  ],
])
  test("Restart collector rejects " + name, async (t) => {
    const f = recorded(costCollectorFixture(t, barrierTraceFixture(2)));
    mutate(f);
    await assert.rejects(collect(f));
  });

test("a same-phase Provider receipt on another Trace cannot disappear during selection", async (t) => {
  const f = recorded(
    costCollectorFixture(
      t,
      cases.find(([name]) => name === "v1:ordinary")[1](),
    ),
  );
  f.options.requests.push({
    ...f.options.requests[0],
    trace_id: "f".repeat(32),
  });
  await assert.rejects(collect(f));
});

for (const field of ["failureCode", "failureData", "rejectionReceipt"])
  test(
    "invalid original barrier " +
      field +
      " fails without exposing private values",
    async (t) => {
      const f = recorded(costCollectorFixture(t, barrierTraceFixture(2))),
        secret = "PRIVATE_RESTART_BARRIER_CANARY";
      f.options.secrets = [...(f.options.secrets ?? []), secret];
      f.expected[field] =
        field === "failureCode"
          ? secret
          : { ...f.expected[field], private: secret };
      let calls = 0;
      f.options.request = async () => {
        calls++;
        throw new Error("must reject before collection");
      };
      await assert.rejects(collect(f), (error) => {
        assert.equal(inspect(error).includes(secret), false);
        return true;
      });
      assert.equal(calls, 0);
    },
  );

test("cancellation during the final child collection cannot publish success", async (t) => {
  const f = recorded(costCollectorFixture(t, costControlTraceFixture())),
    controller = new AbortController(),
    reason = new Error("original cancellation");
  f.options.signal = controller.signal;
  let calls = 0;
  const request = f.options.request;
  f.options.request = async (...args) => {
    const response = await request(...args);
    if (++calls === 9) controller.abort(reason);
    return response;
  };
  await assert.rejects(collect(f), (error) => error === reason);
});

test("current initialization snapshots are available before connections close or all cases finish", () => {
  assert.equal(typeof implementation.restartTraceInitializations, "function");
  const f = costControlTraceFixture({ version: 2 });
  const row = {
    version: 2,
    kind: "inflight",
    role: "prompt",
    agentId: f.expected.agentId,
    connectionTraceID: f.expected.connectionTraceID,
    clientSpanID: f.expected.clientSpanID,
    closed: false,
    initialization: { ...f.expected },
  };
  delete row.initialization.connectionTrace;
  delete row.initialization.connectionSpanID;
  const before = structuredClone(row);
  const result = implementation.restartTraceInitializations([row]);
  assert.equal(result.length, 1);
  assert.equal(result[0].label, "v2-inflight-prompt-initialize");
  assert.equal(result[0].kind, "request");
  assert.deepEqual(row, before);
  assert.throws(() => implementation.restartTraceInitializations([row, row]));
});

test("owned private diagnostics retain strict failure and cannot excuse a lifecycle failure", async (t) => {
  const f = recorded(costCollectorFixture(t, barrierTraceFixture(2))),
    report = await collect(f),
    interrupted = { strict_trace: "not_applicable", missing_parents: ["lost"] },
    lifecycle = { label: "create", strict_trace: "passed" };
  const accepted = restartStrictOutcome([report, interrupted, lifecycle]);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.strict_trace, "failed");
  assert.equal(
    accepted.exit_code,
    0,
    "Restart keeps its original accepted-diagnostic CLI contract",
  );
  assert.equal(
    restartStrictOutcome([
      report,
      interrupted,
      {
        ...lifecycle,
        strict_trace: "failed",
        evidence_error: "internal failure",
      },
    ]).accepted,
    false,
  );
});

test("post-Rebuild collection retains the original Run and replacement Runtime binding", async (t) => {
  const f = recorded(
    costCollectorFixture(
      t,
      cases.find(([name]) => name === "v2:ordinary")[1](),
    ),
  );
  const binding = {
    run: { run_id: "run", execution_snapshot: { executionRevision: 7 } },
    runtime: { runtime_revision: 3, runtime_execution_id: "execution_test" },
  };
  for (const span of f.trace.spans.filter(
    (row) => row.operationName === "model.complete",
  ))
    for (const [key, value] of Object.entries({
      "antnest.runtime.revision": 3,
      "antnest.runtime.execution_id": "execution_test",
      "antnest.execution.revision": 7,
    }))
      span.tags.push({ key, value });
  f.expected.runtimeBinding = binding;
  assert.equal((await collect(f)).run_id, "run");
  binding.runtime.runtime_execution_id = "old-runtime";
  await assert.rejects(collect(f));
});
