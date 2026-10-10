import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
);
const { parse } = require("yaml");
const workflow = parse(
  readFileSync(
    new URL("../../.github/workflows/integration.yml", import.meta.url),
    "utf8",
  ),
);
const gate = workflow.jobs.integration;
const selected = {
  CHANGES: "success",
  MODE: "full",
  EVENT: "pull_request",
  DRAFT: "false",
  IMAGES: "skipped",
  BUILDING: "0",
  SUITE: "skipped",
  PLAIN: "0",
  IMAGE_SUITE: "skipped",
  IMAGED: "0",
  OPTIONAL_SUITE: "success",
  OPTIONAL: "1",
};
const check = (changes = {}) =>
  spawnSync("bash", ["-e", "-o", "pipefail", "-c", gate.steps[0].run], {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH, ...selected, ...changes },
  });

test("all selected tiers are dependencies of the required integration result", () => {
  assert.deepEqual(
    new Set(gate.needs),
    new Set(["changes", "images", "suite", "image-suite", "optional-suite"]),
  );
  assert.equal(gate.if, "always()");
  assert.equal(
    gate.steps[0].env.OPTIONAL_SUITE,
    "${{ needs.optional-suite.result }}",
  );
  assert.equal(
    gate.steps[0].env.OPTIONAL,
    "${{ needs.changes.outputs.optional }}",
  );
});

test("a selected Tier C failure, cancellation or skip blocks admission", () => {
  assert.equal(check().status, 0);
  for (const status of ["failure", "cancelled", "skipped", "", "unknown"])
    assert.notEqual(check({ OPTIONAL_SUITE: status }).status, 0, status);
});

test("only unselected matrices may skip, including a docs-only run", () => {
  assert.equal(check({ OPTIONAL: "0", OPTIONAL_SUITE: "skipped" }).status, 0);
  assert.notEqual(
    check({ OPTIONAL: "0", OPTIONAL_SUITE: "success" }).status,
    0,
  );
  for (const [count, result] of [
    ["BUILDING", "IMAGES"],
    ["PLAIN", "SUITE"],
    ["IMAGED", "IMAGE_SUITE"],
    ["OPTIONAL", "OPTIONAL_SUITE"],
  ]) {
    for (const value of ["", "-1", "1x", "unknown"])
      assert.notEqual(
        check({ [count]: value, [result]: "success" }).status,
        0,
        `${count}=${value}`,
      );
    assert.notEqual(
      check({ [count]: "1", [result]: "skipped" }).status,
      0,
      result,
    );
  }
});

test("cancelled workflows and failed selection never produce a successful gate", () => {
  for (const CHANGES of ["failure", "cancelled", "skipped", ""])
    assert.notEqual(check({ CHANGES }).status, 0, CHANGES);
  const cancellation = gate.steps.at(-1);
  assert.equal(cancellation.if, "cancelled()");
  const cancelled = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", cancellation.run],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.notEqual(
    cancelled.status,
    0,
    "cancellation fails even after a successful docs-only gate",
  );
  for (const MODE of ["", "unknown", "ignored"])
    assert.notEqual(check({ MODE }).status, 0, MODE);
  assert.notEqual(check({ MODE: "light", DRAFT: "false" }).status, 0);
  assert.equal(check({ MODE: "light", DRAFT: "true" }).status, 0);
});

test("only normal full runs use the required name, even when selection fails early", () => {
  const expression = gate.name.slice(3, -2).trim();
  const name = ({
    event = "pull_request",
    draft = false,
    suites = "",
    mode,
  } = {}) =>
    runInNewContext(expression, {
      github: { event_name: event, event: { pull_request: { draft } } },
      inputs: { suites },
      needs: { changes: { outputs: { mode } } },
    });
  for (const mode of ["full", undefined]) {
    assert.equal(name({ mode }), "Integration checks");
    assert.equal(name({ event: "push", mode }), "Integration checks");
    assert.equal(
      name({ event: "workflow_dispatch", mode }),
      "Integration checks",
    );
    assert.equal(
      name({ event: "workflow_dispatch", suites: "egress-postgres", mode }),
      "Integration checks (partial)",
    );
    assert.equal(name({ draft: true, mode }), "Integration checks (not run)");
  }
});

test("uploaded evidence excludes generated fixture credentials but retains suite logs and timings", () => {
  const suite = parse(
    readFileSync(
      new URL("../../.github/workflows/_suite.yml", import.meta.url),
      "utf8",
    ),
  );
  const upload = suite.jobs.run.steps.find(
    ({ name }) => name === "Upload evidence",
  );
  assert.equal(upload.if, "always()");
  const excluded = upload.with.path
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("!"))
    .map((line) => line.slice(1));
  const filtered = (path) =>
    excluded.some((pattern) => matchesGlob(path, pattern));
  for (const path of [
    "artifacts/verification/antnest-deployment-1234/deployment.env",
    "artifacts/verification/antnest-deployment-1234/generate-deployment-env.log",
    "artifacts/verification/run/credentials/tokens/service",
    "artifacts/verification/run/private.key",
    "artifacts/verification/run/private.pem",
  ])
    assert(filtered(path), `${path} contains fixture credentials`);
  for (const path of [
    "artifacts/verification/ci-shards/shard-123/first.log",
    "artifacts/verification/ci-shards/shard-123/results.json",
    "artifacts/verification/run/result.json",
  ])
    assert(!filtered(path), `${path} is required verification evidence`);
});
