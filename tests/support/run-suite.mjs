import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runCommand } from "./run-command.mjs";
import { durablePath } from "./storage.mjs";
import { compileManifest } from "./suite-manifest.mjs";
import {
  compareEnvironment,
  snapshotEnvironment,
} from "./verification/environment.mjs";

function businessFailure(log) {
  if (/^[A-Za-z][A-Za-z -]* business\/topology failed;/m.test(log)) return true;
  for (const match of log.matchAll(/(?:^|\n)\{/g)) {
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let index = start; index < log.length; index++) {
      const char = log[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          const report = JSON.parse(log.slice(start, index + 1));
          if (report.status === "failed") return true;
        } catch {
          /* Ordinary command output is not necessarily JSON. */
        }
        break;
      }
    }
  }
  return false;
}

export async function runSuite({
  manifest,
  output,
  baseline,
  snapshot = snapshotEnvironment,
}) {
  output = durablePath(output);
  assert(
    Array.isArray(manifest) && manifest.length > 0,
    "expected a nonempty command manifest",
  );
  assert(
    new Set(manifest.map((row) => row.name)).size === manifest.length,
    "duplicate evidence names",
  );
  for (const row of manifest) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(row.name));
    assert(
      Array.isArray(row.command) &&
        row.command.length &&
        row.command.every((arg) => typeof arg === "string"),
    );
    assert(
      !existsSync(resolve(output, `${row.name}.log`)),
      "evidence already exists",
    );
    assert(
      (!row.pin_images && !row.check_resources) || baseline,
      "environment checks require an explicit baseline",
    );
    if (row.env)
      assert(
        !Array.isArray(row.env) &&
          typeof row.env === "object" &&
          Object.entries(row.env).every(
            ([key, value]) =>
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string",
          ),
        "invalid suite environment",
      );
    if (row.cwd) durablePath(row.cwd);
    if (row.pause_file) durablePath(row.pause_file);
  }
  assert(
    !existsSync(resolve(output, "suite.result.json")),
    "suite evidence already exists",
  );
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const results = [];
  let exit_code = 0,
    complete = true,
    reason;
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  async function environment() {
    const current = await snapshot({
      before: baseline,
      signal: controller.signal,
    });
    return compareEnvironment(baseline, current);
  }
  try {
    for (const row of manifest) {
      controller.signal.throwIfAborted();
      if (row.pin_images)
        assert(
          (await environment()).image_changes.length === 0,
          "candidate image drift",
        );
      const result = await runCommand({
        name: row.name,
        command: row.command,
        output,
        timeoutMs: row.timeout_ms,
        graceMs: row.grace_ms,
        env: { ...process.env, ...row.env },
        cwd: row.cwd,
        pauseFile: row.pause_file,
      });
      results.push(result);
      if (result.exit_code) exit_code = result.exit_code;
      if (result.reason === "paused") {
        complete = false;
        reason = "paused";
        break;
      }
      if (row.check_resources) {
        const diff = await environment();
        writeFileSync(
          resolve(output, `${row.name}.environment.json`),
          JSON.stringify(diff, null, 2),
          { flag: "wx", mode: 0o600 },
        );
        if (!diff.unchanged) {
          exit_code = 1;
          complete = false;
          reason = "environment-drift";
          break;
        }
      }
      if (
        businessFailure(
          readFileSync(resolve(output, `${row.name}.log`), "utf8"),
        )
      ) {
        exit_code ||= 1;
        complete = false;
        reason = "business-failure";
        break;
      }
      if (
        !result.complete ||
        !(row.accepted_exits ?? [0]).includes(result.exit_code)
      ) {
        complete = false;
        break;
      }
    }
  } catch {
    exit_code = controller.signal.aborted ? 130 : exit_code || 1;
    complete = false;
    reason = controller.signal.aborted ? "interrupted" : "suite-check-failed";
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  }
  const report = {
    exit_code,
    complete,
    results,
    ...(reason ? { reason } : {}),
  };
  writeFileSync(
    resolve(output, "suite.result.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return report;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      output: { type: "string" },
      baseline: { type: "string" },
      inputs: { type: "string" },
    },
  });
  assert(
    values.manifest && values.output,
    "expected --manifest FILE --output DIRECTORY",
  );
  const result = await runSuite({
    manifest: compileManifest(
      JSON.parse(readFileSync(durablePath(values.manifest), "utf8")),
      {
        output: values.output,
        inputs: values.inputs
          ? JSON.parse(readFileSync(durablePath(values.inputs), "utf8"))
          : {},
      },
    ),
    output: resolve(values.output),
    baseline:
      values.baseline &&
      JSON.parse(readFileSync(durablePath(values.baseline), "utf8")),
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.exit_code;
}
