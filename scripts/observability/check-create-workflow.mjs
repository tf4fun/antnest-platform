import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { inspectCreateWorkflow } from "./create-workflow.mjs";

const { values } = parseArgs({
  options: {
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
    trace: { type: "string" },
    request: { type: "string" },
  },
});
assert(/^[a-f0-9]{32}$/u.test(values.trace), "--trace is required");
assert(values.request, "--request is required");
await setTimeout(6000);
const response = await fetch(`${values.jaeger}/api/traces/${values.trace}`, {
  signal: AbortSignal.timeout(10000),
});
assert(response.ok, `Jaeger HTTP ${response.status}`);
const body = await response.json();
assert.equal(body.errors?.length ?? 0, 0);
const result = inspectCreateWorkflow(body.data?.[0], values.request);
// Never persist full trace payloads: development RPC capture may contain secrets.
console.log(
  JSON.stringify({ ...result, url: `${values.jaeger}/trace/${values.trace}` }),
);
