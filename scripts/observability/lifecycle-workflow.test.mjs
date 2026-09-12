import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectWorkflow } from "./lifecycle-workflow.mjs";
import { workflowFixture } from "./workflow-fixtures.mjs";
import { traceTree, tag } from "./trace-tree.mjs";

function removeSubtree(trace, root) {
  const tree = traceTree(trace);
  trace.spans = trace.spans.filter((span) => !tree.chain(span).includes(root));
}

for (const kind of ["create", "rebuild", "disable", "enable", "delete"]) {
  test(`${kind} accepts the complete dependency chain`, () => {
    inspectWorkflow(workflowFixture(kind), "request-test", { kind });
  });
}

for (const [name, mutate] of [
  [
    "non-SERVER Gateway root",
    (trace) => {
      trace.spans
        .find((span) => span.spanID === "gateway")
        .tags.find((field) => field.key === "span.kind").value = "client";
    },
  ],
  [
    "non-SERVER Controller admission",
    (trace) => {
      trace.spans
        .find((span) => span.spanID === "controller")
        .tags.find((field) => field.key === "span.kind").value = "client";
    },
  ],
  [
    "missing fence write",
    (trace) => {
      const span = trace.spans.find(
        (span) =>
          tag(span, "http.route") ===
            "/internal/agent-network-attachments/{agent_id}" &&
          tag(span, "http.request.method") === "PUT",
      );
      if (span) removeSubtree(trace, span);
    },
  ],
  [
    "missing controller projection",
    (trace) => {
      for (const span of trace.spans)
        if (tag(span, "db.query.text"))
          span.processID = "antnest-runtime-egress";
    },
  ],
  [
    "missing commit",
    (trace) => {
      trace.spans = trace.spans.filter(
        (span) => span.operationName !== "COMMIT",
      );
    },
  ],
  [
    "missing client boundary",
    (trace) => {
      const span = trace.spans.find((span) => span.spanID === "controller");
      span.references[0].spanID = "console";
    },
  ],
]) {
  test(`lifecycle evidence rejects ${name}`, () => {
    const trace = workflowFixture("delete");
    mutate(trace);
    assert.throws(() =>
      inspectWorkflow(trace, "request-test", { kind: "delete" }),
    );
  });
}

function payload(span, direction, value) {
  span.logs ??= [];
  span.logs.push({
    fields: [
      { key: "event", value: `antnest.${direction}` },
      { key: "antnest.payload.json", value: JSON.stringify(value) },
    ],
  });
}

test("Runtime absence permits a read-only delete stage only after scoped authority evidence", () => {
  const trace = workflowFixture("delete");
  removeSubtree(
    trace,
    trace.spans.find(
      (span) => span.spanID === "client-rpc-lifecycle.runtime_delete",
    ),
  );
  removeSubtree(
    trace,
    trace.spans.find(
      (span) => span.spanID === "transaction-lifecycle.runtime_delete",
    ),
  );
  const read = structuredClone(
    trace.spans.find(
      (span) => span.spanID === "commit-lifecycle.network_fence",
    ),
  );
  read.spanID = "absent-replay";
  read.operationName = "SELECT";
  read.references[0].spanID = "lifecycle.runtime_delete";
  read.tags = [
    {
      key: "db.query.text",
      value:
        "SELECT * FROM agent_controller.lifecycle_operations WHERE request_id=$1",
    },
  ];
  trace.spans.push(read);
  assert.throws(() =>
    inspectWorkflow(trace, "request-test", { kind: "delete" }),
  );
  const rpc = structuredClone(
    trace.spans.find((span) => span.spanID === "rpc-lifecycle.network_fence"),
  );
  rpc.spanID = "absent-proof";
  rpc.processID = "runtime-controller";
  rpc.references[0].spanID = "absent-proof-client";
  rpc.tags.find((field) => field.key === "http.route").value =
    "/internal/runtimes/{agent_id}";
  rpc.tags.find((field) => field.key === "http.response.status_code").value =
    404;
  payload(rpc, "request", { path: "/internal/runtimes/agent-test" });
  payload(rpc, "response", { code: "runtime_not_found" });
  const client = structuredClone(
    trace.spans.find(
      (span) => span.spanID === "client-rpc-lifecycle.network_fence",
    ),
  );
  client.spanID = "absent-proof-client";
  trace.spans.push(client, rpc);
  inspectWorkflow(trace, "request-test", { kind: "delete" });
  read.tags.push({ key: "error", value: true });
  assert.throws(() =>
    inspectWorkflow(trace, "request-test", { kind: "delete" }),
  );
  read.tags = read.tags.filter((field) => field.key !== "error");
  const write = structuredClone(read);
  write.spanID = "unexpected-write";
  write.operationName = "UPDATE";
  trace.spans.push(write);
  assert.throws(() =>
    inspectWorkflow(trace, "request-test", { kind: "delete" }),
  );
  trace.spans.pop();
  rpc.logs = [];
  payload(rpc, "request", { path: "/internal/runtimes/another-agent" });
  payload(rpc, "response", { code: "runtime_not_found" });
  assert.throws(() =>
    inspectWorkflow(trace, "request-test", { kind: "delete" }),
  );
});

test("missing networks use scoped authoritative absence instead of fictitious writes", () => {
  const trace = workflowFixture("delete");
  for (const [getID, writeID] of [
    ["rpc-lifecycle.network_fence", "close-lifecycle.network_fence"],
    ["get-lifecycle.network_release", "rpc-lifecycle.network_release"],
  ]) {
    removeSubtree(
      trace,
      trace.spans.find((span) => span.spanID === writeID),
    );
    const rpc = trace.spans.find((span) => span.spanID === getID);
    rpc.tags.find((field) => field.key === "http.response.status_code").value =
      404;
    payload(rpc, "request", { path: "/internal/agent-networks/agent-test" });
    payload(rpc, "response", { code: "agent_network_not_found" });
  }
  inspectWorkflow(trace, "request-test", { kind: "delete" });
});

