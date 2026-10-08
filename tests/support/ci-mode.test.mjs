import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FULL_LABEL, integrationMode } from "./ci-mode.mjs";

const pr = (action, extra = {}) => ({
  event: "pull_request",
  action,
  draft: false,
  label: "",
  ...extra,
});

test("pull request entry points run the full integration suite", () => {
  for (const action of ["opened", "reopened", "ready_for_review"])
    assert.equal(integrationMode(pr(action)), "full", action);
  assert.equal(integrationMode(pr("labeled", { label: FULL_LABEL })), "full");
});

test("ordinary pushes and drafts run only repository and service checks", () => {
  assert.equal(integrationMode(pr("synchronize")), "light");
  assert.equal(
    integrationMode(pr("synchronize", { label: FULL_LABEL })),
    "light",
    "a label left on the pull request must not make every push full",
  );
  assert.equal(integrationMode(pr("opened", { draft: true })), "light");
  assert.equal(integrationMode(pr("reopened", { draft: true })), "light");
});

test("an unrelated label never starts or replaces an integration run", () => {
  assert.equal(
    integrationMode(pr("labeled", { label: "dependencies" })),
    "ignored",
  );
  assert.equal(integrationMode(pr("edited")), "ignored");
});

test("main pushes and manual runs stay full", () => {
  for (const event of ["push", "workflow_dispatch"])
    assert.equal(integrationMode({ event, action: "", draft: false }), "full");
});

test("the CLI reads the GitHub event from the environment", () => {
  const script = fileURLToPath(new URL("./ci-mode.mjs", import.meta.url));
  const run = (env) =>
    spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: process.env.PATH, ...env },
    });
  const draft = run({
    EVENT: "pull_request",
    ACTION: "opened",
    DRAFT: "true",
  });
  assert.equal(draft.status, 0, draft.stderr);
  assert.equal(draft.stdout, "mode=light\n");
  const labeled = run({
    EVENT: "pull_request",
    ACTION: "labeled",
    DRAFT: "false",
    LABEL: FULL_LABEL,
  });
  assert.equal(labeled.stdout, "mode=full\n");
  assert.notEqual(run({}).status, 0, "a missing event must not default");
});

// GitHub reports a skipped required job as passing, so a run that selects no
// suites must not report a check named `Integration checks` at all.
test("integration.yml reports the required check only from a full run", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/integration.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /pull_request:\n\s+types: \[opened, reopened, ready_for_review, synchronize, labeled\]/u,
  );
  assert.match(
    workflow,
    /node tests\/support\/ci-mode\.mjs >> "\$GITHUB_OUTPUT"/u,
  );
  assert.match(workflow, /mode: \$\{\{ steps\.mode\.outputs\.mode \}\}/u);
  assert.match(
    workflow,
    /name: \$\{\{ needs\.changes\.outputs\.mode == 'full' && 'Integration checks' \|\| 'Integration checks \(not run\)' \}\}/u,
  );
  assert.doesNotMatch(workflow, /^\s+name: Integration checks$/mu);
  // Unrelated label runs get their own group so they cannot cancel a full run.
  assert.match(
    workflow,
    /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\$\{\{ github\.event\.action == 'labeled' && github\.event\.label\.name != 'ci:full' && format\('-\{0\}', github\.run_id\) \|\| '' \}\}/u,
  );
  // Every suite job is gated on the full mode, not only on its selection.
  for (const job of ["images", "suite", "image-suite", "optional-suite"]) {
    const body = workflow.split(new RegExp(`\\n  ${job}:\\n`, "u"))[1];
    assert(body, `${job} job missing`);
    const condition = body
      .split(/\n  [a-z-]+:\n/u)[0]
      .split("\n    if:")[1]
      ?.split(/\n    [a-z-]+:/u)[0];
    assert.match(
      condition ?? "",
      /needs\.changes\.outputs\.mode == 'full'/u,
      `${job} must run only in full mode`,
    );
  }
  assert.match(workflow, /gh pr edit "\$PR" --remove-label 'ci:full'/u);
  assert.equal(FULL_LABEL, "ci:full");
});
