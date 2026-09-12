import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowFixture } from "./workflow-fixtures.mjs";
import { inspectCreateWorkflow } from "./create-workflow.mjs";
import { inspectLifecycle } from "../lifecycle-closeout/evidence.mjs";
import { traceTree } from "./trace-tree.mjs";
import { createHash } from "node:crypto";

const fixture = workflowFixture;

test("workflow evidence requires SDK stages under the Gateway and phase-local dependencies", () => {
  assert.equal(
    inspectCreateWorkflow(fixture(), "request-test").activities.length,
    4,
  );
});

test("existing lifecycle collector recognizes the SDK creation path", () => {
  const result = inspectLifecycle({
    admission: fixture(),
    requestID: "request-test",
    agentID: "agent-test",
    kind: "create",
  });
  assert.deepEqual(result.phases, [
    "network_ensure",
    "runtime_initialize",
    "publish",
  ]);
  assert.equal(result.executor, "temporal");
});

test("failed workflow creation requires the executed prefix and failure outcome", () => {
  const trace = fixture();
  const tree = traceTree(trace);
  const publish = trace.spans.find((span) => span.spanID === "publish");
  trace.spans = trace.spans.filter(
    (span) => !tree.chain(span).includes(publish),
  );
  trace.spans
    .find((span) => span.spanID === "workflow")
    .tags.push({ key: "error", value: true });
  assert.throws(
    () =>
      inspectCreateWorkflow(trace, "request-test", {
        outcome: "runtime_start_failed",
      }),
    /failure/,
  );
  const rpc = trace.spans.find(
    (span) => span.spanID === "rpc-runtime_initialize",
  );
  const childID =
    "acr_" +
    createHash("sha256")
      .update("request-test\0runtime_initialize")
      .digest("hex")
      .slice(0, 32);
  trace.spans
    .find((span) => span.spanID === "client-rpc-runtime_initialize")
    .tags.push({ key: "antnest.operation.request_id", value: childID });
  rpc.tags.find((field) => field.key === "http.response.status_code").value =
    503;
  rpc.tags.push({ key: "error", value: true });
  const journal = structuredClone(rpc);
  journal.spanID = "journal";
  journal.startTime += 2;
  journal.references[0].spanID = "journal-client";
  journal.tags = [
    { key: "span.kind", value: "server" },
    { key: "http.request.method", value: "GET" },
    { key: "http.route", value: "/internal/runtime-operations/{request_id}" },
    { key: "http.response.status_code", value: 200 },
  ];
  journal.logs = [
    {
      fields: [
        { key: "event", value: "antnest.response" },
        {
          key: "antnest.payload.json",
          value: JSON.stringify({
            agent_id: "agent-test",
            request_id: childID,
            kind: "initialize_runtime",
            state: "failed",
            effect: "not_started",
            error_code: "image_missing",
          }),
        },
      ],
    },
  ];
  const client = structuredClone(
    trace.spans.find((span) => span.spanID === "client-rpc-runtime_initialize"),
  );
  journal.logs.push({
    fields: [
      { key: "event", value: "antnest.request" },
      {
        key: "antnest.payload.json",
        value: JSON.stringify({
          path: `/internal/runtime-operations/${childID}`,
        }),
      },
    ],
  });
  client.spanID = "journal-client";
  client.startTime = journal.startTime;
  client.tags.find((field) => field.key === "http.request.method").value =
    "GET";
  trace.spans.push(client, journal);
  assert.equal(
    inspectCreateWorkflow(trace, "request-test", {
      outcome: "runtime_start_failed",
    }).activities.length,
    3,
  );
  assert.throws(() => inspectCreateWorkflow(trace, "request-test"));
  const result = journal.logs[0].fields.find(
    (field) => field.key === "antnest.payload.json",
  );
  const original = result.value;
  for (const change of [
    { request_id: "other-request" },
    { kind: "delete_runtime" },
  ]) {
    result.value = JSON.stringify({ ...JSON.parse(original), ...change });
    assert.throws(() =>
      inspectCreateWorkflow(trace, "request-test", {
        outcome: "runtime_start_failed",
      }),
    );
  }
  result.value = original;
  trace.spans = trace.spans.filter((span) => span.spanID !== journal.spanID);
  assert.throws(() =>
    inspectCreateWorkflow(trace, "request-test", {
      outcome: "runtime_start_failed",
    }),
  );
});

for (const [name, mutate] of [
  [
    "missing parent",
    (trace) => {
      trace.spans = trace.spans.filter((span) => span.spanID !== "controller");
    },
  ],
  [
    "duplicate activity",
    (trace) => {
      trace.spans.push({
        ...trace.spans.find((span) => span.spanID === "publish"),
        spanID: "duplicate",
      });
    },
  ],
  [
    "wrong phase dependency",
    (trace) => {
      trace.spans.find(
        (span) => span.spanID === "rpc-runtime_initialize",
      ).processID = "antnest-runtime-egress";
    },
  ],
  [
    "legacy execution",
    (trace) => {
      trace.spans.find((span) => span.spanID === "publish").operationName =
        "recover Agent lifecycle operation";
    },
  ],
  [
    "overlapping stages",
    (trace) => {
      trace.spans.find((span) => span.spanID === "publish").startTime = 10;
    },
  ],
]) {
  test(`workflow evidence rejects ${name}`, () => {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => inspectCreateWorkflow(trace, "request-test"));
  });
}
