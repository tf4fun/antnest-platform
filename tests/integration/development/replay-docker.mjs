// Opt-in: actual PostgreSQL, pinned SDK and local HTTP/WebSocket fixture; no service deployment.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { runCommand } from "../../support/run-command.mjs";
import { durablePath } from "../../support/storage.mjs";
import { writeDevelopmentJSON } from "../../support/development-configuration.mjs";
import {
  snapshotEnvironment,
  compareEnvironment,
} from "../../support/verification/environment.mjs";
import {
  replayAgent,
  replaySession,
  replayHistory,
  replayTrace,
} from "../../support/fixtures/development-replay.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws");
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "postgres-image": { type: "string" },
    "history-root": { type: "string" },
  },
});
const output = durablePath(values.output);
assert(!existsSync(output), "use a fresh output directory");
const historyRoot = values["history-root"]
  ? durablePath(values["history-root"])
  : undefined;
assert(values["postgres-image"], "--postgres-image required");
process.umask(0o077);
mkdirSync(output, { recursive: true, mode: 0o700 });
const write = (name, value) => writeDevelopmentJSON({ output }, name, value);
const docker = (args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
const image = docker([
  "image",
  "inspect",
  "--format",
  "{{.Id}}",
  values["postgres-image"],
]);
const tags = () =>
  docker([
    "image",
    "ls",
    "--no-trunc",
    "--format",
    "{{.Repository}}:{{.Tag}} {{.ID}}",
  ])
    .split("\n")
    .sort();
const before = await snapshotEnvironment();
before.imageTags = tags();
write("environment-before.json", before);
const container =
  "antnest-replay-" + randomUUID().replaceAll("-", "").slice(0, 12);
const database = { container, user: "fixture_admin", name: "fixture_acp" };
const abort = new AbortController(),
  handlers = new Map();
for (const name of ["SIGINT", "SIGTERM"]) {
  const handler = () => abort.abort(new Error(name));
  handlers.set(name, handler);
  process.on(name, handler);
}
const sql = (query) =>
  docker([
    "exec",
    container,
    "psql",
    "-h",
    "127.0.0.1",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    database.user,
    "-d",
    database.name,
    "-c",
    query,
  ]);
const checks = [];
let owned = false;
try {
  owned = true;
  docker([
    "run",
    "-d",
    "--name",
    container,
    "--network",
    "none",
    "--label",
    "io.antnest.verification=" + container,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_USER=" + database.user,
    "-e",
    "POSTGRES_DB=" + database.name,
    image,
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    abort.signal.throwIfAborted();
    try {
      sql("SELECT 1");
      ready = true;
      break;
    } catch {
      await delay(200, undefined, { signal: abort.signal });
    }
  }
  assert(ready, "PostgreSQL startup deadline");
  sql(
    "CREATE TABLE acp_sessions(id text PRIMARY KEY,agent_id text,cwd text); CREATE TABLE runs(id text); CREATE TABLE tool_attempts(id text); CREATE TABLE session_messages(session_id text,sequence int,visible boolean,payload jsonb);",
  );
  for (const kind of [
    "passed",
    "trace-warning",
    "wrong-session-agent",
    "history-changed",
    "diff-changed",
    "extra-run",
    "empty-history",
    "malformed-history",
    "output-alias",
    ...(historyRoot ? ["history-runtime", "history-temporal"] : []),
  ]) {
    abort.signal.throwIfAborted();
    const folder = join(output, kind);
    mkdirSync(folder, { mode: 0o700 });
    const evidence = join(folder, "evidence");
    mkdirSync(evidence, { mode: 0o700 });
    const historical =
      kind.startsWith("history-") && kind !== "history-changed";
    let history = replayHistory(),
      expectedReport,
      savedTrace;
    let agentId = replayAgent,
      sessionId = replaySession;
    if (historical) {
      const old = join(
        historyRoot,
        kind.slice("history-".length) + "-sync-20260921",
      );
      const read = (name) =>
        JSON.parse(readFileSync(durablePath(join(old, name))));
      expectedReport = read("replay-report.json");
      savedTrace = read("replay-trace.private.json");
      sessionId = expectedReport.session_id;
      assert(/^[a-f0-9-]{36}$/u.test(sessionId));
      docker([
        "exec",
        container,
        "dropdb",
        "-U",
        database.user,
        "--force",
        database.name,
      ]);
      docker([
        "exec",
        container,
        "createdb",
        "-U",
        database.user,
        database.name,
      ]);
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          container,
          "pg_restore",
          "--exit-on-error",
          "--no-owner",
          "--no-privileges",
          "-U",
          database.user,
          "-d",
          database.name,
        ],
        {
          input: readFileSync(durablePath(join(old, "antnest_agent_acp.dump"))),
          timeout: 60000,
        },
      );
      agentId = sql(
        `SELECT agent_id FROM acp_sessions WHERE id='${sessionId}'`,
      );
      assert(/^agent_[a-f0-9]{32}$/u.test(agentId));
      history = {
        updates: read("replay-updates.private.json"),
        rows: JSON.parse(
          sql(
            `SELECT jsonb_agg(jsonb_build_object('visible',visible,'payload',payload) ORDER BY sequence) FROM session_messages WHERE session_id='${sessionId}'`,
          ),
        ),
      };
    } else {
      sql(
        `TRUNCATE acp_sessions,runs,tool_attempts,session_messages; INSERT INTO acp_sessions VALUES ('${replaySession}','${kind === "wrong-session-agent" ? "other-agent" : replayAgent}','/workspace');`,
      );
      if (kind === "malformed-history")
        history.rows[2].payload.argumentsJson = "{";
      if (kind !== "empty-history")
        for (const [index, row] of history.rows.entries())
          sql(
            `INSERT INTO session_messages VALUES ('${replaySession}',${index},${row.visible},'${JSON.stringify(row.payload).replaceAll("'", "''")}'::jsonb);`,
          );
    }
    if (kind === "history-changed")
      history.updates[1].update.content.text = "changed";
    if (kind === "diff-changed")
      history.updates[2].update.content[1].newText = "wrong";
    const requests = [],
      rpc = [];
    let trace,
      samples = 0;
    const server = createServer(async (request, response) => {
      for await (const chunk of request) {
        /* drain login */
      }
      requests.push(request.url);
      response.writeHead(200, {
        "content-type": "application/json",
        ...(request.url === "/api/session/login"
          ? { "set-cookie": "antnest_session=fixture-cookie; HttpOnly; Path=/" }
          : {}),
      });
      if (request.url.startsWith("/api/traces/")) samples++;
      response.end(
        JSON.stringify(
          request.url.startsWith("/api/traces")
            ? { data: [trace] }
            : { ok: true },
        ),
      );
    });
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket, request) => {
      const connectionTraceID = request.headers.traceparent.split("-")[1];
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        rpc.push(message);
        if (message.method === "initialize")
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: message.params.protocolVersion,
                agentCapabilities: { loadSession: true },
              },
            }),
          );
        else if (message.method === "session/load") {
          trace = historical
            ? structuredClone(savedTrace)
            : replayTrace({
                agentId,
                sessionId,
                requestId: message.id,
                connectionTraceID,
                warning: kind === "trace-warning",
              });
          if (historical)
            for (const span of trace.spans) {
              for (const ref of span.references ?? [])
                if (ref.refType === "FOLLOWS_FROM")
                  ref.traceID = connectionTraceID;
              for (const field of span.tags ?? [])
                if (field.key === "antnest.request.id")
                  field.value = String(message.id);
            }
          for (const params of history.updates)
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params,
              }),
            );
          if (kind === "extra-run")
            sql("INSERT INTO runs VALUES ('unexpected');");
          socket.send(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }),
          );
        }
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = "http://127.0.0.1:" + server.address().port;
      const envFile = join(folder, "fixture.env");
      writeFileSync(
        envFile,
        "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
        { flag: "wx", mode: 0o600 },
      );
      const config = {
        output: evidence,
        gateway: origin,
        jaeger: origin,
        envFile,
        database,
        agentId,
        sessionId,
      };
      writeDevelopmentJSON({ output: folder }, "config.json", config);
      if (kind === "output-alias") {
        const cache = join(folder, ".cache");
        mkdirSync(cache);
        symlinkSync(
          join(cache, "missing.json"),
          join(evidence, "replay-report.json"),
        );
      }
      const execution = await runCommand({
        command: [
          process.execPath,
          "tests/e2e/development/replay.mjs",
          "--config",
          join(folder, "config.json"),
        ],
        output: folder,
        name: "execution",
        timeoutMs: 60000,
        graceMs: 5000,
      });
      abort.signal.throwIfAborted();
      assert(execution.complete, kind + ": CLI did not complete");
      const result = {
        code: execution.exit_code,
        stderr: readFileSync(join(folder, "execution.log"), "utf8"),
      };
      const success = ["passed", "trace-warning"].includes(kind) || historical;
      assert.equal(
        result.code === 0,
        success,
        kind + ": unexpected exit, see " + folder,
      );
      if (success) {
        const report = JSON.parse(
          readFileSync(join(evidence, "replay-report.json")),
        );
        assert.equal(report.durable_messages, history.rows.length);
        assert.equal(report.notifications, history.updates.length);
        assert.equal(report.new_runs, 0);
        assert.equal(report.new_tools, 0);
        assert.equal(
          report.trace.strict_trace,
          historical
            ? expectedReport.trace.strict_trace
            : kind === "trace-warning"
              ? "failed"
              : "passed",
        );
        assert(samples >= 3, "raw Trace must survive convergence writes");
        assert.deepEqual(
          JSON.parse(
            readFileSync(join(evidence, "replay-updates.private.json")),
          ),
          history.updates,
        );
        assert.deepEqual(
          rpc.map((row) => row.method),
          ["initialize", "session/load"],
        );
        assert.deepEqual(rpc[1].params, {
          sessionId,
          cwd: "/workspace",
          mcpServers: [],
        });
        if (historical) {
          assert.deepEqual(report, expectedReport, "historical report changed");
          assert.deepEqual(
            JSON.parse(
              readFileSync(join(evidence, "replay-trace.private.json")),
            ),
            trace,
          );
        }
      } else {
        assert(
          !existsSync(join(evidence, "replay-report.json")),
          kind + ": wrote a passing report",
        );
        const expected = {
          "wrong-session-agent": /Session database binding/,
          "history-changed": /durable history/,
          "diff-changed": /saved file observations/,
          "extra-run": /history load created/,
          "empty-history": /SyntaxError/,
          "malformed-history": /SyntaxError/,
          "output-alias": /symbolic link|cache/,
        }[kind];
        assert.match(result.stderr, expected);
        if (
          [
            "wrong-session-agent",
            "empty-history",
            "malformed-history",
            "output-alias",
          ].includes(kind)
        )
          assert.equal(requests.length, 0, "invalid inputs reached HTTP");
      }
      checks.push({
        case: kind,
        exit_code: result.code,
        expected_failure: !success,
        trace_samples: samples,
        ...(historical
          ? {
              database_baseline: "restored original PGDMP backup",
              durable_messages: history.rows.length,
              notifications: history.updates.length,
              report_matches: true,
              strict_trace: expectedReport.trace.strict_trace,
            }
          : {}),
      });
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
} finally {
  if (owned) docker(["rm", "-fv", container]);
  const after = await snapshotEnvironment({ before });
  after.imageTags = tags();
  write("environment-after.json", after);
  const isolation = compareEnvironment(before, after);
  assert.deepEqual(after.imageTags, before.imageTags);
  write("isolation.json", isolation);
  for (const [name, handler] of handlers) process.removeListener(name, handler);
  assert(isolation.unchanged, "retained environment changed");
}
const result = {
  status: "passed",
  checks,
  scope:
    "Actual Docker PostgreSQL SELECTs, pinned ACP SDK and local HTTP/WebSocket/Jaeger fixtures. Synthetic positive/negative cases plus optional historical PGDMP restores, original notifications and saved Traces rebound only to the new connection/request. Historical credentials are not rechecked. No retained service or production ACP deployment acceptance.",
};
write("result.json", result);
console.log(JSON.stringify(result));
