import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { inspectCrashTrace } from "../../e2e/lifecycle-closeout/crash-trace.mjs";
import { durablePath } from "../storage.mjs";
const { values } = parseArgs({
  options: { input: { type: "string" }, output: { type: "string" } },
});
if (!values.input || !values.output)
  throw new Error("--input and --output are required");
values.input = durablePath(values.input);
values.output = durablePath(values.output);
process.umask(0o077);
mkdirSync(dirname(values.output), { recursive: true, mode: 0o700 });
const dir = values.input;
const readJSON = (path) => JSON.parse(readFileSync(durablePath(path)));
const business = readJSON(`${dir}/business.json`);
const results = [];
for (const phase of ["before-create", "after-start"]) {
  const proof = readJSON(`${dir}/${phase}.recovered.private.json`);
  const op = business.traces.find(
    (t) => t.request_id === proof.checkpoint.ac.request_id,
  );
  const trace = readJSON(`${dir}/traces/${op.trace_id}.json`);
  const result = inspectCrashTrace(trace, {
    kind: "rebuild",
    traceID: op.trace_id,
    requestId: op.request_id,
    agentId: op.agent_id,
    crashRecovery: { ...proof, phase },
  });
  results.push(result);
  console.log(
    JSON.stringify({
      phase,
      attempts: result.attempts,
      spans: result.spans,
      missing_parents: result.crash_diagnostics.missing_parents.length,
      strict_trace: result.strict_trace,
    }),
  );
}
writeFileSync(durablePath(values.output), JSON.stringify(results), {
  mode: 0o600,
});
