import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sourceCatalog } from "./ci-failure.mjs";
import {
  createResourceCheckedRunner,
  componentOutcomes,
  runBash,
  runShard,
  summary,
  verdict,
} from "./ci-shard.mjs";

const clock =
  "clock skew adjustment disabled; not applying calculated delta of -2ms";

test("component outcomes retain independent business and cleanup failures without trusting stdout", () => {
  const state = { status: "failed", interrupted: false, timedOut: false };
  const result = componentOutcomes(
    [{ business: "passed", cleanup: "failed" }],
    state,
  );
  assert.equal(result.business, "reported_components_passed");
  assert.equal(result.cleanup, "failed");
  assert.deepEqual(result.components, [
    { business: "passed", cleanup: "failed" },
  ]);
  assert.equal(componentOutcomes([], state).cleanup, "not_reported");
  assert.equal(
    componentOutcomes([{ business: "not_run", cleanup: "passed" }], state)
      .business,
    "not_run",
  );
});
const report = (warnings) =>
  JSON.stringify({
    status: "business_passed",
    strict_trace: "failed",
    scenarios: 1,
    traces: [{ warnings }],
  });

test("completed strict suites retain every Trace finding as an auxiliary warning", () => {
  assert.equal(verdict(0, "", false), "passed");
  assert.equal(verdict(1, "", true), "failed");
  assert.equal(verdict(2, report([clock]), false), "failed");
  assert.equal(verdict(2, report([clock]), true), "warning");
  assert.equal(verdict(2, report([clock, "invalid parent"]), true), "warning");
});

test("auxiliary Trace diagnostics mark successful suites as warning without accepting failed suites", () => {
  const record = JSON.stringify({
    trace_diagnostics: {
      version: 1,
      role: "auxiliary",
      status: "warning",
      checks: [{ name: "trace", status: "failed" }],
    },
  });
  for (const output of [record, `# ${record}`]) {
    assert.equal(verdict(0, output, false), "warning");
    for (const code of [1, 2, 130, 143])
      assert.equal(verdict(code, output, true), "failed");
  }
});

test("exit 2 without a complete business report is a failure", () => {
  for (const output of [
    "",
    "make: *** [docker-build-managed-runtime] Error 1",
    JSON.stringify({ traces: [{ warnings: [clock] }] }),
    JSON.stringify({
      status: "business_passed",
      traces: [{ warnings: [clock] }],
    }),
    JSON.stringify({
      status: "business_and_topology_passed",
      suite: "identity-core",
      strict_exit: 1,
    }),
    JSON.stringify({
      status: "business_and_topology_passed",
      cleanup: "failed",
      strict_exit: 2,
      accepted_exit: 2,
      traces: [{}],
    }),
    `${report([clock])}\n${JSON.stringify({ status: "cleanup_failed" })}`,
  ])
    assert.equal(verdict(2, output, true), "failed", output);
});

test("the existing strict runner completion reports remain accepted", () => {
  const completed = [
    {
      status: "business_and_topology_passed",
      cleanup: "verified",
      strict_exit: 2,
      accepted_exit: 2,
      traces: [{}],
    },
    {
      status: "browser_passed",
      cleanup: "verified",
      strict_trace: "failed",
      traces: [{}],
    },
    ...[
      "identity-core",
      "identity-access",
      "identity-organization-display",
    ].map((suite) => ({
      status: "business_and_topology_passed",
      suite,
      strict_exit: 2,
    })),
    {
      status: "business_passed",
      versions: [1, 2],
      traces: [{ strict_trace: "failed" }],
    },
    {
      status: "business_passed",
      versions: [1, 2],
      traces: [{}],
      offboarding: [{ strict_trace: "failed" }],
    },
    {
      status: "business_passed",
      strict_trace: "failed",
      scenarios: 2,
      traces: [{}],
    },
  ];
  for (const completion of completed) {
    const output = `${JSON.stringify({ traces: [{ warnings: [clock] }] })}\n${JSON.stringify(completion)}\n${JSON.stringify({ status: "cleanup_passed" })}`;
    assert.equal(
      verdict(2, output, true),
      "warning",
      JSON.stringify(completion),
    );
    assert.equal(
      verdict(
        2,
        `${output}\n${JSON.stringify({ traces: [{ warnings: ["missing parent"] }] })}`,
        true,
      ),
      "warning",
    );
  }
});

