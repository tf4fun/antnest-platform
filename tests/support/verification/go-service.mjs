import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs, parseEnv } from "node:util";
import { resolve } from "node:path";
import { writeGoOverlay } from "../go-overlay.mjs";
import { GoResults } from "./go-results.mjs";
import { durablePath } from "../storage.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "env-file": { type: "string", default: ".env" },
    "test-database": { type: "string" },
    profile: { type: "string", default: "integration" },
    "deadline-ms": { type: "string", default: "720000" },
  },
});
values["env-file"] = durablePath(values["env-file"]);
const [service] = positionals;
if (positionals.length !== 1) throw new Error("expected one service");
const keys = {
  "runtime-controller": "RUNTIME_CONTROLLER",
  "agent-controller": "AGENT_CONTROLLER",
  "identity-service": "IDENTITY",
};
const key = keys[service];
if (!key) throw new Error("unknown test service");
const settings = values["test-database"]
  ? parseEnv(readFileSync(values["env-file"], "utf8"))
  : {};
const role = key.toLowerCase();
const variable = `ANTNEST_${key}_TEST_DATABASE_URL`;
let databaseURL = process.env[variable];
if (values["test-database"]) {
  if (databaseURL)
    throw new Error("choose either a test URL or --test-database");
  if (!/^[a-z][a-z0-9_]*_test$/.test(values["test-database"]))
    throw new Error("test database must end in _test");
  const port = settings.ANTNEST_POSTGRES_HOST_PORT ?? "55432";
  const url = new URL(
    `postgres://antnest_${role}@127.0.0.1:${port}/${values["test-database"]}`,
  );
  url.password = settings[`ANTNEST_${key}_POSTGRES_PASSWORD`];
  if (!url.password) throw new Error("missing database configuration");
  url.searchParams.set("sslmode", "disable");
  databaseURL = url.toString();
}
if (!databaseURL || !new URL(databaseURL).pathname.endsWith("_test"))
  throw new Error("an explicit isolated test database is required");
// One outer budget covers compilation and execution. It may be shortened for
// tests, never raised.
const deadlineMs = Number(values["deadline-ms"]);
if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 720000)
  throw new Error("deadline must be 1..720000 milliseconds");
const output = durablePath(resolve("artifacts/verification/go-integration"));
const overlay = writeGoOverlay({
  root: process.cwd(),
  service,
  output,
  profile: values.profile,
});
const packages = `./services/${service}/...`;
const env = { ...process.env, [variable]: databaseURL };
const started = Date.now();
const results = new GoResults();
let child;
let reason;
function terminate(signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    // macOS reports EPERM once only exited members of the killed group remain.
    if (!["ESRCH", "EPERM"].includes(error.code)) throw error;
  }
}
const stop = (value) => {
  reason ??= value;
  terminate("SIGKILL");
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => stop("interrupted"));
const timer = setTimeout(() => stop("deadline_exceeded"), deadlineMs);
function launch(args) {
  child = spawn("go", args, {
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve) => {
    child.on("error", () => {
      console.error("could not start Go tests");
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
const identify = (row) => console.log(JSON.stringify(row));
const completion = launch([
  "test",
  "-json",
  "-overlay",
  overlay,
  "-race",
  "-p=1",
  packages,
  "-count=1",
  "-timeout=10m",
]);
child.stderr.on("data", (data) => process.stderr.write(data));
try {
  for await (const line of createInterface({ input: child.stdout }))
    results.accept(JSON.parse(line), console.error, identify);
} catch {
  stop("invalid_event_stream");
  console.error("invalid Go test event stream; partial results discarded");
}
const code = await completion;
clearTimeout(timer);
terminate("SIGKILL");
const progress = results.progress();
if (!reason) progress.phase = "finished";
if (reason) results.identifyRunning(identify);
// Sanitized timing evidence: package paths, top-level test names and
// durations only. It is retained for every run, including passing ones.
writeFileSync(
  resolve(output, `go-progress-${service}-${randomUUID()}.json`),
  `${JSON.stringify(
    {
      version: 1,
      service,
      complete: !reason && code === 0,
      ...(reason ? { reason } : {}),
      deadline_ms: deadlineMs,
      elapsed_ms: Date.now() - started,
      ...progress,
    },
    null,
    2,
  )}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify(
    reason
      ? {
          service,
          complete: false,
          partial_results_discarded: true,
          reason,
          phase: progress.phase,
          running: progress.running,
        }
      : {
          service,
          ...results.summary,
          skipped_tests: results.skipped,
          complete: code === 0,
        },
  ),
);
process.exitCode = reason ? 1 : code;
