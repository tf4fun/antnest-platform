import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stage3TraceInput } from "./lifecycle-closeout/stage3-trace.mjs";
import { verifyLifecycleTrace } from "./lifecycle-closeout/trace.mjs";

const [base, traceID, operationPath, cookiePath] = process.argv.slice(2);
assert(
  base && traceID && operationPath && cookiePath,
  "expected Jaeger URL, admission trace ID, operation file and cookie jar",
);
const input = stage3TraceInput(
  traceID,
  JSON.parse(await readFile(operationPath, "utf8")),
  await readFile(cookiePath, "utf8"),
);
const evidence = await verifyLifecycleTrace(
  base,
  input.operation,
  input.secrets,
  AbortSignal.timeout(120000),
);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