test("private multimodal completion counts finished transports and keeps strict findings", () => {
  const completion = {
    status: "business_passed",
    strict_trace: "failed",
    accepted: true,
    reviewed_error_spans: 52,
    clock_warnings_accepted: true,
    outcomes: ["v1-ws", "v2-ws", "v1-http"].map((transport) => ({
      transport,
      successful_runs: 3,
      local_failed_runs: 1,
      invalid_inputs: 2,
      replayed_messages: 4,
      foreign_session_rejections: 3,
    })),
    model_requests: 9,
    business_requests: 48,
    initialization_requests: 12,
    connections: 12,
    traces: Array.from({ length: 48 }, () => ({ warnings: [clock] })),
    initialization_traces: Array.from({ length: 12 }, () => ({ warnings: [] })),
  };
  const classify = (record, code = 2, trailing = "") =>
    verdict(
      code,
      `${JSON.stringify(record)}\n${trailing}`,
      true,
      "acp-multimodal",
    );

  // The original private consumer completed all transports but omitted the
  // scenario count required by the existing CI completion contract.
  assert.equal(classify(completion), "failed");
  const completed = { ...completion, scenarios: completion.outcomes.length };
  assert.equal(completed.scenarios, 3);
  assert.equal(classify(completed), "warning");
  assert.equal(completed.strict_trace, "failed");
  assert.equal(classify(completed, 1), "failed");
  assert.equal(classify({ ...completed, traces: [] }), "failed");
  assert.equal(
    classify({ ...completed, traces: [{ warnings: ["missing parent span"] }] }),
    "warning",
  );
  assert.equal(
    classify(completed, 2, JSON.stringify({ status: "cleanup_failed" })),
    "failed",
  );
});

test("suite results retain elapsed time, timeout and incremental outcomes", async () => {
  const recorded = [];
  const times = [1000, 1250, 2000, 2040];
  const results = await runShard(
    [
      { id: "first", name: "First", run: "a" },
      { id: "second", name: "Second", run: "b" },
    ],
    {
      now: () => times.shift(),
      onResult: (result) => recorded.push(result),
      write: () => {},
      run: async (_, id) => {
        if (id === "second")
          assert.equal(
            recorded.length,
            1,
            "persist the first result before starting the next suite",
          );
        return {
          code: id === "first" ? 0 : 128,
          output: "",
          timedOut: id === "second",
        };
      },
    },
  );
  assert.deepEqual(recorded, results);
  assert.deepEqual(
    results.map(({ durationMs, timedOut }) => [durationMs, timedOut]),
    [
      [250, false],
      [40, true],
    ],
  );
  assert.equal(results[0].startedAt, "1970-01-01T00:00:01.000Z");
  assert.equal(results[0].finishedAt, "1970-01-01T00:00:01.250Z");
  assert.equal(results[1].status, "failed");
  assert.match(summary(results), /Duration/u);
  assert.match(summary(results), /0\.250/u);
});

test("interruption fails even a last command that exits zero during cleanup", async () => {
  let stop = false;
  const results = await runShard([{ id: "last", name: "Last", run: "a" }], {
    run: async () => {
      stop = true;
      return { code: 0, output: "" };
    },
    stopped: () => stop,
    write: () => {},
  });
  assert.equal(results[0].status, "failed");
  assert.equal(results[0].interrupted, true);
});

