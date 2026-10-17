import assert from "node:assert/strict";
import test from "node:test";
import { inspectOutageCloseCapture } from "./resolve-cache-outage-close-capture.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

function fixture() {
  const originID = "1".repeat(32),
    closeID = "2".repeat(32),
    uiID = "1".repeat(16),
    closeSpanID = "2".repeat(16);
  const origin = {
    traceID: originID,
    processes: { ui: { serviceName: "agent-ui" } },
    spans: [
      {
        traceID: originID,
        spanID: uiID,
        processID: "ui",
        operationName: "agent_ui.http.request",
        startTime: 1000,
        duration: 100,
        tags: fields({ "span.kind": "server" }),
        references: [],
        logs: [],
      },
    ],
  };
  const close = {
    traceID: closeID,
    processes: { ui: { serviceName: "agent-ui" } },
    spans: [
      {
        traceID: closeID,
        spanID: closeSpanID,
        processID: "ui",
        operationName: "agent_ui.acp.close",
        startTime: 2000,
        duration: 100,
        tags: fields({
          "span.kind": "internal",
          "antnest.ui.acp.close.outcome": "failed",
          error: true,
        }),
        references: [
          { refType: "FOLLOWS_FROM", traceID: originID, spanID: uiID },
        ],
        logs: [],
      },
    ],
  };
  const found = { close: [structuredClone(close)], deletion: [] };
  return {
    origin,
    close,
    traces: new Map([
      [originID, origin],
      [closeID, close],
    ]),
    searches: {
      found,
      rounds: {
        close: Array.from({ length: 3 }, () => structuredClone(found.close)),
        deletion: [[], [], []],
      },
      errors: [],
    },
  };
}
const check = (f) => inspectOutageCloseCapture(f.searches, f.traces);

test("complete independent cleanup snapshots preserve failed raw evidence without granting admission", () => {
  const f = fixture(),
    before = structuredClone(f);
  const result = check(f);
  assert.equal(result.status, "captured_owning_admission_pending");
  assert.deepEqual(result.close_span_ids, [
    "2".repeat(32) + ":" + "2".repeat(16),
  ]);
  assert.deepEqual(result.delete_span_ids, []);
  assert.deepEqual(f, before);
});

for (const [name, change] of [
  [
    "unsearched close elsewhere in the full archive",
    (f) => {
      const extra = structuredClone(f.close);
      extra.traceID = "3".repeat(32);
      extra.spans[0].traceID = extra.traceID;
      f.traces.set(extra.traceID, extra);
    },
  ],
  [
    "unsearched DELETE elsewhere in the full archive",
    (f) => {
      const extra = structuredClone(f.origin);
      extra.traceID = "4".repeat(32);
      extra.spans[0].traceID = extra.traceID;
      extra.processes.ui.serviceName = "agent-acp-service";
      extra.spans[0].operationName = "HTTP DELETE /v1/acp";
      extra.spans[0].tags = fields({
        "span.kind": "server",
        "http.request.method": "DELETE",
        "http.route": "/v1/acp",
      });
      f.traces.set(extra.traceID, extra);
    },
  ],
  [
    "missing close rounds",
    (f) => {
      delete f.searches.rounds.close;
    },
  ],
  [
    "only two final rounds",
    (f) => {
      f.searches.rounds.close.pop();
    },
  ],
  [
    "same IDs with changed final diagnostic",
    (f) => {
      f.searches.rounds.close[1][0].warnings = ["different raw warning"];
    },
  ],
  [
    "found differs from the final round",
    (f) => {
      f.searches.found.close[0].warnings = ["late raw warning"];
    },
  ],
  [
    "search process differs from its archive",
    (f) => {
      for (const rows of [f.searches.found.close, ...f.searches.rounds.close])
        rows[0].processes.ui.tags = fields({ "process.pid": 99 });
    },
  ],
  [
    "search warning differs from its archive",
    (f) => {
      for (const rows of [f.searches.found.close, ...f.searches.rounds.close])
        rows[0].warnings = ["hidden raw warning"];
    },
  ],
  [
    "duplicate Trace in a stable search",
    (f) => {
      f.searches.found.close.push(structuredClone(f.close));
      f.searches.rounds.close = Array.from({ length: 3 }, () =>
        structuredClone(f.searches.found.close),
      );
    },
  ],
  [
    "missing raw archive",
    (f) => {
      f.traces.delete(f.close.traceID);
    },
  ],
  [
    "search error",
    (f) => {
      f.searches.errors.push(new Error("query failed"));
    },
  ],
])
  test(`cleanup reconciliation rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => check(f));
  });

test("cleanup convergence may follow earlier incomplete snapshots", () => {
  const f = fixture();
  f.searches.rounds.close.unshift([]);
  assert.equal(check(f).status, "captured_owning_admission_pending");
});

test("a stable unrelated search result cannot stand in for a DELETE inventory", () => {
  const f = fixture();
  f.searches.found.deletion = [structuredClone(f.origin)];
  f.searches.rounds.deletion = Array.from({ length: 3 }, () =>
    structuredClone(f.searches.found.deletion),
  );
  assert.throws(() => check(f), /search.*receiver/);
});
