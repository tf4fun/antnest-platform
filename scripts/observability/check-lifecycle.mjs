import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { inspectLifecycle } from "../lifecycle-closeout/evidence.mjs";
import { traceTree, tag } from "./trace-tree.mjs";

const { values } = parseArgs({
  options: {
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
    admission: { type: "string" },
    request: { type: "string" },
    agent: { type: "string" },
    kind: { type: "string" },
  },
});
for (const key of ["admission", "request", "agent", "kind"])
  assert(values[key], `--${key} is required`);
assert(/^[a-f0-9]{32}$/u.test(values.admission), "invalid admission trace ID");

async function read(path) {
  const response = await fetch(new URL(path, values.jaeger), {
    signal: AbortSignal.timeout(10000),
  });
  assert(response.ok, `Jaeger HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(body.errors?.length ?? 0, 0, "Jaeger query error");
  assert(Array.isArray(body.data), "missing Jaeger data");
  return body.data;
}

function summary(trace) {
  const { service, parent } = traceTree(trace);
  return {
    trace_id: trace.traceID,
    url: `${values.jaeger}/trace/${trace.traceID}`,
    services: [
      ...new Set(Object.values(trace.processes).map((p) => p.serviceName)),
    ].sort(),
    spans: trace.spans.length,
    errors: trace.spans
      .filter((span) => tag(span, "error") === true)
      .map((span) => ({
        service: service(span),
        operation: span.operationName,
        parent_operation: parent(span)?.operationName,
        code: tag(span, "antnest.error.code") ?? tag(span, "error.type"),
      })),
  };
}

// SDK export is asynchronous; do not query before the shared grace period.
await setTimeout(6000);
const [admission] = await read(`/api/traces/${values.admission}`);
assert.equal(admission?.traceID, values.admission, "wrong admission trace");
const result = inspectLifecycle({
  admission,
  requestID: values.request,
  agentID: values.agent,
  kind: values.kind,
});
console.log(
  JSON.stringify({
    ...result,
    traces: [summary(admission)],
  }),
);
