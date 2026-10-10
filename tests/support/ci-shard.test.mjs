import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBash, runShard, summary, verdict } from "./ci-shard.mjs";

const clock =
  "clock skew adjustment disabled; not applying calculated delta of -2ms";
const report = (warnings) =>
  JSON.stringify({
    status: "business_passed",
    strict_trace: "failed",
    scenarios: 1,
    traces: [{ warnings }],
  });

test("an exit 2 passes only for strict suites with reviewed findings", () => {
  assert.equal(verdict(0, "", false), "passed");
  assert.equal(verdict(1, "", true), "failed");
  assert.equal(verdict(2, report([clock]), false), "failed");
  assert.equal(verdict(2, report([clock]), true), "warning");
  assert.equal(verdict(2, report([clock, "invalid parent"]), true), "failed");
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
      "failed",
    );
  }
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
        SUITES: JSON.stringify([
          { id: "first", name: "First", run: "echo first-output; exit 1" },
          { id: "second", name: "Second", run: "echo second-output" },
        ]),
      },
    },
  );
  assert.equal(result.status, 1, result.stderr);
  const evidence = join(dir, "artifacts/verification/ci-shards");
  const [run] = readdirSync(evidence);
  assert(run);
  const path = join(evidence, run);
  const results = JSON.parse(readFileSync(join(path, "results.json"), "utf8"));
  assert.deepEqual(
    results.map(({ status }) => status),
    ["failed", "passed"],
  );
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
