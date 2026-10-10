// Runs one CI shard: its selected suites in order on one runner. Every suite
// runs even when an earlier one fails, so a shard reports all its outcomes.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasStrictCompletion, unreviewedWarnings } from "./strict-findings.mjs";

// Strict runners exit 2 when business and topology checks pass but strict
// trace findings remain; only reviewed findings pass, with a warning.
export function verdict(code, output, strict) {
  if (code === 0) return "passed";
  if (
    code === 2 &&
    strict &&
    hasStrictCompletion(output) &&
    unreviewedWarnings(output).length === 0
  )
    return "warning";
  return "failed";
}

const signals = ["SIGINT", "SIGTERM"];

// The suite runs in its own process group so a timeout or an interrupted
// job stops every process it started, including detached Compose clients.
export function runBash(
  command,
  { log, stream, timeoutMs = 60 * 60_000, graceMs = 30_000 },
) {
  return new Promise((resolve, reject) => {
    writeFileSync(log, "", { flag: "wx", mode: 0o600 });
    const chunks = [];
    const child = spawn("bash", ["-euo", "pipefail", "-c", command], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let forced;
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        return;
      }
      forced = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The group already exited. */
        }
      }, graceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const interrupt = () => stop();
    for (const signal of signals) process.on(signal, interrupt);
    const collect = (chunk) => {
      chunks.push(chunk);
      appendFileSync(log, chunk);
      stream(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forced);
      for (const name of signals) process.removeListener(name, interrupt);
      // Kill leftovers that outlived the shell before reporting.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Nothing is left in the group. */
      }
      resolve({
        code: code ?? (signal ? 128 : 1),
        output: Buffer.concat(chunks).toString("utf8"),
        timedOut,
      });
    });
  });
}

export async function runShard(
  suites,
  { run, write, stopped = () => false, now = Date.now, onResult = () => {} },
) {
  const results = [];
  const record = (result) => {
    results.push(result);
    onResult(result);
  };
  for (const suite of suites) {
    if (stopped()) {
      record({
        id: suite.id,
        name: suite.name,
        status: "failed",
        code: "interrupted",
        startedAt: null,
        finishedAt: null,
        durationMs: 0,
        timedOut: false,
        interrupted: true,
      });
      continue;
    }
    write(`::group::${suite.name}`);
    const start = now();
    const { code, output, timedOut } = await run(suite.run, suite.id);
    const end = now();
    const interrupted = stopped();
    write("::endgroup::");
    const status =
      timedOut || interrupted ? "failed" : verdict(code, output, suite.strict);
    if (status === "failed" && code === 2 && suite.strict)
      for (const warning of unreviewedWarnings(output))
        write(`unreviewed strict trace warning: ${warning}`);
    if (status === "failed")
      write(
        `::error title=${suite.name}::${interrupted ? "interrupted" : timedOut ? "timed out" : `exited ${code}`}`,
      );
    else if (status === "warning")
      write(
        `::warning title=${suite.name}::Business and topology checks passed; only reviewed strict trace findings remain, recorded in the evidence artifact.`,
      );
    record({
      id: suite.id,
      name: suite.name,
      status,
      code,
      startedAt: new Date(start).toISOString(),
      finishedAt: new Date(end).toISOString(),
      durationMs: Math.max(0, end - start),
      timedOut: Boolean(timedOut),
      interrupted,
    });
  }
  return results;
}

export function summary(results) {
  return [
    "| Suite | Result | Exit | Duration (s) |",
    "| --- | --- | --- | --- |",
    ...results.map(
      ({ name, status, code, durationMs }) =>
        `| ${name} | ${status} | ${code} | ${(durationMs / 1000).toFixed(3)} |`,
    ),
  ].join("\n");
}

async function main() {
  const suites = JSON.parse(process.env.SUITES ?? "[]");
  if (!Array.isArray(suites) || suites.length === 0)
    throw new Error("SUITES must name at least one suite");
  const evidence = resolve("artifacts/verification/ci-shards");
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const logs = mkdtempSync(join(evidence, "shard-"));
  const recorded = [];
  let interrupted = false;
  for (const signal of signals)
    process.on(signal, () => {
      interrupted = true;
    });
  const results = await runShard(suites, {
    stopped: () => interrupted,
    onResult: (result) => {
      recorded.push(result);
      // Flush after every suite so completed outcomes survive interruption.
      writeFileSync(
        join(logs, "results.json"),
        `${JSON.stringify(recorded, null, 2)}\n`,
        { mode: 0o600 },
      );
    },
    run: (command, id) =>
      runBash(command, {
        log: join(logs, `${id}.log`),
        stream: (chunk) => process.stdout.write(chunk),
      }),
    write: (line) => process.stdout.write(`${line}\n`),
  });
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary(results)}\n`);
  process.exitCode = results.some(({ status }) => status === "failed") ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
