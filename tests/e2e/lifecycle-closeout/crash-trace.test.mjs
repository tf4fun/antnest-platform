import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../stage3-base/trace-fixtures.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { runtimeCommandId } from "../stage3-base/contracts.mjs";
import { inspectCrashTrace } from "./crash-trace.mjs";
function source() {
  const f = fixture("rebuild");
  f.expected.missingSourceGeneration = 1;
  const owner = f.trace.spans.find(
    (s) => s.spanID === "rpc-lifecycle.runtime_update",
  );
  const add = (id, parent, name, time, tags) =>
    f.trace.spans.push({
      spanID: id,
      traceID: f.trace.traceID,
      processID: "runtime-controller",
      operationName: name,
      startTime: owner.startTime + time,
      duration: 1,
      references: [
        { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: parent },
      ],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  const platform = {
    "antnest.agent.id": "agent-test",
    "antnest.outcome": "completed",
    "antnest.platform": "docker",
  };
  add("update", owner.spanID, "runtime.lifecycle.update_runtime", 0, {
    "antnest.agent.id": "agent-test",
    "antnest.operation.id": runtimeCommandId(
      f.expected.requestId,
      "runtime_update",
    ),
    "antnest.result": "completed",
  });
  add("inspect", "update", "runtime.platform.inspect", 1, {
    ...platform,
    "antnest.runtime.generation": 1,
    "antnest.runtime.health": "absent",
    "antnest.runtime.platform_phase": "absent",
    "antnest.runtime.execution_id": "",
  });
  add("missing", "inspect", "HTTP GET docker", 1, {
    "span.kind": "client",
    "peer.service": "docker",
    "http.request.method": "GET",
    "http.response.status_code": 404,
    "antnest.outcome": "absent",
  });
  add("create", "update", "runtime.platform.create", 3, {
    ...platform,
    "antnest.runtime.generation": 2,
  });
  for (const [id, code, time] of [
    ["allocated", 201, 4],
    ["started", 204, 6],
  ])
    add(id, "create", "HTTP POST docker", time, {
      "span.kind": "client",
      "peer.service": "docker",
      "http.request.method": "POST",
      "http.response.status_code": code,
    });
  return f;
}

function crashTrace() {
  const f = source(),
    t = f.trace;
  const activity = t.spans.find((s) => s.spanID === "lifecycle.runtime_update");
  const client = t.spans.find(
    (s) => s.spanID === "client-rpc-lifecycle.runtime_update",
  );
  for (const s of t.spans.filter(
    (s) =>
      s.operationName.startsWith("RunActivity:") || s.spanID === "workflow",
  ))
    s.tags.push({ key: "temporalRunID", value: "workflow-run" });
  activity.tags.push({ key: "temporalActivityID", value: "update" });
  const old = structuredClone(activity);
  old.spanID = "failed-attempt";
  old.startTime -= 2;
  old.duration = 1;
  old.tags.push({ key: "error", value: true });
  const failed = structuredClone(client);
  failed.spanID = "failed-client";
  failed.startTime -= 2;
  failed.duration = 1;
  failed.operationName = "HTTP POST runtime-controller";
  failed.references[0].spanID = old.spanID;
  failed.tags.push(
    { key: "error", value: true },
    { key: "rpc.method", value: "update" },
  );
  t.spans.push(old, failed);
  t.processes["crashed"] = {
    serviceName: "runtime-controller",
    tags: [{ key: "service.instance.id", value: "old" }],
  };
  t.processes["runtime-controller"].tags = [
    { key: "service.instance.id", value: "new" },
  ];
  t.spans.push({
    traceID: t.traceID,
    spanID: "orphan",
    processID: "crashed",
    operationName: "SELECT",
    references: [
      { refType: "CHILD_OF", traceID: t.traceID, spanID: "lost-parent" },
    ],
    tags: [],
  });
  f.expected.crashRecovery = {
    phase: "before-create",
    checkpoint: {
      ac: { request_id: f.expected.requestId },
      rc: { request_id: tag(client, "antnest.operation.request_id") },
    },
    crash: { exit_code: 137, oom_killed: false },
  };
  return f;
}
test("crash trace reports raw missing parents while requiring complete successful recovery", () => {
  const f = crashTrace();
  const result = inspectCrashTrace(f.trace, f.expected);
  assert.equal(result.topology_scope, "completed_recovery");
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.crash_diagnostics.missing_parents.length, 1);
  assert.equal(result.attempts, 2);
  assert.equal(
    f.trace.spans.some((s) => s.spanID === "orphan"),
    true,
  );
});
for (const [name, mutate] of [
  [
    "new-process orphan",
    (f) => {
      f.trace.spans.at(-1).processID = "runtime-controller";
    },
  ],
  [
    "foreign orphan reference",
    (f) => {
      f.trace.spans.at(-1).references[0].traceID = "foreign";
    },
  ],
  [
    "changed child request",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "failed-client")
        .tags.find((t) => t.key === "antnest.operation.request_id").value =
        "wrong";
    },
  ],
  [
    "failed successful activity",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "lifecycle.publish")
        .tags.push({ key: "error", value: true });
    },
  ],
  [
    "missing successful parent",
    (f) => {
      f.trace.spans.find(
        (s) => s.spanID === "client-rpc-lifecycle.runtime_update",
      ).references[0].spanID = "missing";
    },
  ],
  [
    "duplicate span",
    (f) => {
      f.trace.spans.push(f.trace.spans[0]);
    },
  ],
  [
    "captured payload in crashed process",
    (f) => {
      f.trace.spans.at(-1).logs = [
        { fields: [{ key: "antnest.payload.json", value: "secret" }] },
      ];
    },
  ],
  [
    "extra retry",
    (f) => {
      const s = structuredClone(
        f.trace.spans.find((s) => s.spanID === "failed-attempt"),
      );
      s.spanID = "third";
      f.trace.spans.push(s);
    },
  ],
])
  test(`crash trace rejects ${name}`, () => {
    const f = crashTrace();
    mutate(f);
    assert.throws(() => inspectCrashTrace(f.trace, f.expected));
  });

