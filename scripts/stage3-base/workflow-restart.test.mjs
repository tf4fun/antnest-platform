import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./trace-fixtures.mjs";
import { inspectLifecycle } from "./trace.mjs";
import { traceTopology } from "../observability/trace-tree.mjs";

function restart() {
  const f = fixture("rebuild"),
    t = f.trace;
  f.expected.workerRestart = true;
  const set = (s, key, value) => {
    s.tags = s.tags.filter((x) => x.key !== key);
    if (value !== undefined) s.tags.push({ key, value });
  };
  const get = (id) => t.spans.find((s) => s.spanID === id);
  const old = get("workflow");
  set(old, "temporalRunID", "workflow-run");
  set(old, "span.kind", "server");
  set(old, "antnest.temporal.workflow.span_end", "worker_shutdown");
  old.duration = 26;
  const resumed = structuredClone(old);
  resumed.spanID = "resumed-workflow";
  resumed.duration = 100;
  set(resumed, "antnest.temporal.workflow.span_end", "workflow_return");
  t.spans.push(resumed);
  const tree = traceTopology(t),
    drain = get("lifecycle.drain");
  // Temporal retains the original scheduling parent for the retry. Only later
  // freshly scheduled phases belong to the replacement Workflow span.
  for (const s of t.spans)
    if (
      s.operationName.startsWith("RunActivity:") &&
      s !== drain &&
      s.spanID !== "admit_lifecycle"
    )
      s.references[0].spanID = resumed.spanID;
  for (const s of t.spans)
    if (tree.chain(s).includes(resumed) && s !== resumed) s.startTime += 10;
  const children = t.spans.filter((s) => tree.chain(s).includes(drain));
  for (const original of children) {
    const clone = structuredClone(original);
    clone.spanID = `retry-${original.spanID}`;
    clone.startTime += 10;
    clone.references = clone.references.map((ref) => ({
      ...ref,
      spanID: children.some((s) => s.spanID === ref.spanID)
        ? `retry-${ref.spanID}`
        : ref.spanID,
    }));
    t.spans.push(clone);
  }
  const journal = get("sql-lifecycle.drain");
  journal.operationName = "SELECT";
  set(journal, "db.operation.name", "SELECT");
  set(
    journal,
    "db.query.text",
    "SELECT request_id, phase FROM agent_controller.agent_lifecycle_operations WHERE request_id = $1",
  );
  const ack = structuredClone(get("retry-sql-lifecycle.drain"));
  ack.spanID = "interrupted-publication-ack";
  ack.startTime = drain.startTime + 1;
  ack.references[0].spanID = drain.spanID;
  set(
    ack,
    "db.query.text",
    "UPDATE agent_controller.execution_configuration_sync SET applied_revision=GREATEST(applied_revision, $2) WHERE organization_id=$1 AND revision >= $2",
  );
  t.spans.push(ack);
  set(drain, "otel.status_code", "ERROR");
  set(
    drain,
    "otel.status_description",
    "agent-acp-service dependency failed with dependency_unavailable",
  );
  const client = get("settle-agent-client"),
    server = get("settle-agent");
  client.operationName = "HTTP POST agent-acp-service";
  for (const [key, value] of Object.entries({
    "rpc.method": "settle_agent",
    "server.address": "agent-acp-service",
    "antnest.outcome": "canceled",
    "error.type": "canceled",
    "antnest.error.code": "canceled",
    "otel.status_code": "ERROR",
  }))
    set(client, key, value);
  set(client, "antnest.settlement.outcome", undefined);
  set(server, "http.response.status_code", undefined);
  set(server, "antnest.outcome", "disconnected");
  set(server, "error.type", "stream_interrupted");
  set(server, "otel.status_code", "ERROR");
  for (const id of [
    "apply-execution-snapshot",
    "retry-apply-execution-snapshot",
  ])
    set(get(id), "antnest.configuration.revision", 5);
  return { ...f, get, set };
}

test("graceful restart retains both real Workflow parents and the interrupted drain attempt", () => {
  const f = restart(),
    before = JSON.stringify(f.trace);
  const result = inspectLifecycle(f.trace, f.expected);
  assert.equal(result.workflow_spans.length, 2);
  assert.equal(result.activities.filter((a) => a.phase === "drain").length, 2);
  assert.equal(result.restart_error_spans, 3);
  assert.equal(result.platform_probe_errors, 0);
  assert.equal(result.strict_trace, "failed");
  assert.equal(JSON.stringify(f.trace), before);
});

for (const [name, mutate] of [
  [
    "missing publication SQL acknowledgement",
    (f) => {
      f.trace.spans = f.trace.spans.filter(
        (s) => s.spanID !== "interrupted-publication-ack",
      );
    },
  ],
  [
    "unrelated journal read",
    (f) =>
      f.set(
        f.get("sql-lifecycle.drain"),
        "db.query.text",
        "SELECT id FROM agents",
      ),
  ],
  [
    "mutation during interrupted drain",
    (f) => {
      const span = structuredClone(f.get("sql-lifecycle.drain"));
      span.spanID = "unexpected-mutation";
      span.processID = "runtime-controller";
      f.trace.spans.push(span);
    },
  ],
  [
    "missing original parent",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "workflow");
    },
  ],
  [
    "rewritten retry parent",
    (f) => {
      f.get("retry-lifecycle.drain").references[0].spanID = "resumed-workflow";
    },
  ],
  [
    "foreign Workflow Run",
    (f) => f.set(f.get("resumed-workflow"), "temporalRunID", "foreign"),
  ],
  [
    "unmarked shutdown",
    (f) =>
      f.set(
        f.get("workflow"),
        "antnest.temporal.workflow.span_end",
        "workflow_return",
      ),
  ],
  [
    "missing failed attempt",
    (f) => f.set(f.get("lifecycle.drain"), "otel.status_code", undefined),
  ],
  [
    "wrong cancellation",
    (f) => f.set(f.get("settle-agent-client"), "error.type", "timeout"),
  ],
  [
    "foreign canceled operation",
    (f) =>
      f.set(f.get("settle-agent-client"), "antnest.operation.id", "foreign"),
  ],
  [
    "wrong snapshot acknowledgement",
    (f) =>
      f.set(
        f.get("apply-execution-snapshot-client"),
        "antnest.configuration.applied_revision",
        4,
      ),
  ],
  [
    "different retry revision",
    (f) => {
      for (const id of [
        "retry-apply-execution-snapshot-client",
        "retry-settle-agent-client",
      ])
        f.set(f.get(id), "antnest.configuration.applied_revision", 6);
    },
  ],
  [
    "failed first commit",
    (f) =>
      f.set(
        f.get("transaction-lifecycle.drain"),
        "antnest.transaction.outcome",
        "rolled_back",
      ),
  ],
  [
    "unexpected error",
    (f) => f.set(f.get("sql-lifecycle.network_fence"), "error", true),
  ],
  [
    "extra retry",
    (f) => {
      const extra = structuredClone(f.get("retry-lifecycle.drain"));
      extra.spanID = "extra";
      f.trace.spans.push(extra);
    },
  ],
  [
    "implicit restart exemption",
    (f) => {
      delete f.expected.workerRestart;
    },
  ],
])
  test(`restarted lifecycle rejects ${name}`, () => {
    const f = restart();
    mutate(f);
    assert.throws(() => inspectLifecycle(f.trace, f.expected));
  });
