import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costCollectorFixture } from "../acp-cost/collector.fixture.mjs";
import { costControlTraceFixture } from "../acp-cost/control-trace.fixture.mjs";
import { costSessionTraceFixture } from "../acp-cost/session-trace.fixture.mjs";
import { costConfigurationTraceFixture } from "../acp-cost/configuration-trace.fixture.mjs";
import { nativeTraceFixture } from "../acp-multimodal/private-trace.fixture.mjs";

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
  assert.equal(typeof implementation.collectPrivateAccessTrace, "function");
  return implementation.collectPrivateAccessTrace(
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
  } else if (row.kind === "native") {
    row.inputSessionID = row.sessionId;
    row.requestParams = {
      sessionId: row.sessionId,
      prompt: [{ type: "text", text: row.phase }],
    };
    row.requestResult = structuredClone(row.promptReceipt.result);
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
      "native",
      () => {
        const f = nativeTraceFixture({ version });
        f.expected.modelName = "scope-b";
        f.set(f.model, "model.name", "scope-b");
        return f;
      },
    ],
  ].map(([name, make]) => ["v" + version + ":" + name, make]),
);

for (const [name, make] of cases)
  test(
    "access collector retains original " + name + " and complete sources",
    async (t) => {
      const f = recorded(costCollectorFixture(t, make()));
      const before = structuredClone(f.expected),
        raw = structuredClone([...f.raw]);
      const result = await collect(f);
      assert.equal(result.method, f.expected.method);
      assert.equal(result.request_id, f.expected.requestId);
      assert.equal(result.diagnostic_inventory_verified, true);
      assert.equal(
        implementation.privateAccessStrictOutcome([result]).accepted,
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
  test("access collector refuses " + name, async (t) => {
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
  test("access rejection binds " + name, async (t) => {
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
    "access native v" +
      version +
      " retains same-phase foreign Provider evidence",
    async (t) => {
      const f = recorded(
        costCollectorFixture(t, nativeTraceFixture({ version })),
      );
      f.expected.modelName = "native-model";
      f.options.requests.push({
        phase: f.expected.phase,
        trace_id: "f".repeat(32),
        model_span_id: "f".repeat(16),
      });
      await assert.rejects(collect(f));
    },
  );
test("access strict admission preserves refused raw status and original exit 2", () => {
  assert.equal(typeof implementation.privateAccessStrictOutcome, "function");
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
  assert.equal(implementation.privateAccessStrictOutcome([row]).exit_code, 2);
  assert.deepEqual(row, before);
  row.owned_error_spans[0].reason = "unknown";
  assert.equal(implementation.privateAccessStrictOutcome([row]).exit_code, 1);
});
