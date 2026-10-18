import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as implementation from "./request-trace.mjs";
import {
  privateManagedFixture,
  privateBusyFixture,
} from "./private-trace.fixture.mjs";
import { set, eventField } from "../acp-progress/trace.fixture.mjs";
import { addToolLifecycleReceipt } from "../observability/runtime-information-run-fixtures.mjs";

const inspect = (f) => {
  assert.equal(typeof implementation.inspectPrivateManagedTrace, "function");
  return implementation.inspectPrivateManagedTrace(
    f.trace,
    f.expected,
    ["PRIVATE"],
    f.requests ?? [],
  );
};
for (const version of [1, 2]) {
  test(`private Managed v${version} retains original Rust completion source metadata`, () => {
    const f = privateManagedFixture(version, "managed-exercise");
    const completed = f.trace.spans.find((span) => span.spanID === "tool")
      .logs[0];
    for (const [key, value] of Object.entries({
      "code.file.path": "src/mcp.rs",
      "code.line.number": 1415,
      "code.module.name": "antnest_runtime::mcp",
      target: "antnest_runtime::mcp",
    }))
      eventField(completed, key, value);
    assert.equal(inspect(f).owned_error_spans.length, 5);
    eventField(completed, "exception.type", "Unknown");
    assert.throws(() => inspect(f));
  });
  test(`private Managed v${version} accepts parsed tool results followed by owned HTTP cleanup`, () => {
    const f = privateManagedFixture(version);
    const owner = f.trace.spans.find((span) => span.spanID === "call");
    addToolLifecycleReceipt(f.trace, owner, {
      cancelledClients: ["discover", "tools/call"],
      cancelledServers: ["discover", "tools/call"],
    });
    const checked = inspect(f);
    assert.equal(checked.runtime_tool_calls, 1);
    assert.equal(
      checked.neutral_diagnostics.filter(
        (row) => row.reason === "completed-runtime-tool-http-disconnect",
      ).length,
      2,
    );
  });
  for (const [name, mutate] of [
    ["event before its work", (s) => (s.logs[0].timestamp = s.startTime - 1)],
    [
      "event after its work",
      (s) => (s.logs[0].timestamp = s.startTime + s.duration + 2),
    ],
    ["negative duration", (s) => (s.duration = -1)],
    ["nonfinite start", (s) => (s.startTime = NaN)],
    ["work before parent", (s) => (s.startTime = 0)],
    ["foreign Agent", (s) => set(s, "antnest.agent.id", "foreign")],
    [
      "foreign generation",
      (s) => set(s, "antnest.runtime.generation", "foreign"),
    ],
  ])
    test(`private Managed v${version} rejects alpha ${name}`, () => {
      const f = privateManagedFixture(version, "managed-exercise");
      mutate(f.trace.spans.find((span) => span.spanID === "stdio"));
      assert.throws(() => inspect(f));
    });
  for (const factory of [privateManagedFixture, privateBusyFixture])
    for (const [name, mutate] of [
      [
        "warning in upgrade",
        (f) => set(f.connectionTrace.spans[0], "level", "WARN"),
      ],
      [
        "failed HTTP in upgrade",
        (f) => {
          const span = structuredClone(f.connectionTrace.spans[1]);
          span.spanID = "f".repeat(16);
          span.references[0].spanID = f.connectionTrace.spans[1].spanID;
          set(span, "http.response.status_code", 500);
          f.connectionTrace.spans.push(span);
        },
      ],
    ])
      test(`private Managed v${version} ${factory.name} rejects ${name}`, () => {
        const f = factory(version);
        mutate(f);
        assert.throws(() => inspect(f));
      });
  for (const phase of ["managed-fresh", "managed-exercise"])
    test(`private Managed v${version} ${phase} preserves actual tool, Provider and pinned revision evidence`, () => {
      const f = privateManagedFixture(version, phase),
        before = structuredClone({ trace: f.trace, expected: f.expected });
      const result = inspect(f);
      assert.equal(
        result.runtime_tool_calls,
        phase === "managed-fresh" ? 1 : 3,
      );
      assert.equal(
        result.owned_error_spans.length,
        phase === "managed-fresh" ? 0 : 5,
      );
      assert.deepEqual(f.trace, before.trace);
      assert.deepEqual(f.expected, before.expected);
    });
  test(`private Managed v${version} busy binds the received RPC error and original registered cause`, () => {
    const f = privateBusyFixture(version);
    const result = inspect(f);
    assert.equal(result.runs, 0);
    assert.equal(result.owned_error_spans.length, 2);
  });
  for (const [name, change] of [
    ["missing actual rejection", (f) => delete f.expected.rejectionReceipt],
    [
      "wrong actual rejection",
      (f) => (f.expected.rejectionReceipt.code = "access_denied"),
    ],
    [
      "retryable rejection",
      (f) => (f.expected.rejectionReceipt.retryable = true),
    ],
    [
      "foreign original cause",
      (f) => set(f.request, "antnest.error.origin_span_id", "foreign"),
    ],
    [
      "unknown same-span error",
      (f) => set(f.application, "exception.message", "unknown"),
    ],
    [
      "wrong registered cause",
      (f) =>
        eventField(f.application.logs[0], "antnest.error.message", "foreign"),
    ],
  ])
    test(`private Managed v${version} busy rejects ${name}`, () => {
      const f = privateBusyFixture(version);
      change(f);
      assert.throws(() => inspect(f));
    });
  for (const [name, change] of [
    ["foreign upgrade", (f) => (f.expected.connectionSpanID = "f".repeat(16))],
    ["wrong request", (f) => (f.expected.requestId = "foreign")],
    [
      "frozen execution drift",
      (f) => (f.expected.snapshot.runtime_execution_id = "foreign"),
    ],
    [
      "missing stdio",
      (f) =>
        (f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "stdio")),
    ],
    [
      "unowned same-span error",
      (f) =>
        set(
          f.trace.spans.find((s) => s.spanID === "stdio"),
          "exception.type",
          "Unknown",
        ),
    ],
    [
      "secret in upgrade",
      (f) => set(f.connectionTrace.spans[0], "private", "PRIVATE"),
    ],
    [
      "unknown error outside tool",
      (f) => set(f.request, "error.type", "Unknown"),
    ],
    [
      "unreceived response bytes",
      (f) =>
        set(
          f.trace.spans.find((s) => s.spanID === "client"),
          "http.response.body.size",
          0,
        ),
    ],
    [
      "missing joined close",
      (f) => f.trace.spans.find((s) => s.spanID === "call").logs.pop(),
    ],
  ])
    test(`private Managed v${version} rejects ${name}`, () => {
      const f = privateManagedFixture(version, "managed-exercise");
      change(f);
      assert.throws(() => inspect(f));
    });
}

