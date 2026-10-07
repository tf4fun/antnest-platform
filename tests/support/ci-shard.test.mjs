import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBash, runShard, verdict } from "./ci-shard.mjs";

const clock =
  "clock skew adjustment disabled; not applying calculated delta of -2ms";
const report = (warnings) => JSON.stringify({ traces: [{ warnings }] });

test("an exit 2 passes only for strict suites with reviewed findings", () => {
  assert.equal(verdict(0, "", false), "passed");
  assert.equal(verdict(1, "", true), "failed");
  assert.equal(verdict(2, report([clock]), false), "failed");
  assert.equal(verdict(2, report([clock]), true), "warning");
  assert.equal(verdict(2, report([clock, "invalid parent"]), true), "failed");
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
