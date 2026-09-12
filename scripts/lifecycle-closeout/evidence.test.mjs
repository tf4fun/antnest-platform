import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectLifecycle, assertEventPage } from "./evidence.mjs";
import { verifyLifecycleTrace } from "./trace.mjs";
import { workflowFixture } from "../observability/workflow-fixtures.mjs";
import { lifecyclePlans } from "../observability/lifecycle-workflow.mjs";

function fixture(kind = "create") {
  return {
    admission: workflowFixture(kind),
    requestID: "request-test",
    agentID: "agent-test",
    kind,
  };
}
for (const kind of Object.keys(lifecyclePlans)) {
  test(
    kind + " requires every SDK activity and its own RPC/SQL descendants",
    () => {
      const f = fixture(kind);
      assert.deepEqual(inspectLifecycle(f).phases, lifecyclePlans[kind]);
    },
  );
  for (const [name, mutate] of [
    [
      "missing stage",
      (t) => {
        t.spans = t.spans.filter(
          (s) =>
            !s.operationName.includes("RunActivity:") ||
            !s.operationName.endsWith("publish"),
        );
      },
    ],
    [
      "missing SQL",
      (t) => {
        t.spans = t.spans.filter((s) => !s.spanID.startsWith("sql-"));
      },
    ],
    [
      "wrong request",
      (t) => {
        t.spans.find((s) => s.spanID === "workflow").tags[0].value =
          "unrelated";
      },
    ],
    [
      "wrong Agent",
      (t) => {
        t.spans
          .find((s) => s.spanID === "controller")
          .tags.find((t) => t.key === "antnest.agent.id").value = "other";
      },
    ],
    [
      "wrong admission",
      (t) => {
        t.spans
          .find((s) => s.spanID === "controller")
          .tags.find((t) => t.key === "http.response.status_code").value = 200;
      },
    ],
    [
      "disconnected workflow",
      (t) => {
        t.spans.find((s) => s.spanID === "workflow").references[0].spanID =
          "gateway";
      },
    ],
    [
      "detached RPC",
      (t) => {
        t.spans.find(
          (s) =>
            s.spanID.startsWith("rpc-") && s.processID === "runtime-controller",
        ).references[0].spanID = "gateway";
      },
    ],
    [
      "failed Activity",
      (t) => {
        t.spans
          .find((s) => s.operationName.startsWith("RunActivity:"))
          .tags.push({ key: "error", value: true });
      },
    ],
    [
      "duplicate Activity",
      (t) => {
        const s = t.spans.find((s) =>
          s.operationName.startsWith("RunActivity:"),
        );
        t.spans.push({ ...s, spanID: "duplicate" });
      },
    ],
    [
      "missing parent",
      (t) => {
        t.spans = t.spans.filter((s) => s.spanID !== "console");
      },
    ],
  ])
    test(kind + " rejects " + name, () => {
      const f = fixture(kind);
      mutate(f.admission);
      assert.throws(() => inspectLifecycle(f));
    });
}
test("collector reads a single complete business trace", async (t) => {
  const f = fixture();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    calls.push(input);
    return Response.json({ data: [f.admission] });
  });
  assert.deepEqual(
    await verifyLifecycleTrace(
      "http://fixture",
      { ...f, traceID: f.admission.traceID },
      ["synthetic-secret"],
    ),
    inspectLifecycle(f),
  );
  assert.equal(calls.length, 1);
});
const event = (sequence, agent = "a") => ({
  global_sequence: sequence,
  event_id: `e-${sequence}`,
  agent_id: agent,
});
test("uses global cursor, permits gaps and preserves empty page cursor", () => {
  assert.equal(
    assertEventPage(
      { events: [event(7), event(12)], next_sequence: 12 },
      4,
      new Set(),
      "a",
    ),
    12,
  );
  assert.equal(
    assertEventPage({ events: [], next_sequence: 12 }, 12, new Set(), "a"),
    12,
  );
});
for (const [name, page, seen] of [
  ["duplicate", { events: [event(7)], next_sequence: 7 }, new Set(["e-7"])],
  ["wrong cursor", { events: [event(7)], next_sequence: 8 }, new Set()],
  ["nonexclusive", { events: [event(4)], next_sequence: 4 }, new Set()],
  ["wrong Agent", { events: [event(7, "b")], next_sequence: 7 }, new Set()],
  ["empty advancing cursor", { events: [], next_sequence: 9 }, new Set()],
])
  test(`rejects event ${name}`, () =>
    assert.throws(() => assertEventPage(page, 4, seen, "a")));
