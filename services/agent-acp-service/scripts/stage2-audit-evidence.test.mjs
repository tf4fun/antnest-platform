import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectAuditBoundary } from "./stage2-boundary-evidence.mjs";

function fixture() {
  const services = ["edge-gateway", "admin-console", "agent-acp-service"];
  const trace = { traceID: "audit", spans: [], processes: {} };
  let parent;
  for (const service of services) {
    trace.processes[service] = { serviceName: service };
    const id = `${service}-server`;
    trace.spans.push({
      traceID: trace.traceID,
      spanID: id,
      processID: service,
      operationName: "HTTP request",
      tags: [
        { key: "span.kind", value: "server" },
        { key: "http.response.status_code", value: 200 },
        ...(service === "agent-acp-service"
          ? [{ key: "rpc.method", value: "list_execution_audits" }]
          : []),
      ],
      references: parent ? [{ refType: "CHILD_OF", traceID: "audit", spanID: parent }] : [],
    });
    parent = `${service}-client`;
    trace.spans.push({
      traceID: trace.traceID,
      spanID: parent,
      processID: service,
      operationName: service === "agent-acp-service" ? "SELECT" : "HTTP POST",
      tags: [{ key: "span.kind", value: "client" }],
      references: [{ refType: "CHILD_OF", traceID: "audit", spanID: id }],
    });
  }
  return trace;
}

test("audit evidence proves the authenticated Gateway to Console to ACP path", () => {
  assert.equal(inspectAuditBoundary(fixture()).trace_id, "audit");
});

for (const [name, mutate] of [
  ["missing Console", (trace) => (trace.processes["admin-console"].serviceName = "other")],
  ["wrong ACP method", (trace) => (trace.spans[4].tags[2].value = "apply_execution_snapshot")],
  ["execution side effect", (trace) => (trace.spans[5].operationName = "agent.run")],
  ["detached ACP", (trace) => (trace.spans[4].references = [])],
])
  test(`audit evidence rejects ${name}`, () => {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => inspectAuditBoundary(trace));
  });
