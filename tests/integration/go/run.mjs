import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeGoOverlay } from "../../support/go-overlay.mjs";
import { runCommand } from "../../support/run-command.mjs";
import { GoResults } from "../../support/verification/go-results.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string", default: "integration" },
    package: { type: "string", default: "..." },
    output: {
      type: "string",
      default: "artifacts/verification/go-integration",
    },
  },
});
const [service, ...args] = positionals;
assert(
  [
    "runtime-controller",
    "agent-controller",
    "identity-service",
    "admin-console",
    "edge-gateway",
  ].includes(service),
  "unknown Go integration service",
);
assert(
  values.package === "..." ||
    /^[a-zA-Z0-9_/-]+(?:\/\.\.\.)?$/.test(values.package),
  "invalid service package",
);
const output = resolve(root, values.output);
const overlay = writeGoOverlay({
  root,
  service,
  output,
  profile: values.profile,
});
const name = `${service}-${values.profile}-${Date.now()}-${process.pid}`;
const result = await runCommand({
  command: [
    "go",
    "test",
    "-json",
    "-overlay",
    overlay,
    "-count=1",
    "-p=1",
    ...args,
    `./services/${service}/${values.package}`,
  ],
  cwd: root,
  output,
  name,
});
const results = new GoResults();
for (const line of readFileSync(resolve(output, `${name}.log`), "utf8").split(
  "\n",
)) {
  if (!line.startsWith("{")) continue;
  try {
    results.accept(JSON.parse(line), () => {});
  } catch {
    /* Go compiler output is retained in the private log. */
  }
}
console.log(
  JSON.stringify({
    ...result,
    service,
    profile: values.profile,
    ...results.summary,
    skipped_tests: results.skipped,
    log: resolve(output, `${name}.log`),
  }),
);
process.exitCode = result.exit_code;
