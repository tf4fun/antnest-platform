import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

// Raw service logs may contain credentials, so a failed run keeps only the
// fields that explain a startup failure, each checked against every
// credential the run provisioned.

const WITHHELD = "[withheld: credential]";
const FIELD_LIMIT = 200;
const ERROR_LIMIT = 20;
const CRASH_LIMIT = 5;
const LOG_TAIL = "400";
const SECRET_NAME =
  /PASSWORD|SECRET|TOKEN|PRIVATE|CREDENTIAL|DATABASE_URL|(?:^|_)KEY(?:_|$)/u;
const ERROR_LEVELS = new Set(["error", "fatal", "panic", "dpanic", "critical"]);
const CRASH_LINE =
  /^(?:panic: |fatal error: |[A-Za-z]*Error(?: \[[A-Z_]+\])?: )/u;

export function credentialCanaries(directory, environment = process.env) {
  const canaries = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.length >= 8) canaries.add(value);
  };
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(file);
      if (entry.name.endsWith(".env")) {
        for (const [name, value] of Object.entries(
          parseEnv(bytes.toString("utf8")),
        ))
          if (SECRET_NAME.test(name)) add(value);
        continue;
      }
      const text = bytes.toString("utf8");
      add(text.trim());
      for (const token of text.split(/\s+/u))
        if (token.length >= 16) add(token);
      // Binary keys can only reach a log in an encoded form.
      if (bytes.length <= 4096)
        for (const encoding of ["base64", "base64url", "hex"])
          add(bytes.toString(encoding));
    }
  };
  visit(directory);
  for (const [name, value] of Object.entries(environment))
    if (SECRET_NAME.test(name)) add(value);
  return [...canaries];
}

export function failedContainers(containers) {
  return containers.filter(({ State: state }) => {
    if (state.OOMKilled) return true;
    if (state.Health?.Status === "unhealthy") return true;
    if (state.Status === "restarting") return true;
    return ["exited", "dead"].includes(state.Status) && state.ExitCode !== 0;
  });
}

function leaks(text, canaries) {
  return (
    text.includes("ant_api_") ||
    canaries.some(
      (canary) =>
        text.includes(canary) || text.includes(encodeURIComponent(canary)),
    )
  );
}

// The full value is checked before truncation so a cut cannot expose part
// of a credential that straddles the limit.
function guard(value, canaries) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return leaks(text, canaries) ? WITHHELD : text.slice(0, FIELD_LIMIT);
}

function errorRecord(line) {
  if (!line.startsWith("{")) return null;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const level = record.level ?? record.severity;
  const isError =
    typeof level === "number"
      ? level >= 50
      : typeof level === "string" && ERROR_LEVELS.has(level.toLowerCase());
  if (!isError) return null;
  return {
    msg: record.msg ?? record.message,
    code: record.error?.code ?? record.error_code,
  };
}

export function summarizeStartupFailure(container, logs, canaries) {
  const state = container.State;
  const errors = [];
  const crash = [];
  for (const raw of logs.split("\n")) {
    const line = raw.trimEnd();
    const record = errorRecord(line);
    if (record)
      errors.push({
        msg: guard(record.msg, canaries),
        code: guard(record.code, canaries),
      });
    else if (CRASH_LINE.test(line) && crash.length < CRASH_LIMIT)
      crash.push(guard(line, canaries));
  }
  const summary = {
    service: container.Config.Labels["com.docker.compose.service"],
    status: state.Status,
    exit_code: state.ExitCode,
    oom_killed: state.OOMKilled === true,
    health: state.Health?.Status ?? null,
    errors: errors.slice(-ERROR_LIMIT),
    crash,
  };
  if (errors.length > ERROR_LIMIT)
    summary.errors_omitted = errors.length - ERROR_LIMIT;
  return summary;
}

function docker(args, env) {
  const result = spawnSync("docker", args, {
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`docker ${args[0]} failed (${result.status})`);
  return result;
}

export function collectStartupFailures(
  project,
  credentials,
  env = process.env,
) {
  const canaries = credentialCanaries(credentials, env);
  const ids = docker(
    [
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
    env,
  )
    .stdout.split("\n")
    .filter(Boolean);
  const containers = ids.length
    ? JSON.parse(docker(["inspect", ...ids], env).stdout)
    : [];
  const failures = failedContainers(containers).map((container) => {
    const logs = docker(["logs", "--tail", LOG_TAIL, container.Id], env);
    return summarizeStartupFailure(
      container,
      `${logs.stdout}\n${logs.stderr}`,
      canaries,
    );
  });
  const output = JSON.stringify({ startup_failures: failures });
  // Every field passed guard(); this re-check covers the service names too.
  return leaks(output, canaries)
    ? JSON.stringify({ startup_failures: WITHHELD })
    : output;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [project, credentials] = process.argv.slice(2);
  if (!project || !credentials) {
    process.stderr.write(
      "usage: startup-failure-summary.mjs <compose-project> <credentials-directory>\n",
    );
    process.exit(2);
  }
  process.stdout.write(collectStartupFailures(project, credentials) + "\n");
}
