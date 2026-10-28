import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { images, shards } from "./ci-changes.mjs";
import { markdownCell } from "./ci-failure.mjs";

const allowedNames = new Set([
  "Select suites",
  "Integration checks",
  ...shards.map(
    (shard) => `Tier ${shard.id[0].toUpperCase()} / ${shard.name} / Run`,
  ),
  ...Object.keys(images).map((name) => `Image / ${name}`),
]);
const conclusions = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "neutral",
  "action_required",
  "stale",
]);
const stamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : null;
const elapsed = (start, end) => {
  const a = stamp(start),
    b = stamp(end);
  return a !== null && b !== null && b >= a ? b - a : null;
};

export function workflowTiming(run, jobs) {
  assert(Number.isSafeInteger(run.id) && run.id > 0);
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  assert(/^[a-f0-9]{40}$/u.test(run.head_sha));
  const rows = jobs
    .filter((job) => allowedNames.has(job.name))
    .map((job) => {
      const test = job.steps?.find((step) => step.name === "Run suites");
      const build = job.steps?.find((step) => step.name === "Build image");
      return {
        name: job.name,
        conclusion: conclusions.has(job.conclusion)
          ? job.conclusion
          : "pending",
        startOffsetMs: elapsed(run.created_at, job.started_at),
        finishOffsetMs: elapsed(run.created_at, job.completed_at),
        createdToStartMs: elapsed(job.created_at, job.started_at),
        // The jobs API does not expose the matrix-slot acquisition timestamp.
        matrixSlotWaitMs: null,
        runnerQueueMs: null,
        runnerMs: elapsed(job.started_at, job.completed_at),
        setupMs: test ? elapsed(job.started_at, test.started_at) : null,
        testMs: test ? elapsed(test.started_at, test.completed_at) : null,
        buildMs: build ? elapsed(build.started_at, build.completed_at) : null,
        finalizationMs: test
          ? elapsed(test.completed_at, job.completed_at)
          : null,
      };
    });
  const gate = rows.find((row) => row.name === "Integration checks");
  const suites = rows.filter(
    (row) => row.name.startsWith("Tier ") && row.finishOffsetMs !== null,
  );
  const lastSuite =
    suites.sort((a, b) => b.finishOffsetMs - a.finishOffsetMs)[0] ?? null;
  return {
    version: 1,
    runId: run.id,
    attempt: run.run_attempt,
    candidate: run.head_sha,
    scope: "integration-workflow-only",
    complete: Boolean(
      gate &&
      gate.finishOffsetMs !== null &&
      rows.every((row) => row.conclusion !== "pending"),
    ),
    gateConclusion: gate?.conclusion ?? "not_observed",
    integrationGateWallMs: gate?.finishOffsetMs ?? null,
    totalRunnerMs: rows.reduce((sum, row) => sum + (row.runnerMs ?? 0), 0),
    lastSuite,
    jobs: rows,
  };
}

export function timingMarkdown(report) {
  const seconds = (ms) =>
    ms === null ? "unavailable" : (ms / 1000).toFixed(3);
  return [
    "## Integration critical-path timing",
    "",
    `Candidate: ${report.candidate}; attempt: ${report.attempt}; gate: ${report.gateConclusion}.`,
    `Integration gate wall time: ${seconds(report.integrationGateWallMs)} s. Accumulated runner time: ${seconds(report.totalRunnerMs)} s (parallel, not wall time or savings).`,
    "Other workflows, including Repository checks, are outside this measurement. Matrix-slot waiting and runner queueing cannot be separated by the jobs API; null is not zero. Created-to-start includes scheduling/dependency waiting and must not be attributed to runner shortage.",
    "| Job | Start (s) | Finish (s) | Created-to-start (s) | Setup (s) | Build (s) | Test (s) | Finalization (s) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.jobs.map(
      (row) =>
        `| ${markdownCell(row.name)} | ${[row.startOffsetMs, row.finishOffsetMs, row.createdToStartMs, row.setupMs, row.buildMs, row.testMs, row.finalizationMs].map(seconds).join(" | ")} |`,
    ),
    report.lastSuite
      ? `Last suite completion: ${markdownCell(report.lastSuite.name)}. This is the observed completion barrier, not a prediction of savings after rescheduling.`
      : "No completed suite observed.",
  ].join("\n");
}

async function main() {
  const {
    GITHUB_API_URL = "https://api.github.com",
    GITHUB_REPOSITORY,
    GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT,
    GH_TOKEN,
  } = process.env;
  assert(/^[\w.-]+\/[\w.-]+$/u.test(GITHUB_REPOSITORY));
  assert(/^\d+$/u.test(GITHUB_RUN_ID) && /^\d+$/u.test(GITHUB_RUN_ATTEMPT));
  const base = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}`;
  const get = async (url) => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error("workflow timing metadata unavailable");
    return response.json();
  };
  const run = await get(base);
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = await get(`${base}/jobs?per_page=100&page=${page}`);
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
  }
  const report = workflowTiming(run, jobs);
  const output = "artifacts/verification/ci-timing";
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(
    `${output}/timing.json`,
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${timingMarkdown(report)}\n`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error("Workflow timing unavailable; required gates are unchanged.");
    process.exitCode = 1;
  }
}
