import assert from "node:assert/strict";
import test from "node:test";
import { workflowTiming } from "./ci-timing.mjs";

const at = (seconds) =>
  new Date(Date.UTC(2026, 9, 28) + seconds * 1000).toISOString();
const job = (name, start, end, steps = []) => ({
  name,
  created_at: at(0),
  started_at: at(start),
  completed_at: at(end),
  status: "completed",
  conclusion: "success",
  steps,
});
const step = (name, start, end) => ({
  name,
  started_at: at(start),
  completed_at: at(end),
});
const run = {
  id: 123,
  run_attempt: 1,
  head_sha: "a".repeat(40),
  created_at: at(0),
};

test("critical path uses elapsed wall time, not summed parallel runner time", () => {
  const result = workflowTiming(run, [
    job("Select suites", 0, 10),
    job("Image / antnest-runtime", 10, 60, [step("Build image", 20, 50)]),
    job("Tier A / PostgreSQL components / Run", 10, 100, [
      step("Run suites", 20, 90),
    ]),
    job("Tier C / Agent lifecycle / Run", 60, 110, [
      step("Run suites", 65, 105),
    ]),
    job("Integration checks", 110, 112),
    job("Report workflow timing", 112, 120),
  ]);
  assert.equal(result.integrationGateWallMs, 112000);
  assert.equal(result.totalRunnerMs, 202000);
  assert.equal(result.lastSuite.name, "Tier C / Agent lifecycle / Run");
  assert.equal(result.lastSuite.testMs, 40000);
  assert.equal(result.lastSuite.setupMs, 5000);
  assert.equal(result.jobs[1].buildMs, 30000);
  assert.equal(result.jobs[3].createdToStartMs, 60000);
  assert.equal(result.jobs[3].matrixSlotWaitMs, null);
  assert.equal(result.jobs[3].runnerQueueMs, null);
  assert.equal(result.complete, true);
});

test("incomplete and cancelled runs never look like successful full measurements", () => {
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    const result = workflowTiming(run, [
      { ...job("Integration checks", 1, 2), conclusion },
    ]);
    assert.equal(result.gateConclusion, conclusion);
  }
  const result = workflowTiming(run, [
    {
      ...job("Integration checks", 1, 2),
      completed_at: null,
      status: "in_progress",
      conclusion: null,
    },
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.integrationGateWallMs, null);
});

test("API metadata cannot copy arbitrary names or credential-shaped fields into public metrics", () => {
  const secret = "secret-token-canary";
  const result = workflowTiming({ ...run, token: secret }, [
    {
      ...job("Integration checks", 1, 2),
      runner_name: secret,
      labels: [secret],
    },
    job(secret, 0, 1),
  ]);
  assert(!JSON.stringify(result).includes(secret));
  assert.equal(result.jobs.length, 1);
  assert.throws(() => workflowTiming({ ...run, head_sha: secret }, []));
});
