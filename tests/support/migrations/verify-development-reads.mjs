// Replay saved reports through the actual CLI and a local HTTP adapter.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { durablePath } from "../storage.mjs";
import { writeDevelopmentJSON } from "../development-configuration.mjs";
import { writeFileSync } from "node:fs";

const { values } = parseArgs({
  options: { evidence: { type: "string" }, output: { type: "string" } },
});
const evidence = durablePath(values.evidence),
  output = durablePath(values.output);
assert(!existsSync(output), "use a fresh evidence directory");
process.umask(0o077);
mkdirSync(output, { recursive: true, mode: 0o700 });
const read = (path) => JSON.parse(readFileSync(durablePath(path), "utf8"));
const envFile = join(output, "fixture.env"),
  secretFile = join(output, "fixture-secrets.env");
writeFileSync(
  envFile,
  "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=offline-replay-password\n",
  { flag: "wx", mode: 0o600 },
);
writeFileSync(secretFile, "API_KEY=offline-replay-secret\n", {
  flag: "wx",
  mode: 0o600,
});
let responseForRequest;
const server = createServer(async (request, response) => {
  for await (const chunk of request) {
    /* drain fixture login */
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(responseForRequest(request.url)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const checks = [];
async function run(profile, name, fields) {
  const folder = join(output, name);
  mkdirSync(folder, { mode: 0o700 });
  const config = { output: folder, ...fields };
  writeDevelopmentJSON(config, "config.json", config);
  const result = await promisify(execFile)(
    process.execPath,
    [
      "tests/e2e/development/" + profile + ".mjs",
      "--config",
      join(folder, "config.json"),
    ],
    { timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
  );
  writeFileSync(join(folder, "stdout.log"), result.stdout, {
    flag: "wx",
    mode: 0o600,
  });
  return folder;
}
try {
  for (const group of [
    "controller-sync-20260917",
    "controller-sync-20260921",
    "development-sync-20260917",
    "runtime-sync-20260921",
    "temporal-sync-20260921",
  ]) {
    const previous = join(evidence, group);
    for (const basename of [
      "agent-before",
      "agent-after",
      "agent-after-acp",
      "agent-after-restart",
      "agent-final",
    ]) {
      if (!existsSync(join(previous, basename + ".json"))) continue;
      const saved = read(join(previous, basename + ".json"));
      assert(saved.checked_at && saved.execution_state);
      responseForRequest = (url) =>
        url === "/api/session/login"
          ? { ok: true }
          : url.startsWith("/api/admin/agents/")
            ? {
                agent_id: saved.agent_id,
                lifecycle_state: saved.lifecycle_state,
                activation_state: saved.activation_state,
                runtime_state: saved.runtime_state,
                active_operation_request_id: saved.active_operation_request_id,
                runtime: { runtime_revision: saved.runtime_revision },
                executable_execution_revision: saved.execution_revision,
              }
            : saved.execution_state;
      const folder = await run("agent-state", group + "-" + basename, {
        gateway: origin,
        envFile,
        agentId: saved.agent_id,
        reportBasename: basename,
      });
      const actual = read(join(folder, basename + ".json"));
      delete actual.checked_at;
      delete saved.checked_at;
      assert.deepEqual(actual, saved);
      checks.push({ group, report: basename, matches: true });
    }
    for (const count of [3, 4]) {
      if (!existsSync(join(previous, `traces-${count}.json`))) continue;
      const traces = read(join(previous, `traces-${count}.json`));
      const saved = read(join(previous, `trace-review-${count}.json`));
      responseForRequest = () => ({ data: traces });
      const folder = await run("trace-review", group + "-traces-" + count, {
        jaeger: origin,
        envFile,
        secretFile,
        sessionId: saved[0].session_id,
        expectedTraceCount: count,
        minRuntimeTraces: 2,
      });
      assert.deepEqual(read(join(folder, `traces-${count}.json`)), traces);
      assert.deepEqual(read(join(folder, `trace-review-${count}.json`)), saved);
      checks.push({
        group,
        traces: count,
        matches: true,
        strict_failed: saved.filter((row) => row.strict !== "passed").length,
      });
    }
  }
  const previous = join(evidence, "development-sync-20260917");
  const trace = read(join(previous, "rejection-trace.json")),
    saved = read(join(previous, "rejection-trace-review.json"));
  responseForRequest = () => ({ data: [trace] });
  const folder = await run("rejection-trace", "development-rejection", {
    jaeger: origin,
    rejectedSessionId: saved.session_id,
  });
  assert.deepEqual(read(join(folder, "rejection-trace.json")), trace);
  assert.deepEqual(read(join(folder, "rejection-trace-review.json")), saved);
  checks.push({
    group: "development-sync-20260917",
    rejection: true,
    matches: true,
  });
  const result = {
    status: "passed",
    checks,
    scope:
      "Actual CLI with saved raw Traces and reconstructed HTTP Agent responses. Current timestamps excluded from Agent comparison. Fixture credentials only; historical credentials were not rechecked. No current Gateway/Jaeger or deployment/business acceptance.",
  };
  writeDevelopmentJSON({ output }, "comparison.json", result);
  console.log(JSON.stringify(result));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
