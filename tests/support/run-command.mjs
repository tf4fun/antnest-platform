import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { durablePath } from "./storage.mjs";

export async function runCommand({
  command,
  output,
  name,
  timeoutMs = 1200000,
  graceMs = 180000,
  env = process.env,
  cwd = process.cwd(),
  pauseFile,
}) {
  output = durablePath(output);
  if (pauseFile && existsSync(durablePath(pauseFile)))
    return {
      name,
      exit_code: 125,
      complete: false,
      reason: "paused",
      duration_ms: 0,
    };
  assert(
    Array.isArray(command) &&
      command.length > 0 &&
      command.every((x) => typeof x === "string"),
  );
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name), "invalid evidence name");
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert(Number.isSafeInteger(graceMs) && graceMs > 0);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const log = openSync(resolve(output, `${name}.log`), "wx", 0o600);
  let child, timer, escalation, reason, exitCode, terminationSignal;
  const started = Date.now();
  function signalGroup(signal) {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  function stop(value) {
    if (reason) return;
    reason = value;
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), graceMs);
  }
  const interrupt = () => stop("interrupted");
  try {
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
    const previousUmask = process.umask(0o077);
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", log, log],
      });
    } finally {
      process.umask(previousUmask);
    }
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    exitCode = await new Promise((resolveCode) => {
      child.once("error", () => {
        reason = "start-failed";
        resolveCode(1);
      });
      child.once("close", (code, signal) => {
        if (signal) {
          terminationSignal = signal;
          reason ??= "terminated";
        }
        resolveCode(code ?? 1);
      });
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    // A successful parent may still have left a child behind in its owned group.
    signalGroup("SIGTERM");
    if (child?.pid) {
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") break;
          throw error;
        }
        await delay(20);
      }
      signalGroup("SIGKILL");
      await delay(20);
    }
    closeSync(log);
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt);
  }
  const result = {
    name,
    exit_code:
      reason === "timeout" ? 124 : reason === "interrupted" ? 130 : exitCode,
    complete: !reason,
    ...(reason ? { reason } : {}),
    ...(terminationSignal ? { signal: terminationSignal } : {}),
    duration_ms: Date.now() - started,
  };
  writeFileSync(
    resolve(output, `${name}.result.json`),
    JSON.stringify(result, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string" },
        name: { type: "string" },
        "timeout-ms": { type: "string", default: "1200000" },
        "grace-ms": { type: "string", default: "180000" },
        "pause-file": { type: "string" },
      },
    });
    assert(values.output && values.name);
    const result = await runCommand({
      output: values.output,
      name: values.name,
      command: positionals,
      timeoutMs: Number(values["timeout-ms"]),
      graceMs: Number(values["grace-ms"]),
      pauseFile: values["pause-file"],
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.exit_code;
  } catch {
    console.error(
      "Verification runner failed; existing evidence was not overwritten.",
    );
    process.exitCode = 1;
  }
}
