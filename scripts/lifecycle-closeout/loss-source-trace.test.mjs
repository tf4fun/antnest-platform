import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "../stage3-base/trace-fixtures.mjs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
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
    "antnest.error.code": "404",
    "error.type": "protocol_error",
    error: true,
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

test("expected source absence preserves 404 and allocation proof without an ERROR", () => {
  const f = source();
  const probe = f.trace.spans.find((s) => s.spanID === "missing");
  probe.tags = probe.tags.filter(
    (t) => !["error", "error.type", "antnest.error.code"].includes(t.key),
  );
  probe.tags.push({ key: "antnest.outcome", value: "absent" });
  const result = inspectLifecycle(f.trace, f.expected);
  assert.equal(result.strict_trace, "passed");
  assert.equal(result.platform_probe_errors, 0);
  assert.equal(result.platform_absence_probes, 1);
  probe.tags.find((t) => t.key === "antnest.outcome").value = "completed";
  assert.throws(() => inspectLifecycle(f.trace, f.expected));
});
test("missing-source Rebuild requires exact old generation and successful replacement, preserving ERROR", () => {
  const f = source();
  const result = inspectLifecycle(f.trace, f.expected);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.platform_probe_errors, 1);
  for (const mutation of [
    (f) => delete f.expected.missingSourceGeneration,
    (f) => (f.expected.missingSourceGeneration = 2),
    (f) =>
      (f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "allocated")),
    (f) =>
      (f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "started")),
    (f) =>
      (f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "missing")),
    (f) =>
      (f.trace.spans
        .find((s) => s.spanID === "create")
        .tags.find((t) => t.key === "antnest.runtime.generation").value = 1),
    (f) =>
      (f.trace.spans
        .find((s) => s.spanID === "update")
        .tags.find((t) => t.key === "antnest.operation.id").value = "foreign"),
    (f) =>
      (f.trace.spans
        .find((s) => s.spanID === "inspect")
        .tags.find((t) => t.key === "antnest.runtime.health").value =
        "healthy"),
  ]) {
    const changed = source();
    mutation(changed);
    assert.throws(() => inspectLifecycle(changed.trace, changed.expected));
  }
});
