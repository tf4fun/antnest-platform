import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "../../support/run-command.mjs";
import {
  recoveryAgent,
  recoveryScope,
  recoveryVolume,
  recoveryAgentState,
  recoveryInspection,
  recoveryTrace,
} from "../../support/fixtures/development-recovery.mjs";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "antnest-recovery-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = {
    root,
    requests: [],
    original: recoveryAgentState(),
    recovered: recoveryAgentState(true),
    before: recoveryInspection(),
    after: recoveryInspection(true),
    trace: recoveryTrace().trace,
    state: {
      agent_id: recoveryAgent,
      availability: "ready",
      active_session_id: null,
    },
    rebuilt: false,
    operationState: "completed",
    hashExit: 0,
    manifest: "a".repeat(64) + "  ./marker.txt\n",
  };
  const stateFile = join(root, "docker-state.json"),
    callsFile = join(root, "docker-calls.jsonl");
  const saveDocker = () =>
    writeFileSync(
      stateFile,
      JSON.stringify({
        inspection: f.rebuilt ? f.after : f.before,
        manifest: f.manifest,
        hashExit: f.hashExit,
      }),
    );
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    f.requests.push({ url: request.url, method: request.method, body });
    let value,
      status = 200;
    if (request.url === "/api/session/login") value = {};
    else if (request.url === `/api/admin/agents/${recoveryAgent}/rebuild`) {
      f.rebuilt = true;
      saveDocker();
      value = { request_id: "request-test" };
      status = 202;
    } else if (request.url === `/api/admin/agents/${recoveryAgent}`)
      value = f.rebuilt ? f.recovered : f.original;
    else if (request.url === "/api/admin/operations/request-test")
      value = { state: f.operationState };
    else if (request.url === `/api/app/agents/${recoveryAgent}/state`)
      value = f.state;
    else if (request.url === `/api/traces/${f.trace.traceID}`)
      value = { data: [f.trace] };
    else {
      value = { error: "unexpected request" };
      status = 404;
    }
    response.writeHead(status, {
      "content-type": "application/json",
      "x-antnest-trace-id": f.trace.traceID,
    });
    response.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}\nimport {readFileSync,appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2);appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(args)+'\\n');const state=JSON.parse(readFileSync(${JSON.stringify(stateFile)}));if(args[0]==='inspect')process.stdout.write(JSON.stringify([state.inspection]));else if(args[0]==='exec'){process.stdout.write(state.manifest);process.exitCode=state.hashExit;}else process.exitCode=79;\n`,
    { mode: 0o700 },
  );
  const envFile = join(root, "settings.env"),
    secretFile = join(root, "secret.env"),
    workspaceManifest = join(root, "workspace.sha256");
  writeFileSync(
    envFile,
    "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
  );
  writeFileSync(secretFile, "API_KEY=fixture-secret\n");
  writeFileSync(workspaceManifest, f.manifest);
  f.config = {
    gateway: origin,
    jaeger: origin,
    envFile,
    secretFile,
    retainedAgentId: recoveryAgent,
    runtimeContainerPrefix: "antnest-runtime-",
    runtimeControllerScope: recoveryScope,
    workspaceVolume: recoveryVolume,
    workspaceManifest,
    output: join(root, "output"),
  };
  f.dockerCalls = () =>
    existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse)
      : [];
  f.read = (name) => JSON.parse(readFileSync(join(f.config.output, name)));
  f.run = async () => {
    saveDocker();
    const path = join(root, "configuration.json");
    writeFileSync(path, JSON.stringify(f.config));
    const result = await runCommand({
      output: join(root, "runner"),
      name: "recovery",
      timeoutMs: 15000,
      graceMs: 1000,
      command: [
        process.execPath,
        "tests/e2e/development/recover.mjs",
        "--config",
        path,
      ],
      env: { ...process.env, PATH: bin + ":" + process.env.PATH },
    });
    return {
      ...result,
      log: readFileSync(join(root, "runner/recovery.log"), "utf8"),
    };
  };
  return f;
}

test("recovery CLI preserves one rebuild, workspace/configuration and stable Trace evidence", async (t) => {
  const f = await fixture(t),
    result = await f.run();
  assert.equal(result.exit_code, 0, result.log);
  const report = f.read("recovery-report.json");
  assert.equal(report.status, "passed");
  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.publication, []);
  assert.equal(report.lifecycle.length, 1);
  assert.equal(report.lifecycle[0].kind, "rebuild");
  assert.equal(report.lifecycle[0].evidence.strict_trace, "passed");
  assert.equal(
    f.requests.filter((r) => r.url.includes("/api/traces/")).length,
    3,
  );
  const rebuilds = f.requests.filter((r) => r.url.endsWith("/rebuild"));
  assert.equal(rebuilds.length, 1);
  assert.deepEqual(JSON.parse(rebuilds[0].body), {
    template_id: "template-fixture",
    template_revision: 1,
  });
  assert.equal(
    f.read("recovered-runtime.json").workspace_bytes_preserved,
    true,
  );
  assert.deepEqual(f.read("recovery-trace.private.json"), f.trace);
});

test("recovery retains clock warnings as a strict Trace failure", async (t) => {
  const f = await fixture(t);
  f.trace.spans[0].warnings = ["clock skew adjustment disabled; fixture"];
  const result = await f.run();
  assert.equal(result.exit_code, 0, result.log);
  assert.equal(
    f.read("recovery-report.json").lifecycle[0].evidence.strict_trace,
    "failed",
  );
});

for (const [name, change] of [
  ["missing manifest", (f) => rmSync(f.config.workspaceManifest)],
  [
    "cached manifest",
    (f) => {
      const p = join(f.root, ".cache");
      mkdirSync(p);
      f.config.workspaceManifest = join(p, "missing.sha256");
    },
  ],
  ["bad gateway origin", (f) => (f.config.gateway += "/wrong")],
  ["bad Agent identity", (f) => (f.config.retainedAgentId = "../foreign")],
  [
    "invalid container prefix",
    (f) => (f.config.runtimeContainerPrefix = "--foreign"),
  ],
  ["missing scope", (f) => delete f.config.runtimeControllerScope],
  ["missing expected volume", (f) => delete f.config.workspaceVolume],
  [
    "missing login field",
    (f) =>
      writeFileSync(
        f.config.envFile,
        "ANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
      ),
  ],
])
  test(`recovery rejects ${name} before HTTP or Docker`, async (t) => {
    const f = await fixture(t);
    change(f);
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.dockerCalls(), []);
  });

for (const name of [
  "lifecycle-progress.json",
  "recovered-runtime.json",
  "recovery-trace.private.json",
  "recovery-report.json",
])
  test(`recovery rejects a cached ${name} leaf before HTTP or Docker`, async (t) => {
    const f = await fixture(t);
    mkdirSync(f.config.output);
    mkdirSync(join(f.root, ".cache"));
    symlinkSync(
      join(f.root, ".cache/missing.json"),
      join(f.config.output, name),
    );
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.dockerCalls(), []);
    assert(!existsSync(join(f.root, ".cache/missing.json")));
  });

for (const [name, change] of [
  [
    "wrong original Agent",
    (f) => (f.original.agent_id = "agent_" + "e".repeat(32)),
  ],
  ["wrong failure", (f) => (f.original.failure_code = "other")],
  ["wrong Runtime name", (f) => (f.before.Name = "/foreign")],
  [
    "wrong Runtime Agent label",
    (f) => (f.before.Config.Labels["io.antnest.agent-id"] = "foreign"),
  ],
  [
    "wrong Runtime scope",
    (f) =>
      (f.before.Config.Labels["io.antnest.runtime-controller-scope"] =
        "foreign"),
  ],
  ["wrong workspace", (f) => (f.before.Mounts[0].Name = "foreign")],
  ["readonly workspace", (f) => (f.before.Mounts[0].RW = false)],
  [
    "shadowed workspace",
    (f) =>
      f.before.Mounts.push({
        Destination: "/workspace/nested",
        Type: "volume",
        RW: true,
        Name: "foreign",
      }),
  ],
  [
    "tmpfs-shadowed workspace",
    (f) => (f.before.HostConfig = { Tmpfs: { "/workspace/nested": "" } }),
  ],
])
  test(`recovery rejects ${name} before rebuilding`, async (t) => {
    const f = await fixture(t);
    change(f);
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(f.rebuilt, false);
    assert.equal(f.read("recovery-report.json").status, "failed");
  });

for (const [name, change] of [
  ["failed operation", (f) => (f.operationState = "failed")],
  ["unchanged Runtime", (f) => (f.after.Id = f.before.Id)],
  ["changed volume", (f) => (f.after.Mounts[0].Name = "foreign")],
  [
    "changed workspace bytes",
    (f) => (f.manifest = "b".repeat(64) + "  ./marker.txt\n"),
  ],
  ["hash command failure", (f) => (f.hashExit = 17)],
  [
    "changed configuration",
    (f) => (f.recovered.configuration.model.model_id = "foreign"),
  ],
  [
    "wrong recovered Agent",
    (f) => (f.recovered.agent_id = "agent_" + "e".repeat(32)),
  ],
  [
    "wrong recovered Runtime binding",
    (f) => (f.after.Config.Labels["io.antnest.agent-id"] = "foreign"),
  ],
  ["wrong app Agent", (f) => (f.state.agent_id = "agent_" + "e".repeat(32))],
  ["not ready", (f) => (f.state.availability = "offline")],
  ["active Session", (f) => (f.state.active_session_id = "foreign")],
])
  test(`recovery rejects ${name} after rebuilding`, async (t) => {
    const f = await fixture(t);
    change(f);
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(f.read("recovery-report.json").status, "failed");
  });
