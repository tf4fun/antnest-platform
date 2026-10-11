import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { inspectLifecycle } from "../lifecycle-closeout/evidence.mjs";
import { collectWorkflowObservation } from "./workflow-observation.mjs";
import {
  offlineResolveConfig,
  requireResolveEvidenceDirectory,
} from "./resolve-config.mjs";

const { values } = parseArgs({
  allowNegative: true,
  options: {
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
    admission: { type: "string" },
    request: { type: "string" },
    agent: { type: "string" },
    kind: { type: "string" },
    "resolve-evidence-directory": { type: "string" },
    "resolve-ttl-ms": { type: "string" },
    "capture-rpc-content": { type: "boolean" },
  },
});
for (const key of ["admission", "request", "agent", "kind"])
  assert(values[key], `--${key} is required`);
assert(/^[a-f0-9]{32}$/u.test(values.admission), "invalid admission trace ID");

const directory = requireResolveEvidenceDirectory(
  values["resolve-evidence-directory"],
);
const config = offlineResolveConfig(values);
try {
  const result = await collectWorkflowObservation(
    values.jaeger,
    {
      traceID: values.admission,
      kind: values.kind,
    },
    config,
    {
      directory,
      inspect: (admission) => ({
        ...inspectLifecycle({
          admission,
          requestID: values.request,
          agentID: values.agent,
          kind: values.kind,
        }),
        traces: [
          {
            trace_id: admission.traceID,
            url: `${values.jaeger}/trace/${admission.traceID}`,
            services: [
              ...new Set(
                admission.spans.map(
                  (span) => admission.processes[span.processID].serviceName,
                ),
              ),
            ].sort(),
            spans: admission.spans.length,
          },
        ],
      }),
    },
  );
  // Full-closure error/warning counts replace raw error metadata in stdout.
  console.log(JSON.stringify(result));
  if (result.strict_trace !== "passed") process.exitCode = 1;
} catch {
  console.error(
    "Lifecycle observation failed; inspect the private evidence directory.",
  );
  process.exitCode = 1;
}