test("Managed private collector archives raw sources and accepts only accounted diagnostic failures", async (t) => {
  assert.equal(typeof implementation.collectPrivateManagedTrace, "function");
  const f = privateBusyFixture(),
    directory = mkdtempSync(join(tmpdir(), "managed-collector-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const expected = structuredClone(f.expected);
  delete expected.connectionTrace;
  delete expected.connectionSpanID;
  const calls = [];
  const result = await implementation.collectPrivateManagedTrace(
    "http://jaeger",
    expected,
    {
      directory,
      flush: async () => {},
      wait: async () => {},
      attempts: 4,
      request: async (input) => {
        const url = new URL(input);
        calls.push(url.pathname);
        if (url.pathname === "/api/v3/trace-summaries")
          return Response.json({ summaries: [{ traceId: f.trace.traceID }] });
        const source = url.pathname.endsWith(f.connectionTrace.traceID)
          ? f.connectionTrace
          : f.trace;
        return Response.json({ data: [source] });
      },
    },
  );
  assert(calls.some((x) => x.endsWith(f.connectionTrace.traceID)));
  assert.equal(result.diagnostic_inventory_verified, true);
  assert.equal(result.raw_error_inventory.length, 2);
  assert.deepEqual(implementation.managedStrictOutcome([result]), {
    strict_trace: "failed",
    accepted: true,
    exit_code: 2,
    reviewed_error_spans: 2,
  });
  const files = readdirSync(directory, { recursive: true }).filter((x) =>
    x.endsWith(".json"),
  );
  assert(
    files.some((x) =>
      readFileSync(join(directory, x), "utf8").includes(
        "Operation reported agent_busy",
      ),
    ),
  );
});
