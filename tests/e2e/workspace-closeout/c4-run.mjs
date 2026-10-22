import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evidenceDirectory } from "../../support/storage.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { runC4Flow, c4PublicResult } from "./c4-flow.mjs";
import { createC4Actions } from "./c4-actions.mjs";

process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
const output = evidenceDirectory(
  `artifacts/verification/c4-browser-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const previousMask = process.umask(0o077);
await mkdir(output, { recursive: true, mode: 0o700 });
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("C4 acceptance interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(interrupt, 1200000);
const report = {
  status: "running",
  checks: [],
  sessions: {},
  traces: [],
  cleanup: "pending",
  evidence: output,
};
console.error(`C4 browser evidence: ${output}`);
try {
  await runC4Flow(
    {
      report,
      signal: abort.signal,
      diagnostics: createTraceDiagnostics({
        directory: output,
        signal: abort.signal,
      }),
    },
    createC4Actions({ report, signal: abort.signal, output }),
  );
  process.exitCode = report.exit_code;
  console.log(JSON.stringify(c4PublicResult(report)));
} finally {
  clearTimeout(timer);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  process.umask(previousMask);
}
