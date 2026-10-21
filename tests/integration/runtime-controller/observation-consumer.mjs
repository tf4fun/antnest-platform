import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeGoOverlay } from "../../support/go-overlay.mjs";
import { runCommand } from "../../support/run-command.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { GoResults } from "../../support/verification/go-results.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(root, "artifacts/verification/observation-consumer");
const name = `observation-consumer-${Date.now()}-${process.pid}`;
assert(
  process.env.ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL &&
    new URL(
      process.env.ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL,
    ).pathname.endsWith("_test"),
  "an isolated Runtime Controller test database is required",
);
const Replace = {};
for (const service of ["runtime-controller", "agent-controller"]) {
  const overlay = writeGoOverlay({ root, service, output });
  for (const [path, source] of Object.entries(
    JSON.parse(readFileSync(overlay, "utf8")).Replace,
  )) {
    assert(!Replace[path], "duplicate cross-service test source");
    Replace[path] = source;
  }
}
const overlay = resolve(output, `${name}.overlay.json`);
writeEvidenceFile(output, `${name}.overlay.json`, JSON.stringify({ Replace }));
const result = await runCommand({
  command: [
    "go",
    "test",
    "-json",
    "-overlay",
    overlay,
    "-tags=antnest_observation_consumer",
    "-race",
    "-p=1",
    "-count=1",
    "-timeout=4m",
    "-run=^TestRepository(CommittedObservationControllerConsumer|CompletionAndHealthObservationOrder)$",
    "./services/runtime-controller/internal/repository/postgres",
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
  results.accept(JSON.parse(line), console.error);
}
const summary = {
  ...result,
  ...results.summary,
  skipped_tests: results.skipped,
};
writeEvidenceFile(output, `${name}.summary.json`, JSON.stringify(summary));
console.log(JSON.stringify(summary));
assert.equal(result.exit_code, 0, "observation consumer verification failed");
assert.equal(
  results.summary.tests,
  2,
  "both repository and real Controller consumers must run",
);
assert.equal(
  results.summary.skipped,
  0,
  "observation consumer verification cannot skip",
);
