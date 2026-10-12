import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { inspectCreateWorkflow } from "./create-workflow.mjs";
import { collectWorkflowObservation } from "./workflow-observation.mjs";
import {
  offlineResolveConfig,
  requireResolveEvidenceDirectory,
} from "./resolve-config.mjs";

const { values } = parseArgs({
  allowNegative: true,
  options: {
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
    trace: { type: "string" },
    request: { type: "string" },
    "resolve-evidence-directory": { type: "string" },
    "resolve-ttl-ms": { type: "string" },
    "capture-rpc-content": { type: "boolean" },
  },
});
assert(/^[a-f0-9]{32}$/u.test(values.trace), "--trace is required");
assert(values.request, "--request is required");
const directory = requireResolveEvidenceDirectory(
  values["resolve-evidence-directory"],
);
const config = offlineResolveConfig(values);
try {
  const result = await collectWorkflowObservation(
    values.jaeger,
    {
      traceID: values.trace,
      kind: "create",
    },
    config,
    {
      directory,
      inspect: (trace) => inspectCreateWorkflow(trace, values.request),
    },
  );
  // Complete captured RPC bodies stay in the private archive, never stdout.
  console.log(
    JSON.stringify({
      ...result,
      url: `${values.jaeger}/trace/${values.trace}`,
    }),
  );
  if (result.strict_trace !== "passed") process.exitCode = 1;
} catch {
  console.error(
    "Create workflow observation failed; inspect the private evidence directory.",
  );
  process.exitCode = 1;
}