test("the CLI preserves independent logs and results in the uploaded evidence tree", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-shard-evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stepSummary = join(dir, "summary.md");
  const identity = sourceCatalog().find(
    (row) => row.name === "component failure feedback probe",
  );
  assert(identity);
  const feedback = JSON.stringify({
    ci_failure: {
      version: 1,
      ...identity,
      category: "test_failure",
      reportedAt: 0,
    },
  });
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./ci-shard.mjs", import.meta.url))],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: stepSummary,
        ANTNEST_CI_DIAGNOSTICS: "1",
        SUITES: JSON.stringify([
          {
            id: "first",
            name: "First",
            run: `echo first-output; printf '%s\\n' '${feedback}' '{"ci_component_outcome":{"version":1,"business":"passed","cleanup":"passed"}}'; exit 1`,
          },
          { id: "second", name: "Second", run: "echo second-output" },
        ]),
      },
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert(!result.stdout.includes("first-output"));
  assert(!result.stdout.includes("second-output"));
  const evidence = join(dir, "artifacts/verification/ci-shards");
  const [run] = readdirSync(evidence);
  assert(run);
  const path = join(evidence, run);
  const results = JSON.parse(readFileSync(join(path, "results.json"), "utf8"));
  assert.deepEqual(
    results.map(({ status }) => status),
    ["failed", "passed"],
  );
  assert.equal(results[0].cleanup, "not_reported");
  assert.equal(results[0].failures.length, 1);
  assert(results[0].failures[0].reportedAt >= Date.parse(results[0].startedAt));
  assert.match(result.stdout, /component failure feedback probe/u);
  for (const item of results) {
    assert(Number.isFinite(item.durationMs) && item.durationMs >= 0);
    assert.match(item.startedAt, /Z$/u);
    assert.match(item.finishedAt, /Z$/u);
    assert.match(
      readFileSync(join(path, `${item.id}.log`), "utf8"),
      new RegExp(`${item.id}-output`, "u"),
    );
  }
  assert.match(readFileSync(stepSummary, "utf8"), /Duration/u);
  assert.match(
    readFileSync(stepSummary, "utf8"),
    /component failure feedback probe/u,
  );
});

test("runs every suite in order and reports each outcome", async () => {
  const ran = [];
  const outcomes = {
    first: { code: 1, output: "" },
    second: { code: 2, output: report([clock]) },
    third: { code: 0, output: "" },
  };
  const lines = [];
  const results = await runShard(
    [
      { id: "first", name: "First", run: "a" },
      { id: "second", name: "Second", run: "b", strict: true },
      { id: "third", name: "Third", run: "c" },
    ],
    {
      run: async (command, id) => {
        ran.push([id, command]);
        return outcomes[id];
      },
      write: (line) => lines.push(line),
    },
  );
  assert.deepEqual(ran, [
    ["first", "a"],
    ["second", "b"],
    ["third", "c"],
  ]);
  assert.deepEqual(
    results.map(({ id, status, code }) => [id, status, code]),
    [
      ["first", "failed", 1],
      ["second", "warning", 2],
      ["third", "passed", 0],
    ],
  );
  assert(lines.includes("::group::First"));
  assert(lines.some((line) => line.startsWith("::error title=First::")));
  assert(lines.some((line) => line.startsWith("::warning title=Second::")));
});

test("an interrupted shard starts no further suite", async () => {
  let stop = false;
  const ran = [];
  const results = await runShard(
    [
      { id: "first", name: "First", run: "a" },
      { id: "second", name: "Second", run: "b" },
    ],
    {
      run: async (command, id) => {
        ran.push(id);
        stop = true;
        return { code: 130, output: "" };
      },
      write: () => {},
      stopped: () => stop,
    },
  );
  assert.deepEqual(ran, ["first"]);
  assert.deepEqual(
    results.map(({ status }) => status),
    ["failed", "failed"],
  );
});

