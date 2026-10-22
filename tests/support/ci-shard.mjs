// Runs one CI shard: its selected suites in order on one runner. Every suite
// runs even when an earlier one fails, so a shard reports all its outcomes.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareEnvironment,
  snapshotEnvironment,
} from "./verification/environment.mjs";
import { hasStrictCompletion } from "./strict-findings.mjs";
import {
  hasResolveCacheCompletion,
  resolveCacheCISuite,
} from "./resolve-cache-admission.mjs";

function hasAuxiliaryTraceWarning(output) {
  for (const line of output.split(/\r?\n/u)) {
    const text = line.trim().replace(/^# /u, "");
    if (!text.startsWith("{")) continue;
    try {
      const diagnostics = JSON.parse(text).trace_diagnostics;
      if (
        diagnostics?.version === 1 &&
        diagnostics.role === "auxiliary" &&
        diagnostics.status === "warning"
      )
        return true;
    } catch {
      // Ordinary command output is not necessarily JSON.
    }
  }
  return false;
}

// Strict runners retain exit 2 and their original Trace findings. A completed
// business report admits those findings as auxiliary diagnostics with a warning.
export function verdict(code, output, strict, suiteID) {
  for (const line of output.split(/\r?\n/u)) {
    try {
      if (
        JSON.parse(line.trim().replace(/^# /u, "")).resource_cleanup?.status ===
        "failed"
      )
        return "failed";
    } catch {
      // Ordinary command output is not necessarily JSON.
    }
  }
  if (
    suiteID === resolveCacheCISuite &&
    code !== 0 &&
    hasResolveCacheCompletion(output, undefined, { policyRevision: 5 })
  )
    return "failed";
  if (
    suiteID === resolveCacheCISuite &&
    !hasResolveCacheCompletion(output, code === 0 ? "passed" : "failed")
  )
    return "failed";
  if (code === 0)
    return hasAuxiliaryTraceWarning(output) ? "warning" : "passed";
  if (code === 2 && strict && hasStrictCompletion(output)) return "warning";
  return "failed";
}

const signals = ["SIGINT", "SIGTERM"];

const resourceCheckedSuites = new Set([
  "skill-registry-discovery",
  "skill-registry-rc-prepare",
  "skill-registry-console",
  "skill-temporary-runtime",
  "skill-learning-runtime",
  "runtime-controller-skill-archives",
]);

// Keep the first inventory for the entire shard. A previous suite's leak must
// remain a failure, rather than becoming the next suite's accepted baseline.
export function createResourceCheckedRunner({
  run,
  snapshot = snapshotEnvironment,
  record = () => {},
  stopped = () => false,
  timeoutMs = 120000,
}) {
  let baselinePromise;
  const takeSnapshot = async (before) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("resource inventory deadline exceeded")),
      timeoutMs,
    );
    try {
      const value = await snapshot({ before, signal: controller.signal });
      controller.signal.throwIfAborted();
      return value;
    } finally {
      clearTimeout(timer);
    }
  };
  return async (command, id) => {
    if (!resourceCheckedSuites.has(id)) return run(command, id);
    const evidence = { business: { executed: false } };
    let result = { code: 1, output: "", timedOut: false };
    try {
      baselinePromise ??= takeSnapshot();
      evidence.baseline = await baselinePromise;
    } catch (error) {
      evidence.error = `baseline: ${String(error)}`;
    }
    if (evidence.baseline) {
      if (stopped()) {
        result.code = 130;
        evidence.business.interrupted = true;
      } else {
        try {
          result = await run(command, id);
          evidence.business = {
            executed: true,
            code: result.code,
            timedOut: Boolean(result.timedOut),
          };
        } catch (error) {
          evidence.business = {
            executed: true,
            code: 1,
            timedOut: false,
            error: String(error),
          };
          result.output = `${String(error)}\n`;
        }
      }
      try {
        // Independent of the business command's cancellation. Await the real
        // Docker client completion, including after this new budget expires.
        evidence.after = await takeSnapshot(evidence.baseline);
        evidence.comparison = compareEnvironment(
          evidence.baseline,
          evidence.after,
        );
      } catch (error) {
        evidence.error = `postflight: ${String(error)}`;
      }
    }
    evidence.status =
      evidence.comparison?.unchanged && !evidence.error ? "passed" : "failed";
    try {
      await record(id, evidence);
    } catch (error) {
      evidence.error = [evidence.error, `evidence: ${String(error)}`]
        .filter(Boolean)
        .join("; ");
      evidence.status = "failed";
    }
    const cleanup = {
      status: evidence.status,
      business: evidence.business,
      comparison: evidence.comparison,
      error: evidence.error,
    };
    return {
      ...result,
      code: result.code === 0 && evidence.status === "failed" ? 1 : result.code,
      output: `${result.output}\n${JSON.stringify({ resource_cleanup: cleanup })}\n`,
      resourceCleanup: cleanup,
    };
  };
}

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
    const { code, output, timedOut, resourceCleanup } = await run(
      suite.run,
      suite.id,
    );
    const end = now();
    const interrupted = stopped();
    write("::endgroup::");
    const status =
      timedOut || interrupted
        ? "failed"
        : verdict(code, output, suite.strict, suite.id);
    if (status === "failed")
      write(
        `::error title=${suite.name}::${interrupted ? "interrupted" : timedOut ? "timed out" : `exited ${code}`}`,
      );
    else if (status === "warning")
      write(
        `::warning title=${suite.name}::Business checks passed; auxiliary Trace diagnostics are retained in the evidence artifact.`,
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
      ...(resourceCleanup ? { resourceCleanup } : {}),
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
  const checkedRun = createResourceCheckedRunner({
    stopped: () => interrupted,
    run: (command, id) =>
      runBash(command, {
        log: join(logs, `${id}.log`),
        stream: (chunk) => process.stdout.write(chunk),
      }),
    record: (id, evidence) =>
      writeFileSync(
        join(logs, `${id}.environment.json`),
        `${JSON.stringify(evidence, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      ),
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
    run: async (command, id) => {
      const result = await checkedRun(command, id);
      if (result.resourceCleanup) {
        const line = `${JSON.stringify({ resource_cleanup: result.resourceCleanup })}\n`;
        appendFileSync(join(logs, `${id}.log`), line, { mode: 0o600 });
        process.stdout.write(line);
      }
      return result;
    },
    write: (line) => process.stdout.write(`${line}\n`),
  });
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary(results)}\n`);
  process.exitCode = results.some(({ status }) => status === "failed") ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
