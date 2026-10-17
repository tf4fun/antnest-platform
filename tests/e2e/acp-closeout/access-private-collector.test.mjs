import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costCollectorFixture } from "../acp-cost/collector.fixture.mjs";
import { costControlTraceFixture } from "../acp-cost/control-trace.fixture.mjs";
import { costSessionTraceFixture } from "../acp-cost/session-trace.fixture.mjs";
import { costConfigurationTraceFixture } from "../acp-cost/configuration-trace.fixture.mjs";
import { fixture as commandFixture } from "../acp-commands/trace-fixtures.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
function ordinaryFixture({ version }) {
  const f = privateBoundaryFixture(commandFixture("ordinary"), { version });
  f.expected.runId = "run";
  f.expected.phase = `v${version}-owner`;
  for (const row of f.requests) row.phase = f.expected.phase;
  return f;
}

const url = new URL("./access-private-collector.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const collect = (f) => {
  assert.equal(typeof implementation.collectPrivateCloseoutTrace, "function");
  return implementation.collectPrivateCloseoutTrace(
    "http://jaeger",
    f.expected,
    f.options,
  );
};
function recorded(f) {
  const row = f.expected;
  row.version = row.protocolVersion;
  row.outcome = row.rejection ? "failed" : "succeeded";
  const receipt = row.requestReceipt ?? row.listReceipt;
  if (receipt) {
    row.requestParams = structuredClone(receipt.params);
    row.requestResult = structuredClone(receipt.result);
    delete row.requestReceipt;
    delete row.listReceipt;
  } else if (row.rejection) {
    row.failure = "original access refusal";
    row.failureCode = -32020;
    row.failureData = { code: row.rejection, retryable: false };
    row.requestParams = {
      ...(row.inputSessionID ? { sessionId: row.inputSessionID } : {}),
      cwd: "/workspace",
      mcpServers: [],
    };
  } else if (row.kind === "ordinary") {
    row.inputSessionID = row.sessionId;
    row.requestParams = {
      sessionId: row.sessionId,
      prompt: [{ type: "text", text: row.phase }],
    };
    row.requestResult =
      row.protocolVersion === 1
        ? { stopReason: "end_turn" }
        : { messageId: "message" };
  }
  return f;
}
const cases = [1, 2].flatMap((version) =>
  [
    ["initialize", () => costControlTraceFixture({ version })],
    ...[
      "new",
      version === 1 ? "load" : "resume",
      "fork",
      "close",
      "delete",
      "prompt",
    ].map((method) => [
      "deny-" + method,
      () => costControlTraceFixture({ version, method: "session/" + method }),
    ]),
    ["new", () => costSessionTraceFixture({ version })],
    [
      "replay",
      () =>
        costSessionTraceFixture({
          version,
          method: version === 1 ? "session/load" : "session/resume",
        }),
    ],
    [
      "list",
      () => costConfigurationTraceFixture({ version, method: "session/list" }),
    ],
    [
      "ordinary",
      () => {
        return ordinaryFixture({ version });
      },
    ],
  ].map(([name, make]) => ["v" + version + ":" + name, make]),
);

for (const [name, make] of cases)
  test(
    "Closeout collector retains original " + name + " and complete sources",
    async (t) => {
      const f = recorded(costCollectorFixture(t, make()));
      const before = structuredClone(f.expected),
        raw = structuredClone([...f.raw]);
      const result = await collect(f);
      assert.equal(result.method, f.expected.method);
      assert.equal(result.request_id, f.expected.requestId);
      assert.equal(result.diagnostic_inventory_verified, true);
      assert.equal(
        implementation.privateCloseoutStrictOutcome([result]).accepted,
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
    "foreign Session",
    (f) => {
      f.expected.requestParams.sessionId = "foreign";
    },
  ],
  [
    "missing result",
    (f) => {
      delete f.expected.requestResult;
    },
  ],
  [
    "false interruption exemption",
    (f) => {
      f.expected.kind = "interruption";
    },
  ],
  [
    "Provider on read",
    (f) => {
      f.options.requests.push({ trace_id: f.trace.traceID });
    },
  ],
  [
    "Provider on connection",
    (f) => {
      f.options.requests.push({ trace_id: f.connectionTrace.traceID });
    },
  ],
])
  test("Closeout collector refuses " + name, async (t) => {
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
    "RPC code",
    (f) => {
      f.expected.failureCode = -32603;
    },
  ],
  [
    "original data",
    (f) => {
      f.expected.failureData.code = "agent_busy";
    },
  ],
  [
    "receipt",
    (f) => {
      f.expected.rejectionReceipt.retryable = true;
    },
  ],
  [
    "success outcome",
    (f) => {
      f.expected.outcome = "succeeded";
    },
  ],
])
  test("Closeout rejection binds " + name, async (t) => {
    const f = recorded(
      costCollectorFixture(
        t,
        costControlTraceFixture({ version: 2, method: "session/delete" }),
      ),
    );
    mutate(f);
    await assert.rejects(collect(f));
  });
for (const version of [1, 2])
  test(
    "Closeout ordinary v" +
      version +
      " retains same-phase foreign Provider evidence",
    async (t) => {
      const f = recorded(costCollectorFixture(t, ordinaryFixture({ version })));
      f.options.requests.push({
        phase: f.expected.phase,
        trace_id: "f".repeat(32),
        model_span_id: "f".repeat(16),
      });
      await assert.rejects(collect(f));
    },
  );
test("Closeout strict admission preserves refused raw status and original exit 2", () => {
  assert.equal(typeof implementation.privateCloseoutStrictOutcome, "function");
  const error = { trace_id: "a", span_id: "b", reason: "cost-rejection" };
  const row = {
    diagnostic_inventory_verified: true,
    raw_error_inventory: [{ trace_id: "a", span_id: "b" }],
    owned_error_spans: [error],
    error_spans: 1,
    warnings: [],
    warning_count: 0,
    strict_trace: "failed",
  };
  const before = structuredClone(row);
  assert.equal(implementation.privateCloseoutStrictOutcome([row]).exit_code, 2);
  assert.deepEqual(row, before);
  row.owned_error_spans[0].reason = "unknown";
  assert.equal(implementation.privateCloseoutStrictOutcome([row]).exit_code, 1);
});

for (const [name, mutate] of [
  ["foreign durable Run", (f) => (f.expected.runId = "foreign")],
  ["missing durable Run", (f) => delete f.expected.runId],
  [
    "missing Bash call",
    (f) =>
      (f.trace.spans = f.trace.spans.filter(
        (s) => s.operationName !== "mcp.tools.call",
      )),
  ],
  ["wrong model phase", (f) => (f.options.requests[0].phase = "foreign")],
  ["missing model reply", (f) => f.options.requests.pop()],
  [
    "altered prompt input",
    (f) => (f.expected.requestParams.prompt[0].text = "foreign"),
  ],
])
  test(`Closeout ordinary execution rejects ${name}`, async (t) => {
    const f = recorded(
      costCollectorFixture(t, ordinaryFixture({ version: 2 })),
    );
    mutate(f);
    await assert.rejects(collect(f));
  });