test("runBash streams output, keeps it for the verdict and returns the code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-shard-"));
  const log = join(dir, "out.log");
  const chunks = [];
  const result = await runBash("echo one; echo two >&2; exit 3", {
    log,
    stream: (chunk) => chunks.push(String(chunk)),
  });
  assert.equal(result.code, 3);
  assert.match(result.output, /one/u);
  assert.match(result.output, /two/u);
  assert.match(chunks.join(""), /one/u);
  assert.equal(readFileSync(log, "utf8"), result.output);
});

test("runBash stops the whole process group when a suite times out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-shard-"));
  const pidFile = join(dir, "child.pid");
  const result = await runBash(`sleep 30 & echo $! > ${pidFile}; wait`, {
    log: join(dir, "out.log"),
    stream: () => {},
    timeoutMs: 300,
    graceMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  const child = Number(readFileSync(pidFile, "utf8"));
  const alive = () => {
    try {
      process.kill(child, 0);
      return true;
    } catch {
      return false;
    }
  };
  // The orphaned child is reaped asynchronously after the group is killed.
  for (let i = 0; i < 40 && alive(); i++)
    await new Promise((done) => setTimeout(done, 50));
  assert.equal(alive(), false);
});

test("runBash runs with errexit and pipefail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-shard-"));
  const result = await runBash("false | true; echo unreachable", {
    log: join(dir, "out.log"),
    stream: () => {},
  });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.output, /unreachable/u);
});

function emptyResourceSnapshot() {
  return {
    resources: { containers: [], volumes: [], networks: [] },
    retained: [],
    images: {},
  };
}

function leakedResourceSnapshot() {
  const snapshot = emptyResourceSnapshot();
  snapshot.resources.volumes.push("anonymous-fixture-volume");
  return snapshot;
}

function resourceCleanupResult(result) {
  const records = result.output.split(/\r?\n/u).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value?.resource_cleanup ? [value.resource_cleanup] : [];
    } catch {
      return [];
    }
  });
  assert.equal(records.length, 1, "append exactly one resource cleanup record");
  assert.deepEqual(
    JSON.parse(result.output.trimEnd().split(/\r?\n/u).at(-1)).resource_cleanup,
    records[0],
  );
  return records[0];
}

