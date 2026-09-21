import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../stage3-base/trace-fixtures.mjs";
import { traceTopology } from "../observability/trace-tree.mjs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { runtimeCommandId } from "../stage3-base/contracts.mjs";
function update() {
  const f = fixture("rebuild"),
    t = f.trace;
  const set = (s, k, v) => {
    s.tags = s.tags.filter((x) => x.key !== k);
    if (v !== undefined) s.tags.push({ key: k, value: v });
  };
  const get = (id) => t.spans.find((s) => s.spanID === id);
  const old = get("workflow");
  set(old, "temporalRunID", "workflow-run");
  set(old, "span.kind", "server");
  set(old, "antnest.temporal.workflow.span_end", "worker_shutdown");
  old.duration = 46;
  const resumed = structuredClone(old);
  resumed.spanID = "resumed";
  resumed.duration = 200;
  set(resumed, "antnest.temporal.workflow.span_end", "workflow_return");
  t.spans.push(resumed);
  const target = get("lifecycle.runtime_update"),
    tree = traceTopology(t);
  for (const s of t.spans)
    if (
      s.operationName.startsWith("RunActivity:") &&
      ["lifecycle.network_ensure", "lifecycle.publish"].includes(s.spanID)
    )
      s.references[0].spanID = "resumed";
  for (const s of t.spans)
    if (tree.chain(s).includes(resumed) && s !== resumed) s.startTime += 10;
  const children = t.spans.filter((s) => tree.chain(s).includes(target));
  for (const s of children) {
    const clone = structuredClone(s);
    clone.spanID = "retry-" + s.spanID;
    clone.startTime += 10;
    clone.references = clone.references.map((r) => ({
      ...r,
      spanID: children.some((x) => x.spanID === r.spanID)
        ? "retry-" + r.spanID
        : r.spanID,
    }));
    t.spans.push(clone);
  }
  const journal = get("sql-lifecycle.runtime_update");
  journal.operationName = "SELECT";
  set(journal, "db.operation.name", "SELECT");
  set(
    journal,
    "db.query.text",
    "SELECT request_id FROM agent_controller.agent_lifecycle_operations WHERE request_id = $1",
  );
  set(target, "otel.status_code", "ERROR");
  const child = runtimeCommandId(f.expected.requestId, "runtime_update");
  const clients = t.spans.filter((s) =>
    [
      "client-lifecycle.runtime_update",
      "retry-client-lifecycle.runtime_update",
    ].includes(s.spanID),
  );
  // Fixture names are resolved from the actual server ancestry.
  const servers = t.spans.filter((s) =>
    s.tags.some(
      (x) =>
        x.key === "http.route" &&
        x.value === "/internal/runtimes/{agent_id}/update",
    ),
  );
  const records = servers.map((server, i) => {
    const client = traceTopology(t).parent(server);
    const oldID = client.spanID;
    client.spanID = String(i + 1).repeat(16);
    for (const span of t.spans)
      for (const ref of span.references ?? [])
        if (ref.spanID === oldID) ref.spanID = client.spanID;
    client.operationName = "HTTP POST runtime-controller";
    set(client, "http.response.status_code", 200);
    set(client, "rpc.method", "update");
    set(client, "antnest.operation.request_id", child);
    set(client, "antnest.agent.id", f.expected.agentId);
    if (i === 0) {
      set(client, "http.response.status_code", undefined);
      set(client, "antnest.outcome", "canceled");
      set(client, "error.type", "canceled");
      set(client, "otel.status_code", "ERROR");
    }
    return {
      request_id: child,
      agent_id: f.expected.agentId,
      target_revision: "target",
      request_hash: "same",
      response_hash: "same",
      status: 200,
      delivery: i ? "delivered" : "caller_disconnected",
      traceparent: `00-${t.traceID}-${client.spanID}-01`,
    };
  });
  f.expected.updateRestart = { records };
  return { ...f, get, set };
}
test("normal Update restart preserves original parents and committed response receipt", () => {
  const f = update(),
    raw = JSON.stringify(f.trace);
  const r = inspectLifecycle(f.trace, f.expected);
  assert.equal(r.restart_error_spans, 2);
  assert.equal(r.strict_trace, "failed");
  assert.equal(
    r.activities.filter((a) => a.phase === "runtime_update").length,
    2,
  );
  assert.equal(JSON.stringify(f.trace), raw);
});
for (const [name, mutate] of [
  [
    "missing parent",
    (f) =>
      (f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "workflow")),
  ],
  [
    "wrong child",
    (f) => (f.expected.updateRestart.records[1].request_id = "foreign"),
  ],
  [
    "changed response",
    (f) => (f.expected.updateRestart.records[1].response_hash = "different"),
  ],
  ["expiry", (f) => (f.expected.updateRestart.records[0].delivery = "expired")],
  [
    "lost cancellation",
    (f) =>
      f.set(f.get("lifecycle.runtime_update"), "otel.status_code", undefined),
  ],
  [
    "unrelated SQL",
    (f) =>
      f.set(
        f.get("sql-lifecycle.runtime_update"),
        "db.query.text",
        "SELECT id FROM agents",
      ),
  ],
  [
    "unrelated error",
    (f) => f.set(f.get("sql-lifecycle.network_fence"), "error", true),
  ],
])
  test(`Update restart rejects ${name}`, () => {
    const f = update();
    mutate(f);
    assert.throws(() => inspectLifecycle(f.trace, f.expected));
  });
