import { readFile } from "node:fs/promises";
import { inspectServiceLogs, summarizeServiceLogs } from "./evidence.mjs";

const [canaryPath, logPath] = process.argv.slice(2);
const logs = await readFile(logPath, "utf8");
if (canaryPath === "--summary") {
  process.stdout.write(JSON.stringify(summarizeServiceLogs(logs)) + "\n");
} else {
  const { canaries, traceIDs } = JSON.parse(await readFile(canaryPath, "utf8"));
  inspectServiceLogs(logs, canaries, traceIDs);
  process.stdout.write(
    "OIDC correlated service logs and credential canaries: passed\n",
  );
}