function resourceBoundary() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("resource admission guards all six B Skills suites against one original baseline", async () => {
  const ids = [
    "skill-registry-discovery",
    "skill-registry-rc-prepare",
    "skill-registry-console",
    "skill-temporary-runtime",
    "skill-learning-runtime",
    "runtime-controller-skill-archives",
  ];
  const baseline = emptyResourceSnapshot();
  const snapshots = [],
    ran = [],
    recorded = [];
  const checked = createResourceCheckedRunner({
    run: async (command, id) => {
      ran.push([command, id]);
      return { code: 0, output: `${id} business completed`, timedOut: false };
    },
    snapshot: async ({ before, signal }) => {
      assert(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      snapshots.push(before);
      if (before) assert.deepEqual(before, baseline);
      return structuredClone(baseline);
    },
    record: (id, evidence) => recorded.push({ id, evidence }),
  });
  for (const id of ids) {
    const result = await checked(`command-${id}`, id);
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.equal(resourceCleanupResult(result).status, "passed");
  }
  assert.deepEqual(
    ran,
    ids.map((id) => [`command-${id}`, id]),
  );
  assert.equal(snapshots.length, ids.length + 1);
  assert.equal(snapshots.filter((before) => !before).length, 1);
  assert.deepEqual(
    recorded.map(({ id }) => id),
    ids,
  );
  for (const { evidence } of recorded) {
    assert.deepEqual(evidence.baseline, baseline);
    assert.deepEqual(evidence.after, baseline);
    assert.equal(evidence.comparison.unchanged, true);
    assert.deepEqual(evidence.business, {
      executed: true,
      code: 0,
      timedOut: false,
    });
  }
});

test("unguarded suites pass through without snapshots or cleanup records", async () => {
  const original = { code: 7, output: "original output", timedOut: true };
  let calls = 0;
  const checked = createResourceCheckedRunner({
    run: async (command, id) => {
      calls++;
      assert.equal(command, "ordinary command");
      assert.equal(id, "agent-ui-receipt");
      return original;
    },
    snapshot: async () => assert.fail("unguarded suite must not snapshot"),
    record: () => assert.fail("unguarded suite must not record cleanup"),
  });
  assert.deepEqual(
    await checked("ordinary command", "agent-ui-receipt"),
    original,
  );
  assert.equal(calls, 1);
});

test("successful business with a leaked anonymous volume is a hard failure", async () => {
  const baseline = emptyResourceSnapshot();
  const after = leakedResourceSnapshot();
  const recorded = [];
  const checked = createResourceCheckedRunner({
    run: async () => ({
      code: 0,
      output: "business completed",
      timedOut: false,
    }),
    snapshot: async ({ before }) => (before ? after : baseline),
    record: (id, evidence) => recorded.push({ id, evidence }),
  });
  const result = await checked("prepare", "skill-registry-rc-prepare");
  assert.equal(result.code, 1);
  assert.equal(result.timedOut, false);
  assert(result.output.startsWith("business completed"));
  assert.equal(resourceCleanupResult(result).status, "failed");
  assert.equal(
    verdict(result.code, result.output, false, "skill-registry-rc-prepare"),
    "failed",
  );
  assert.equal(recorded.length, 1);
  const { evidence } = recorded[0];
  assert.deepEqual(evidence.baseline, emptyResourceSnapshot());
  assert.deepEqual(evidence.after, leakedResourceSnapshot());
  assert.equal(evidence.comparison.unchanged, false);
  assert.deepEqual(evidence.comparison.resources.volumes, {
    added: ["anonymous-fixture-volume"],
    removed: [],
  });
  assert.deepEqual(evidence.business, {
    executed: true,
    code: 0,
    timedOut: false,
  });
  assert.deepEqual(
    baseline,
    emptyResourceSnapshot(),
    "the original baseline must not be mutated",
  );
  assert.deepEqual(
    after,
    leakedResourceSnapshot(),
    "the observed inventory must not be mutated",
  );
});

test("business failure and timeout retain their original code and output alongside cleanup failure", async () => {
  const original = {
    code: 7,
    output: "business failed\noriginal diagnostic\n",
    timedOut: true,
  };
  const recorded = [];
  let postflight = 0;
  const checked = createResourceCheckedRunner({
    run: async () => original,
    snapshot: async ({ before, signal }) => {
      if (!before) return emptyResourceSnapshot();
      postflight++;
      assert(signal instanceof AbortSignal);
      assert.equal(
        signal.aborted,
        false,
        "business timeout must not cancel cleanup admission",
      );
      return leakedResourceSnapshot();
    },
    record: (_, evidence) => recorded.push(evidence),
  });
  const result = await checked("prepare", "skill-registry-rc-prepare");
  assert.equal(postflight, 1);
  assert.equal(result.code, original.code);
  assert.equal(result.timedOut, true);
  assert(result.output.startsWith(original.output));
  assert.equal(resourceCleanupResult(result).status, "failed");
  assert.deepEqual(recorded[0].business, {
    executed: true,
    code: 7,
    timedOut: true,
  });
  assert.equal(recorded[0].comparison.unchanged, false);
  assert.deepEqual(original, {
    code: 7,
    output: "business failed\noriginal diagnostic\n",
    timedOut: true,
  });
});

test("baseline failure records unexecuted business and cannot admit the suite", async () => {
  const recorded = [];
  let businessCalls = 0;
  const checked = createResourceCheckedRunner({
    run: async () => {
      businessCalls++;
      return { code: 0, output: "must not run", timedOut: false };
    },
    snapshot: async () => {
      throw new Error("baseline unavailable");
    },
    record: (_, evidence) => recorded.push(evidence),
  });
  const result = await checked("prepare", "skill-registry-rc-prepare");
  assert.equal(businessCalls, 0);
  assert.notEqual(result.code, 0);
  assert.equal(resourceCleanupResult(result).status, "failed");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].business.executed, false);
  assert(recorded[0].error);
});