function targetPresent() {
  const f = crashTrace();
  f.expected.crashRecovery.phase = "after-start";
  f.trace.spans = f.trace.spans.filter(
    (s) => !["missing", "allocated", "started"].includes(s.spanID),
  );
  const probe = f.trace.spans.find((s) => s.spanID === "inspect");
  probe.tags.push(
    { key: "error", value: true },
    { key: "antnest.error.code", value: "platform_operation_failed" },
  );
  probe.logs = [
    {
      fields: [
        {
          key: "antnest.error.causes",
          value: '["*errors.errorString: runtime identity conflict"]',
        },
      ],
    },
  ];
  f.trace.spans
    .find((s) => s.spanID === "console")
    .tags.push({ key: "http.response.status_code", value: 202 });
  return f;
}
test("existing-target recovery validates the narrow identity probe and rejects extra effects", () => {
  const f = targetPresent();
  assert.equal(inspectCrashTrace(f.trace, f.expected).strict_trace, "failed");
  const bad = targetPresent();
  bad.trace.spans.find((s) => s.spanID === "inspect").logs[0].fields[0].value =
    '["network timeout"]';
  assert.throws(() => inspectCrashTrace(bad.trace, bad.expected));
  const missing = targetPresent();
  missing.trace.spans = missing.trace.spans.filter(
    (s) => s.spanID !== "lifecycle.publish",
  );
  assert.throws(() => inspectCrashTrace(missing.trace, missing.expected));
});

for (const [name, change] of [
  [
    "extra Docker mutation",
    (f) => {
      const s = structuredClone(
        f.trace.spans.find((s) => s.spanID === "inspect"),
      );
      s.spanID = "extra-post";
      s.operationName = "HTTP POST docker";
      s.tags = [
        { key: "peer.service", value: "docker" },
        { key: "http.request.method", value: "POST" },
      ];
      delete s.logs;
      f.trace.spans.push(s);
    },
  ],
  [
    "foreign target error",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "inspect")
        .tags.find((t) => t.key === "antnest.agent.id").value = "foreign";
    },
  ],
  [
    "missing committed publication",
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "sql-lifecycle.publish")
        .tags.find((t) => t.key === "db.operation.name").value = "SELECT";
    },
  ],
])
  test(`existing-target recovery rejects ${name}`, () => {
    const f = targetPresent();
    change(f);
    assert.throws(() => inspectCrashTrace(f.trace, f.expected));
  });

test("Controller downtime may add transport retries without another mutation attempt", () => {
  const f = crashTrace();
  for (const id of ["failed-attempt", "failed-client"]) {
    const s = structuredClone(f.trace.spans.find((s) => s.spanID === id));
    s.spanID = "downtime-" + id;
    s.startTime += 1;
    for (const r of s.references)
      if (r.spanID === "failed-attempt") r.spanID = "downtime-failed-attempt";
    f.trace.spans.push(s);
  }
  assert.equal(inspectCrashTrace(f.trace, f.expected).attempts, 3);
});
