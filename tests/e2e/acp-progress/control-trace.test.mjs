import assert from "node:assert/strict";
import test from "node:test";
import {
  barrierTraceFixture,
  cancelTraceFixture,
} from "./control-trace.fixture.mjs";
import { eventField } from "./trace.fixture.mjs";
import { privateACPDiagnosticInventory } from "../observability/private-acp-inventory.mjs";

const url = new URL("./control-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function inspector(name) {
  assert.equal(typeof implementation[name], "function");
  return implementation[name];
}
const remove = (f, span) =>
  f.trace.spans.splice(f.trace.spans.indexOf(span), 1);
for (const version of [1, 2]) {
  test(`v${version} barrier accepts the original empty cause-type array`, () => {
    const inspect = inspector("inspectProgressBarrierTrace");
    const f = barrierTraceFixture(version);
    eventField(f.application.logs[0], "antnest.error.cause_types", []);
    inspect(f.trace, f.expected, [], []);
  });
  test(`v${version} original barrier rejection accounts for all five admission reads`, () => {
    const inspect = inspector("inspectProgressBarrierTrace");
    const f = barrierTraceFixture(version),
      before = structuredClone(f.trace);
    const report = inspect(f.trace, f.expected, [], []);
    assert.equal(report.barrier_rejection, true);
    assert.equal(report.sql_spans, 5);
    assert.equal(report.model_requests, 0);
    assert.equal(report.owned_error_spans.length, 2);
    const inventory = privateACPDiagnosticInventory(
      [f.trace, f.expected.connectionTrace],
      [report],
      new Set(["progress-barrier-rejection"]),
    );
    assert.equal(inventory.raw_error_inventory.length, 2);
    assert.deepEqual(f.trace, before);
  });
  for (const [name, mutate] of [
    [
      "renamed RPC operation",
      (f) => {
        f.request.operationName = "foreign";
      },
    ],
    ["missing protection read", (f) => remove(f, f.queries[4])],
    ["missing second Session read", (f) => remove(f, f.queries[3])],
    [
      "wrong SQL sequence",
      (f) => {
        f.queries[4].startTime = 3500;
      },
    ],
    [
      "foreign RPC origin",
      (f) => f.set(f.request, "antnest.error.origin_span_id", "foreign"),
    ],
    [
      "wrong barrier code",
      (f) => f.set(f.application, "antnest.error.code", "access_denied"),
    ],
    [
      "wrong original receipt",
      (f) => {
        f.expected.rejectionReceipt.retryable = true;
      },
    ],
    [
      "success receipt",
      (f) => {
        f.expected.requestReceipt = {};
      },
    ],
    [
      "missing original error",
      (f) => {
        f.application.logs = [];
      },
    ],
    [
      "foreign error cause",
      (f) => eventField(f.application.logs[0], "antnest.error.causes", "[]"),
    ],
    ["SQL error", (f) => f.set(f.queries[0], "error", true)],
    ["new Run", (f) => f.add("extra", f.application, "agent.run", 12000, 100)],
    [
      "foreign model receipt",
      (f) => {
        f.requests = [{ trace_id: f.trace.traceID }];
      },
    ],
    [
      "new Runtime call",
      (f) => f.add("extra", f.application, "mcp.runtime.info", 12000, 100),
    ],
    [
      "error before final query",
      (f) => {
        f.application.logs[0].timestamp = 9000;
      },
    ],
    [
      "extra application diagnostic",
      (f) => f.set(f.application, "exception.type", "Injected"),
    ],
    [
      "wrong Session alias",
      (f) => f.set(f.application, "session.id", "foreign"),
    ],
    [
      "missing input Session",
      (f) => {
        f.expected.inputSessionID = null;
      },
    ],
  ])
    test(`v${version} barrier rejects ${name}`, () => {
      const inspect = inspector("inspectProgressBarrierTrace");
      const f = barrierTraceFixture(version);
      mutate(f);
      assert.throws(() => inspect(f.trace, f.expected, [], f.requests ?? []));
    });

  test(`v${version} original cancel notification contains only its joined committed cancellation`, async (t) => {
    const inspect = inspector("inspectProgressCancelTrace");
    const f = await cancelTraceFixture(t, version),
      before = structuredClone(f.trace);
    const report = inspect(f.trace, f.receipt, f.connection, []);
    assert.equal(report.sql_spans, 5);
    assert.equal(report.cancellation_requested, true);
    assert.equal(report.actual_execution_stopped, undefined);
    assert.equal(report.request_id, undefined);
    assert.deepEqual(f.trace, before);
  });
  for (const names of [
    {},
    { "telemetry.sdk.language": "go" },
    { "process.runtime.name": "nodejs", "telemetry.sdk.language": "go" },
  ])
    test(`v${version} join overrun cannot borrow a Node deferral from ${JSON.stringify(names)}`, async (t) => {
      const inspect = inspector("inspectProgressCancelTrace");
      const f = await cancelTraceFixture(t, version);
      f.application.duration =
        f.root.startTime + f.root.duration + 999 - f.application.startTime;
      const resource = f.trace.processes[f.root.processID];
      resource.tags = resource.tags.filter(
        ({ key }) =>
          !["process.runtime.name", "telemetry.sdk.language"].includes(key),
      );
      for (const [key, value] of Object.entries(names))
        resource.tags.push({ key, value });
      assert.throws(() => inspect(f.trace, f.receipt, f.connection, []));
    });
  for (const excess of [999, 1000])
    test(`v${version} proven same Node join keeps the strict ${excess}us boundary`, async (t) => {
      const inspect = inspector("inspectProgressCancelTrace");
      const f = await cancelTraceFixture(t, version);
      f.application.duration =
        f.root.startTime + f.root.duration + excess - f.application.startTime;
      f.trace.processes[f.root.processID].tags.push({
        key: "process.runtime.name",
        value: "nodejs",
      });
      if (excess === 1000)
        assert.throws(() => inspect(f.trace, f.receipt, f.connection, []));
      else {
        const report = inspect(f.trace, f.receipt, f.connection, []);
        assert.equal(report.time_observations.length, 1);
        assert.equal(report.time_observations[0].raw_difference_us, 999);
      }
    });
  for (const [name, mutate] of [
    [
      "only root",
      (f) => {
        f.trace.spans = [f.root];
      },
    ],
    ["missing application", (f) => remove(f, f.application)],
    ["foreign Agent", (f) => f.set(f.application, "agent.id", "foreign")],
    [
      "foreign Session",
      (f) => f.set(f.application, "antnest.session.id", "foreign"),
    ],
    [
      "unlocked Session read",
      (f) =>
        f.set(
          f.queries[1],
          "db.query.text",
          f.authorization.tags.find((r) => r.key === "db.query.text").value,
        ),
    ],
    [
      "terminal Run write",
      (f) =>
        f.set(
          f.queries[2],
          "db.query.text",
          "UPDATE runs SET state = 'completed'",
        ),
    ],
    ["missing COMMIT", (f) => remove(f, f.queries[3])],
    [
      "rolled back transaction",
      (f) => f.set(f.transaction, "antnest.transaction.outcome", "rolled_back"),
    ],
    ["extra SQL", (f) => f.sql("extra", f.application, "SELECT 1", 16000)],
    [
      "borrowed Runtime work",
      (f) => f.add("extra", f.application, "runtime.mcp.tool", 16000, 100),
    ],
    [
      "transaction before authorization",
      (f) => {
        f.transaction.startTime = 3500;
      },
    ],
    [
      "application not joined",
      (f) => {
        f.application.duration = 18000;
      },
    ],
    [
      "late original SQL event",
      (f) => {
        f.queries[1].logs = [
          { timestamp: 20000, fields: [{ key: "event", value: "late" }] },
        ];
      },
    ],
    ["extra error", (f) => f.set(f.queries[0], "error.type", "Injected")],
    [
      "response to notification",
      (f) => f.set(f.root, "rpc.response.status_code", 0),
    ],
    [
      "cloned notification receipt",
      (f) => {
        f.receipt = structuredClone(f.receipt);
      },
    ],
  ])
    test(`v${version} cancel rejects ${name}`, async (t) => {
      const inspect = inspector("inspectProgressCancelTrace");
      const f = await cancelTraceFixture(t, version);
      mutate(f);
      assert.throws(() => inspect(f.trace, f.receipt, f.connection, []));
    });
}