test("postflight exception is a hard failure while preserving completed business", async () => {
  const recorded = [];
  const checked = createResourceCheckedRunner({
    run: async () => ({
      code: 0,
      output: "completed business output\n",
      timedOut: false,
    }),
    snapshot: async ({ before }) => {
      if (!before) return emptyResourceSnapshot();
      throw new Error("postflight unavailable");
    },
    record: (_, evidence) => recorded.push(evidence),
  });
  const result = await checked("install", "skill-learning-runtime");
  assert.equal(result.code, 1);
  assert(result.output.startsWith("completed business output\n"));
  assert.equal(resourceCleanupResult(result).status, "failed");
  assert.deepEqual(recorded[0].business, {
    executed: true,
    code: 0,
    timedOut: false,
  });
  assert(recorded[0].error);
});

for (const failedPostflight of [false, true]) {
  test(`a thrown business command still joins postflight${failedPostflight ? " and preserves its separate failure" : ""}`, async () => {
    const recorded = [],
      steps = [];
    const checked = createResourceCheckedRunner({
      run: async () => {
        steps.push("business");
        throw new Error("business command failed");
      },
      snapshot: async ({ before }) => {
        steps.push(before ? "postflight" : "baseline");
        if (before && failedPostflight)
          throw new Error("postflight also failed");
        return emptyResourceSnapshot();
      },
      record: (_, evidence) => recorded.push(evidence),
    });
    const result = await checked("release", "skill-learning-runtime");
    assert.deepEqual(steps, ["baseline", "business", "postflight"]);
    assert.notEqual(result.code, 0);
    assert.equal(
      resourceCleanupResult(result).status,
      failedPostflight ? "failed" : "passed",
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].business.executed, true);
    assert(recorded[0].business.error);
    if (failedPostflight) assert(recorded[0].error);
    else assert.equal(recorded[0].comparison.unchanged, true);
  });
}

test(
  "held postflight cannot report success before its actual snapshot settles",
  { timeout: 5000 },
  async (t) => {
    const entered = resourceBoundary();
    const release = resourceBoundary();
    const recorded = [];
    let settled = false,
      returned = false;
    const checked = createResourceCheckedRunner({
      run: async () => ({ code: 0, output: "completed", timedOut: false }),
      snapshot: async ({ before }) => {
        if (!before) return emptyResourceSnapshot();
        entered.resolve();
        try {
          await release.promise;
          return emptyResourceSnapshot();
        } finally {
          settled = true;
        }
      },
      record: (_, evidence) => recorded.push(evidence),
    });
    const pending = checked("prepare", "skill-registry-rc-prepare");
    pending.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      },
    );
    t.after(async () => {
      release.resolve();
      await pending;
    });
    try {
      await entered.promise;
      await new Promise((done) => setImmediate(done));
      assert.equal(settled, false);
      assert.equal(returned, false);
      assert.equal(recorded.length, 0);
    } finally {
      release.resolve();
      await pending;
    }
    assert.equal(settled, true);
    assert.equal(resourceCleanupResult(await pending).status, "passed");
  },
);

