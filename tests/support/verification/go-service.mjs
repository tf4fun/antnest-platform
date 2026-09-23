import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
const overlay = writeGoOverlay({
  root: process.cwd(),
  service,
  output: resolve("artifacts/verification/go-integration"),
  profile: values.profile,
});
const child = spawn(
  "go",
  [
    "test",
    "-json",
    "-overlay",
    overlay,
    "-race",
    "-p=1",
    `./services/${service}/...`,
    "-count=1",
    "-timeout=10m",
  ],
  {
    detached: true,
    env: { ...process.env, [variable]: databaseURL },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const results = new GoResults();
function terminate(signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
let interrupted = false;
const stop = () => {
  interrupted = true;
  terminate("SIGKILL");
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
const timer = setTimeout(stop, 720000);
const completion = new Promise((resolve) => {
  child.on("error", () => {
    console.error("could not start Go tests");
    resolve(1);
  });
  child.on("close", (code) => resolve(code ?? 1));
});
child.stderr.on("data", (data) => process.stderr.write(data));
try {
  for await (const line of createInterface({ input: child.stdout })) {
    const event = JSON.parse(line);
    results.accept(event, console.error);
  }
} catch {
  stop();
  console.error("invalid Go test event stream; partial results discarded");
}
const code = await completion;
clearTimeout(timer);
terminate("SIGKILL");
console.log(
  JSON.stringify(
    interrupted
      ? { service, complete: false, partial_results_discarded: true }
      : {
          service,
          ...results.summary,
          skipped_tests: results.skipped,
          complete: code === 0,
        },
  ),
);
process.exitCode = interrupted ? 1 : code;
