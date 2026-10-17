import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { costCollectorFixture } from "../acp-cost/collector.fixture.mjs";
import { costControlTraceFixture } from "../acp-cost/control-trace.fixture.mjs";
import { costSessionTraceFixture } from "../acp-cost/session-trace.fixture.mjs";
import { closedTraceFixture } from "./closed-trace.fixture.mjs";
import { fixture } from "../acp-commands/trace-fixtures.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";

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
  assert.equal(typeof implementation.collectPrivateRpcLossTrace, "function");
  return implementation.collectPrivateRpcLossTrace(
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
      code: "agent_unavailable",
      retryable: false,
    };
    expected.requestParams = {
      sessionId: expected.sessionId,
      prompt: [{ type: "text", text: "v2-settle-denied" }],
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
    ["barrier", () => closedTraceFixture(version)],
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
    "RpcLoss collector archives the private " +
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
      assert.equal(
        implementation.rpcLossStrictOutcome([result]).accepted,
        true,
      );
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
  test("RpcLoss collector rejects " + name, async (t) => {
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
  test("RpcLoss collector rejects " + name, async (t) => {
    const f = recorded(costCollectorFixture(t, closedTraceFixture(2)));
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
      const f = recorded(costCollectorFixture(t, closedTraceFixture(2))),
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

test("owned private rejection retains strict failure and the original accepted exit code", async (t) => {
  const f = recorded(costCollectorFixture(t, closedTraceFixture(2))),
    report = await collect(f);
  const outcome = implementation.rpcLossStrictOutcome([
    report,
    { strict_trace: "passed" },
  ]);
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.strict_trace, "failed");
  assert.equal(outcome.exit_code, 0);
  assert.equal(
    implementation.rpcLossStrictOutcome([
      report,
      { strict_trace: "failed", evidence_error: "internal" },
    ]).accepted,
    false,
  );
});