test(
  "postflight timeout aborts the snapshot and joins it before returning failure",
  { timeout: 5000 },
  async (t) => {
    const entered = resourceBoundary();
    const aborted = resourceBoundary();
    const release = resourceBoundary();
    const recorded = [];
    let settled = false,
      returned = false,
      diagnosticSignal;
    const checked = createResourceCheckedRunner({
      timeoutMs: 20,
      run: async () => ({
        code: 0,
        output: "completed before postflight\n",
        timedOut: false,
      }),
      snapshot: async ({ before, signal }) => {
        if (!before) return emptyResourceSnapshot();
        assert(signal instanceof AbortSignal);
        diagnosticSignal = signal;
        const cancelled = () => aborted.resolve();
        signal.addEventListener("abort", cancelled, { once: true });
        if (signal.aborted) cancelled();
        entered.resolve();
        try {
          await release.promise;
          signal.throwIfAborted();
          return emptyResourceSnapshot();
        } finally {
          signal.removeEventListener("abort", cancelled);
          settled = true;
        }
      },
      record: (_, evidence) => recorded.push(evidence),
    });
    const pending = checked("prepare", "skill-registry-rc-prepare");
    pending.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      },
    );
    t.after(async () => {
      release.resolve();
      await pending;
    });
    try {
      await entered.promise;
      await aborted.promise;
      await new Promise((done) => setImmediate(done));
      assert.equal(diagnosticSignal.aborted, true);
      assert.equal(settled, false, "abort delivery is not snapshot completion");
      assert.equal(
        returned,
        false,
        "timeout must not race ahead of actual snapshot join",
      );
      assert.equal(recorded.length, 0);
    } finally {
      release.resolve();
      await pending;
    }
    const result = await pending;
    assert.equal(settled, true);
    assert.equal(result.code, 1);
    assert(result.output.startsWith("completed before postflight\n"));
    assert.equal(resourceCleanupResult(result).status, "failed");
    assert.deepEqual(recorded[0].business, {
      executed: true,
      code: 0,
      timedOut: false,
    });
    assert(recorded[0].error);
  },
);

test("later guarded suites cannot adopt an earlier leaked volume into their baseline", async () => {
  const original = emptyResourceSnapshot();
  const recorded = [],
    snapshots = [],
    ran = [];
  const checked = createResourceCheckedRunner({
    run: async (_, id) => {
      ran.push(id);
      return { code: 0, output: `${id} completed`, timedOut: false };
    },
    snapshot: async ({ before }) => {
      snapshots.push(before);
      if (!before) {
        assert.equal(snapshots.length, 1, "baseline must be captured once");
        return structuredClone(original);
      }
      assert.deepEqual(
        before,
        original,
        "every postflight uses the original baseline",
      );
      return leakedResourceSnapshot();
    },
    record: (_, evidence) => recorded.push(evidence),
  });
  for (const id of ["skill-registry-rc-prepare", "skill-learning-runtime"]) {
    const result = await checked("business", id);
    assert.equal(result.code, 1);
    assert.equal(resourceCleanupResult(result).status, "failed");
  }
  assert.deepEqual(ran, [
    "skill-registry-rc-prepare",
    "skill-learning-runtime",
  ]);
  assert.equal(snapshots.length, 3);
  assert.equal(recorded.length, 2);
  for (const evidence of recorded) {
    assert.deepEqual(evidence.baseline, original);
    assert.equal(evidence.comparison.unchanged, false);
    assert.deepEqual(evidence.comparison.resources.volumes.added, [
      "anonymous-fixture-volume",
    ]);
  }
});

