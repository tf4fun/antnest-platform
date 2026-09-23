import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  agentId,
  sessionId,
  chatTrace,
  managedAgent,
  executionState,
} from "../../support/fixtures/development-read-only.mjs";

async function fixture(t, profile) {
  const root = mkdtempSync(join(tmpdir(), "antnest-development-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = {
    requests: [],
    agent: managedAgent(),
    state: executionState(),
    traces:
      profile === "trace-review"
        ? [chatTrace(1), chatTrace(2), chatTrace(3)]
        : [chatTrace(4, true)],
    status: 200,
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    f.requests.push({ method: request.method, url: request.url, body });
    const value = request.url.startsWith("/api/traces?")
      ? { data: f.traces }
      : request.url === "/api/session/login"
        ? { ok: true }
        : request.url.startsWith("/api/admin/agents/")
          ? f.agent
          : f.state;
    response.writeHead(f.status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const envFile = join(root, "settings.env"),
    secretFile = join(root, "secret.env");
  writeFileSync(
    envFile,
    "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
  );
  writeFileSync(secretFile, "API_KEY=fixture-secret\n");
  const output = join(root, "output");
  f.config = {
    output,
    ...(profile === "agent-state"
      ? { gateway: origin, envFile, agentId, reportBasename: "agent-before" }
      : profile === "trace-review"
        ? {
            jaeger: origin,
            envFile,
            secretFile,
            sessionId,
            expectedTraceCount: 3,
            minRuntimeTraces: 2,
          }
        : { jaeger: origin, rejectedSessionId: sessionId }),
  };
  f.root = root;
  f.read = (name) => JSON.parse(readFileSync(join(output, name)));
  f.run = async () => {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(f.config));
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ["tests/e2e/development/" + profile + ".mjs", "--config", configPath],
        { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      );
      return { ...result, code: 0 };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  return f;
}

test("agent-state actual CLI preserves login, state fields and custom before report", async (t) => {
  const f = await fixture(t, "agent-state");
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    f.requests.map((r) => r.url),
    [
      "/api/session/login",
      "/api/admin/agents/" + agentId,
      "/api/app/agents/" + agentId + "/state",
    ],
  );
  assert.deepEqual(JSON.parse(f.requests[0].body), {
    organization_slug: "fixture",
    email: "fixture@example.invalid",
    password: "fixture-password",
  });
  const report = f.read("agent-before.json");
  assert.equal(report.agent_id, agentId);
  assert.deepEqual(report.execution_state, f.state);
  assert.equal(report.runtime_revision, "runtime-revision");
  assert.equal(report.execution_revision, "execution-revision");
  assert.equal(
    statSync(join(f.config.output, "agent-before.json")).mode & 0o777,
    0o600,
  );
});

for (const [name, change] of [
  ["not ready", (f) => (f.state.availability = "offline")],
  ["active Session", (f) => (f.state.active_session_id = sessionId)],
  ["access denied", (f) => (f.state.access_allowed = false)],
  ["wrong Agent", (f) => (f.state.agent_id = "agent_" + "b".repeat(32))],
  ["HTTP failure", (f) => (f.status = 503)],
])
  test(`agent-state rejects ${name} without a passing report`, async (t) => {
    const f = await fixture(t, "agent-state");
    change(f);
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert(!existsSync(join(f.config.output, "agent-before.json")));
  });

test("trace-review retains raw bytes, strict failure and exact query scope", async (t) => {
  const f = await fixture(t, "trace-review");
  f.traces[0].spans.at(-1).warnings = [
    "clock skew adjustment disabled; fixture",
  ];
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.read("traces-3.json"), f.traces);
  const reports = f.read("trace-review-3.json");
  assert.equal(reports.filter((r) => r.strict !== "passed").length, 1);
  assert(
    reports.every((r) => r.session_id === sessionId && r.runtime_calls === 1),
  );
  const query = new URL(f.requests[0].url, f.config.jaeger).searchParams;
  assert.equal(query.get("service"), "agent-acp-service");
  assert.equal(query.get("limit"), "20");
  assert.equal(query.get("lookback"), "1h");
  assert.deepEqual(JSON.parse(query.get("tags")), {
    "rpc.method": "session/prompt",
    "antnest.session.id": sessionId,
  });
});

for (const [name, change] of [
  ["missing Trace", (f) => f.traces.pop()],
  ["duplicate Trace", (f) => (f.traces[1] = f.traces[0])],
  [
    "missing parent",
    (f) => (f.traces[0].spans[2].references[0].spanID = "missing"),
  ],
  [
    "unexpected warning",
    (f) => (f.traces[0].spans[2].warnings = ["not a clock warning"]),
  ],
  [
    "error span",
    (f) => f.traces[0].spans[3].tags.push({ key: "error", value: true }),
  ],
  [
    "wrong Session",
    (f) =>
      (f.traces[0].spans[2].tags.find(
        (t) => t.key === "antnest.session.id",
      ).value = "other"),
  ],
  [
    "too few Runtime traces",
    (f) => f.traces.slice(0, 2).forEach((trace) => trace.spans.splice(-2)),
  ],
])
  test(`trace-review rejects ${name}`, async (t) => {
    const f = await fixture(t, "trace-review");
    change(f);
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert(!existsSync(join(f.config.output, "trace-review-3.json")));
  });

test("rejection-trace preserves expected rejection report and query", async (t) => {
  const f = await fixture(t, "rejection-trace");
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const report = f.read("rejection-trace-review.json");
  assert.equal(report.session_id, sessionId);
  assert.equal(report.model_requests, 0);
  assert.equal(report.scope, "expected rejection; not a successful-chat trace");
  assert.equal(
    new URL(f.requests[0].url, f.config.jaeger).searchParams.get("limit"),
    "10",
  );
});

for (const [name, change] of [
  [
    "wrong Session",
    (f) =>
      (f.traces[0].spans[2].tags.find(
        (t) => t.key === "antnest.session.id",
      ).value = "other"),
  ],
  ["model call", (f) => (f.traces = [chatTrace(4)])],
  ["missing rejection class", (f) => f.traces[0].spans[2].tags.pop()],
  [
    "payload capture",
    (f) =>
      (f.traces[0].spans[2].logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ]),
  ],
])
  test(`rejection-trace rejects ${name}`, async (t) => {
    const f = await fixture(t, "rejection-trace");
    change(f);
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert(!existsSync(join(f.config.output, "rejection-trace-review.json")));
  });

for (const profile of ["agent-state", "trace-review", "rejection-trace"])
  test(`${profile} rejects a cached report alias before any HTTP request`, async (t) => {
    const f = await fixture(t, profile);
    mkdirSync(f.config.output);
    mkdirSync(join(f.root, ".cache"));
    const name =
      profile === "agent-state"
        ? "agent-before.json"
        : profile === "trace-review"
          ? "trace-review-3.json"
          : "rejection-trace-review.json";
    symlinkSync(
      join(f.root, ".cache/missing.json"),
      join(f.config.output, name),
    );
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.equal(f.requests.length, 0);
  });