for (const [phase, state, removed] of [
  ["network_fence", "active", "close-lifecycle.network_fence"],
  ["network_release", "quarantined", "rpc-lifecycle.network_release"],
]) {
  test(`${phase} accepts an authoritative already-settled network, not an omitted write`, () => {
    const trace = workflowFixture("delete");
    removeSubtree(
      trace,
      trace.spans.find((span) => span.spanID === removed),
    );
    assert.throws(() =>
      inspectWorkflow(trace, "request-test", { kind: "delete" }),
    );
    const get = trace.spans.find(
      (span) =>
        span.spanID ===
        (phase === "network_fence"
          ? "rpc-lifecycle.network_fence"
          : "get-lifecycle.network_release"),
    );
    payload(get, "response", {
      agent_id: "agent-test",
      state,
      attachment_state: "closed",
    });
    inspectWorkflow(trace, "request-test", { kind: "delete" });
    get.logs = [];
    payload(get, "response", {
      agent_id: "unrelated-agent",
      state,
      attachment_state: "closed",
    });
    assert.throws(() =>
      inspectWorkflow(trace, "request-test", { kind: "delete" }),
    );
  });
}

test("successful Activity redelivery is accepted only for the same SDK activity identity", () => {
  const trace = workflowFixture("delete");
  const original = trace.spans.find(
    (span) => span.spanID === "lifecycle.runtime_delete",
  );
  original.duration = 5;
  const replay = structuredClone(original);
  replay.spanID = "redelivery";
  replay.startTime += 6;
  replay.duration = 2;
  trace.spans.push(replay);
  const query = structuredClone(
    trace.spans.find((span) => span.spanID === "sql-lifecycle.runtime_delete"),
  );
  query.spanID = "redelivery-read";
  query.operationName = "SELECT";
  query.references[0].spanID = replay.spanID;
  query.startTime = replay.startTime;
  query.tags = [
    {
      key: "db.query.text",
      value:
        "SELECT * FROM agent_controller.lifecycle_operations WHERE request_id=$1",
    },
  ];
  trace.spans.push(query);
  assert.throws(() =>
    inspectWorkflow(trace, "request-test", { kind: "delete" }),
  );
  inspectWorkflow(trace, "request-test", {
    kind: "delete",
    allowRetries: true,
  });
  query.operationName = "UPDATE";
  assert.throws(() =>
    inspectWorkflow(trace, "request-test", {
      kind: "delete",
      allowRetries: true,
    }),
  );
  query.operationName = "SELECT";
  query.tags.push({ key: "error", value: true });
  assert.throws(() =>
    inspectWorkflow(trace, "request-test", {
      kind: "delete",
      allowRetries: true,
    }),
  );
  query.tags = query.tags.filter((field) => field.key !== "error");
  replay.tags.find((field) => field.key === "temporalActivityID").value =
    "another-activity";
  assert.throws(() =>
    inspectWorkflow(trace, "request-test", {
      kind: "delete",
      allowRetries: true,
    }),
  );
});

test("new Runtime requires its status verification", () => {
  const trace = workflowFixture();
  const status = trace.spans.find(
    (span) => tag(span, "http.route") === "/status",
  );
  if (status) removeSubtree(trace, status);
  assert.throws(() => inspectWorkflow(trace, "request-test"));
});

test("an uncommitted attempt's closed network cannot excuse the completing attempt's missing fence", () => {
  const trace = workflowFixture("delete");
  removeSubtree(
    trace,
    trace.spans.find((span) => span.spanID === "close-lifecycle.network_fence"),
  );
  const activity = trace.spans.find(
    (span) => span.spanID === "lifecycle.network_fence",
  );
  const old = structuredClone(activity);
  old.spanID = "old-fence";
  old.startTime -= 2;
  old.duration = 1;
  old.tags.push({ key: "error", value: true });
  const rpc = structuredClone(
    trace.spans.find((span) => span.spanID === "rpc-lifecycle.network_fence"),
  );
  rpc.spanID = "old-get";
  rpc.references[0].spanID = "old-client";
  rpc.startTime = old.startTime;
  payload(rpc, "response", {
    agent_id: "agent-test",
    state: "active",
    attachment_state: "closed",
  });
  const client = structuredClone(
    trace.spans.find(
      (span) => span.spanID === "client-rpc-lifecycle.network_fence",
    ),
  );
  client.spanID = "old-client";
  client.references[0].spanID = old.spanID;
  client.startTime = old.startTime;
  trace.spans.push(old, client, rpc);
  assert.throws(() =>
    inspectWorkflow(trace, "request-test", {
      kind: "delete",
      allowRetries: true,
    }),
  );
});

for (const kind of ["create", "rebuild", "disable", "enable", "delete"]) {
  for (const [label, key, value] of [
    ["failed response", "http.response.status_code", 500],
    ["unrelated status probe", "http.route", "/status"],
    ["wrong method", "http.request.method", "GET"],
    ["client without a server", "span.kind", "client"],
    ["error marked response", "error", true],
  ]) {
    test(`${kind} rejects ${label} as Runtime RPC evidence`, () => {
      const trace = workflowFixture(kind);
      const rpc = trace.spans.find(
        (span) =>
          span.spanID.startsWith("rpc-") &&
          span.processID === "runtime-controller",
      );
      rpc.tags = rpc.tags.filter((tag) => tag.key !== key);
      rpc.tags.push({ key, value });
      assert.throws(
        () => inspectWorkflow(trace, "request-test", { kind }),
        /RPC/,
      );
    });
  }
}