test(
  "stopping during baseline joins both snapshots without starting business",
  { timeout: 5000 },
  async (t) => {
    const baseline = emptyResourceSnapshot();
    const baselineEntered = resourceBoundary();
    const baselineRelease = resourceBoundary();
    const postflightEntered = resourceBoundary();
    const postflightRelease = resourceBoundary();
    const snapshots = [],
      settled = [],
      recorded = [];
    let stopped = false,
      businessCalls = 0,
      returned = false;
    const checked = createResourceCheckedRunner({
      stopped: () => stopped,
      run: async () => {
        businessCalls++;
        return { code: 0, output: "business must not start", timedOut: false };
      },
      snapshot: async ({ before, signal }) => {
        const phase = before ? "postflight" : "baseline";
        snapshots.push(phase);
        assert(signal instanceof AbortSignal);
        assert.equal(signal.aborted, false);
        if (before) assert.deepEqual(before, baseline);
        const entered = before ? postflightEntered : baselineEntered;
        const release = before ? postflightRelease : baselineRelease;
        entered.resolve();
        try {
          await release.promise;
          return structuredClone(baseline);
        } finally {
          settled.push(phase);
        }
      },
      record: (_, evidence) => recorded.push(evidence),
    });
    const pending = checked("prepare", "skill-registry-rc-prepare");
    const outcome = pending.then(
      () => {
        returned = true;
        return "returned";
      },
      () => {
        returned = true;
        return "returned";
      },
    );
    t.after(async () => {
      baselineRelease.resolve();
      postflightRelease.resolve();
      await pending;
    });
    try {
      assert.equal(
        await Promise.race([
          baselineEntered.promise.then(() => "baseline"),
          outcome,
        ]),
        "baseline",
      );
      stopped = true;
      await new Promise((done) => setImmediate(done));
      assert.equal(
        returned,
        false,
        "stopping must still join the held baseline",
      );
      assert.deepEqual(settled, []);
      assert.equal(recorded.length, 0);
      baselineRelease.resolve();
      assert.equal(
        await Promise.race([
          postflightEntered.promise.then(() => "postflight"),
          outcome,
        ]),
        "postflight",
        "stopping must retain independent postflight against the original baseline",
      );
      await new Promise((done) => setImmediate(done));
      assert.equal(returned, false, "stopping must join the held postflight");
      assert.deepEqual(settled, ["baseline"]);
      assert.equal(recorded.length, 0);
    } finally {
      baselineRelease.resolve();
      postflightRelease.resolve();
      await pending;
    }
    const result = await pending;
    assert.equal(
      businessCalls,
      0,
      "a latched stop must prevent business dispatch",
    );
    assert.deepEqual(snapshots, ["baseline", "postflight"]);
    assert.deepEqual(settled, ["baseline", "postflight"]);
    assert.equal(result.code, 130);
    assert.equal(result.timedOut, false);
    assert.equal(
      verdict(result.code, result.output, false, "skill-registry-rc-prepare"),
      "failed",
    );
    const cleanup = resourceCleanupResult(result);
    assert.equal(cleanup.business.executed, false);
    assert.equal(cleanup.business.interrupted, true);
    assert.equal(cleanup.comparison.unchanged, true);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].baseline, baseline);
    assert.deepEqual(recorded[0].after, baseline);
    assert.equal(recorded[0].business.executed, false);
  },
);

for (const leaked of [false, true]) {
  test(`a strict Trace warning ${leaked ? "cannot swallow resource cleanup failure" : "remains auxiliary after verified cleanup"}`, async () => {
    const output = `${report([clock])}\n`;
    const recorded = [];
    const checked = createResourceCheckedRunner({
      run: async () => ({ code: 2, output, timedOut: false }),
      snapshot: async ({ before }) =>
        before && leaked ? leakedResourceSnapshot() : emptyResourceSnapshot(),
      record: (_, evidence) => recorded.push(evidence),
    });
    const result = await checked(
      "archives",
      "runtime-controller-skill-archives",
    );
    assert.equal(
      result.code,
      2,
      "the original business exit code must remain intact",
    );
    assert(result.output.startsWith(output));
    assert.equal(
      resourceCleanupResult(result).status,
      leaked ? "failed" : "passed",
    );
    assert.equal(
      verdict(
        result.code,
        result.output,
        true,
        "runtime-controller-skill-archives",
      ),
      leaked ? "failed" : "warning",
    );
    assert.deepEqual(recorded[0].business, {
      executed: true,
      code: 2,
      timedOut: false,
    });
  });
}
