import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./trace-fixtures.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import * as implementation from "./logout-trace.mjs";
function sample() {
  const deletion = fixture("delete");
  const settle = deletion.trace.spans.find((s) => s.spanID === "settle-agent");
  const publication = deletion.trace.spans.find(
    (s) => s.spanID === "apply-execution-snapshot",
  );
  const add = (span, key, value) => {
    const current = span.tags.find((t) => t.key === key);
    if (current) current.value = value;
    else span.tags.push({ key, value });
  };
  add(settle, "rpc.method", "settle_agent");
  add(publication, "rpc.method", "apply_execution_snapshot");
  add(settle, "antnest.organization.id", "organization");
  add(settle, "antnest.agent.id", deletion.expected.agentId);
  add(publication, "antnest.organization.id", "organization");
  add(
    publication,
    "antnest.configuration.revision",
    tag(settle, "antnest.configuration.revision"),
  );
  for (const [id, process] of Object.entries(deletion.trace.processes))
    process.tags = Object.entries({
      "host.name": id,
      "process.pid": 1,
      "service.instance.id": id,
    }).map(([key, value]) => ({ key, value }));
  const end = settle.startTime + settle.duration + 100;
  const trace = {
    traceID: "b".repeat(32),
    processes: structuredClone(deletion.trace.processes),
    spans: [],
  };
  const gateway = deletion.trace.spans.find((s) => s.spanID === "gateway");
  const root = {
    ...structuredClone(gateway),
    traceID: trace.traceID,
    spanID: "browser-root",
    startTime: gateway.startTime - 100,
    duration: 10,
  };
  trace.processes.ui = { serviceName: "agent-ui", tags: [] };
  const ui = {
    ...structuredClone(root),
    spanID: "ui",
    processID: "ui",
    operationName: "agent_ui.http.request",
    references: [
      { refType: "CHILD_OF", traceID: trace.traceID, spanID: root.spanID },
    ],
  };
  const span = {
    traceID: trace.traceID,
    spanID: "stream",
    processID: settle.processID,
    operationName: "HTTP GET /v1/acp",
    startTime: settle.startTime - 10,
    duration: 200,
    references: [
      { refType: "CHILD_OF", traceID: trace.traceID, spanID: ui.spanID },
    ],
    tags: Object.entries({
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/v1/acp",
      "http.status_code": 200,
      "antnest.listener": "workspace",
      error: true,
      "otel.status_code": "ERROR",
      "error.type": "stream_interrupted",
      "antnest.outcome": "disconnected",
    }).map(([key, value]) => ({ key, value })),
    logs: [
      {
        timestamp: end,
        fields: Object.entries({
          event: "antnest.stream.termination",
          reason: "access_denied",
          "error.type": "DomainError",
          source: "learning-notice",
          "antnest.agent.id": deletion.expected.agentId,
          "antnest.organization.id": "organization",
        }).map(([key, value]) => ({ key, value })),
      },
    ],
  };
  trace.spans.push(root, ui, span);
  return {
    deletion,
    trace,
    span,
    root,
    ui,
    settle,
    publication,
    expected: {
      agentId: deletion.expected.agentId,
      principal: { organization_id: "organization" },
      closingLifecycle: deletion.expected,
    },
    collection: {
      traces: new Map([[deletion.trace.traceID, deletion.trace]]),
      archivedTraceIDs: new Set([deletion.trace.traceID]),
    },
  };
}
function inspect(f) {
  assert.equal(typeof implementation.inspectStage3StreamDenial, "function");
  return implementation.inspectStage3StreamDenial(
    { trace: f.trace, tree: traceTopology(f.trace), root: f.root, ui: f.ui },
    f.span,
    f.expected,
    f.collection,
    [],
  );
}
test("post-Logout private access denial belongs to the actual completed Agent Delete", () => {
  const f = sample();
  const before = structuredClone(f.trace);
  assert.equal(inspect(f).reason, "deleted-agent-access-denied");
  assert.deepEqual(f.trace, before);
});
function publishingDeletion(f) {
  const activity = f.deletion.trace.spans.find(
    (s) => s.spanID === "lifecycle.publish",
  );
  const client = structuredClone(
    f.deletion.trace.spans.find(
      (s) => s.spanID === "apply-execution-snapshot-client",
    ),
  );
  client.spanID = "delete-publication-client";
  client.references[0].spanID = activity.spanID;
  client.startTime = activity.startTime;
  client.duration = 6;
  const publication = structuredClone(f.publication);
  publication.spanID = "delete-publication";
  publication.references[0].spanID = client.spanID;
  publication.startTime = client.startTime + 1;
  publication.duration = 4;
  publication.tags.find((row) => row.key === "antnest.configuration.revision")
    .value++;
  f.deletion.trace.spans.push(client, publication);
  f.publication = publication;
  f.span.logs[0].timestamp = publication.startTime + 2;
}
test("published access denial may close a stream before the publication HTTP response", () => {
  const f = sample();
  publishingDeletion(f);
  assert.equal(inspect(f).reason, "deleted-agent-access-denied");
});
test("Delete access revocation may terminate a stream before final publication", () => {
  const f = sample();
  publishingDeletion(f);
  f.span.logs[0].timestamp = f.settle.startTime + f.settle.duration + 1;
  assert.equal(inspect(f).reason, "deleted-agent-access-denied");
});
test("Delete access revocation may terminate a stream before settlement responds", () => {
  const f = sample();
  f.span.logs[0].timestamp = f.publication.startTime + f.publication.duration;
  assert.equal(inspect(f).reason, "deleted-agent-access-denied");
});
test("private termination cannot precede the original Delete publication", () => {
  const f = sample();
  f.span.logs[0].timestamp = f.publication.startTime - 1;
  assert.throws(() => inspect(f));
});
for (const [name, change] of [
  [
    "other lifecycle",
    (f) => {
      f.expected.closingLifecycle.kind = "disable";
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.expected.agentId = "foreign";
    },
  ],
  [
    "missing raw Delete",
    (f) => {
      f.collection.archivedTraceIDs.clear();
    },
  ],
  [
    "unfinished Delete",
    (f) => {
      f.deletion.trace.spans = f.deletion.trace.spans.filter(
        (s) => s.spanID !== "lifecycle.runtime_delete",
      );
    },
  ],
  [
    "foreign ACP process",
    (f) => {
      f.trace.processes[f.span.processID].tags[0].value = "other";
    },
  ],
  [
    "foreign publication revision",
    (f) => {
      f.publication.tags.find(
        (row) => row.key === "antnest.configuration.revision",
      ).value++;
    },
  ],
  [
    "wrong reason",
    (f) => {
      f.span.logs[0].fields.find((x) => x.key === "reason").value = "unknown";
    },
  ],
  [
    "extra error event",
    (f) => {
      f.span.logs.push({
        timestamp: f.span.logs[0].timestamp,
        fields: [{ key: "event", value: "exception" }],
      });
    },
  ],
  [
    "extra error metadata",
    (f) => {
      f.span.tags.push({ key: "exception.message", value: "unknown" });
    },
  ],
])
  test("private termination rejects " + name, () => {
    const f = sample();
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });
