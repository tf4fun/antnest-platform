import { fixture } from "../stage3-base/trace-fixtures.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { runtimeCommandId } from "../stage3-base/contracts.mjs";

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

export function crashTrace() {
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

export function targetPresent() {
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
