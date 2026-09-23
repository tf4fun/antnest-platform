import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { lifecycleCliFixture } from "../../support/fixtures/development-lifecycle-cli.mjs";
import { lifecycleKinds } from "../../support/fixtures/development-lifecycle.mjs";
import {
  runtimeLossTrace,
  runtimeLossSnapshots,
} from "../../support/fixtures/development-runtime-loss.mjs";

async function fixture(t) {
  const f = await lifecycleCliFixture(t);
  f.entry = "tests/e2e/development/runtime-loss.mjs";
  // Preserve deadline intervals and sample counts with a virtual polling clock.
  f.preload =
    "import timers from 'node:timers/promises';import {syncBuiltinESMExports} from 'node:module';let tick=0;const now=Date.now;Date.now=()=>now()+tick;const delay=timers.setTimeout;timers.setTimeout=(ms,...args)=>{tick+=ms;return delay(1,...args)};syncBuiltinESMExports();";
  delete f.config.runtimeControllerScope;
  f.snapshots = runtimeLossSnapshots(f.scope);
  f.config.restartSnapshot = join(f.root, "restart.json");
  f.config.composeSnapshot = join(f.root, "compose.json");
  f.inspection.Config.Labels["io.antnest.runtime-generation"] = "2";
  f.lifecycles = Object.fromEntries(
    lifecycleKinds.map((kind) => [kind, runtimeLossTrace(kind)]),
  );
  const state = join(f.root, "docker.json"),
    calls = join(f.root, "calls.jsonl"),
    loss = join(f.root, "loss.json");
  f.agentResponse = (row) => {
    if (f.stage !== "enable" || !existsSync(loss)) return row;
    return {
      ...row,
      failure_code: "runtime_exited",
      executable_execution_revision: null,
      runtime_state:
        JSON.parse(readFileSync(loss)).phase === "absent"
          ? "absent"
          : "unavailable",
    };
  };
  const originalSave = f.save;
  f.save = () => {
    originalSave();
    const value = JSON.parse(readFileSync(state));
    value.stopped = f.stopped ?? {
      Running: false,
      ExitCode: 0,
      OOMKilled: false,
    };
    writeFileSync(state, JSON.stringify(value));
  };
  writeFileSync(
    join(f.root, "bin/docker"),
    `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
const args=process.argv.slice(2),file=${JSON.stringify(state)},loss=${JSON.stringify(loss)};
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
const s=JSON.parse(readFileSync(file));
if(args[0]==='inspect') { if(existsSync(loss)&&args[1]===s.inspection.Id) s.inspection.State=s.stopped; process.stdout.write(JSON.stringify([s.inspection])); }
else if(args[0]==='stop') writeFileSync(loss,JSON.stringify({phase:'exited'}));
else if(args[0]==='rm') writeFileSync(loss,JSON.stringify({phase:'absent'}));
else if(args[0]==='exec') { if(args.includes('cat')||args.some(x=>x.includes('cat --')))process.stdout.write(s.marker); }
else if(args[0]==='ps'||args[0]==='volume')process.stdout.write(s.residue);else process.exitCode=79;
`,
    { mode: 0o700 },
  );
  const run = f.run;
  f.run = () => {
    writeFileSync(
      f.config.restartSnapshot,
      JSON.stringify(f.snapshots.restart),
    );
    writeFileSync(
      f.config.composeSnapshot,
      JSON.stringify(f.snapshots.compose),
    );
    return run();
  };
  return f;
}

test("runtime loss preserves normal stop, source generation, five absences and post-restart publications", async (t) => {
  const f = await fixture(t),
    result = await f.run();
  assert.equal(result.exit_code, 0, result.log);
  const report = f.read("lifecycle-report.json");
  assert.equal(report.status, "passed");
  assert.equal(report.checks.length, 6);
  assert.deepEqual(
    report.lifecycle.map((x) => x.kind),
    lifecycleKinds,
  );
  assert.deepEqual(
    report.lifecycle.map((x) => x.evidence.platform_absence_probes),
    [2, 0, 1, 2, 0],
  );
  assert.equal(report.lifecycle[3].missingSourceGeneration, 2);
  assert.equal(report.source_absence_404, 1);
  assert.equal(report.publication.length, 3);
  const calls = f.dockerCalls();
  assert.deepEqual(
    calls.find((a) => a[0] === "stop"),
    ["stop", "-t", "10", "1".repeat(64)],
  );
  assert.deepEqual(
    calls.find((a) => a[0] === "rm"),
    ["rm", "1".repeat(64)],
  );
  const paths = f.requests.map((r) => r.url);
  assert(
    paths.findIndex((p) => p.startsWith("/api/traces?")) >
      paths.indexOf(`/api/admin/agents/${f.temporaryId}/delete`),
  );
});

for (const [name, mutate] of [
  [
    "invalid start time",
    (f) => (f.snapshots.restart.State.StartedAt = "invalid"),
  ],
  [
    "missing scope",
    (f) =>
      delete f.snapshots.compose.services["runtime-controller"].environment
        .ANTNEST_RUNTIME_CONTROLLER_SCOPE,
  ],
  [
    "foreign project",
    (f) =>
      (f.snapshots.restart.Config.Labels["com.docker.compose.project"] =
        "foreign"),
  ],
  [
    "wrong service",
    (f) =>
      (f.snapshots.restart.Config.Labels["com.docker.compose.service"] =
        "agent-controller"),
  ],
  [
    "wrong Controller scope",
    (f) =>
      (f.snapshots.restart.Config.Env = [
        "ANTNEST_RUNTIME_CONTROLLER_SCOPE=foreign",
      ]),
  ],
  [
    "duplicate Controller scope",
    (f) =>
      f.snapshots.restart.Config.Env.push(...f.snapshots.restart.Config.Env),
  ],
  ["malformed restart ID", (f) => (f.snapshots.restart.Id = "short")],
  ["wrong Controller name", (f) => (f.snapshots.restart.Name = "/foreign")],
  [
    "workspace traversal",
    (f) => (f.config.workspaceFile = "/workspace/../bad"),
  ],
  [
    "workspace cache",
    (f) => (f.config.workspaceFile = "/workspace/.cache/bad"),
  ],
  ["missing credentials", (f) => writeFileSync(f.config.envFile, "")],
])
  test(`runtime loss rejects ${name} before HTTP or Docker`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.dockerCalls(), []);
  });

for (const name of [
  "temporary-agent.json",
  "lifecycle-progress.json",
  "lifecycle-report.json",
  ...lifecycleKinds.map((k) => `lifecycle-${k}.json`),
  "publication-" + "a".repeat(32) + ".json",
])
  test(`runtime loss rejects cached ${name} before effects`, async (t) => {
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
    assert(!existsSync(join(f.root, ".cache/missing.json")));
  });

for (const [name, mutate, error] of [
  [
    "foreign Runtime",
    (f) => (f.inspection.Config.Labels["io.antnest.agent-id"] = "foreign"),
    /Runtime Agent/,
  ],
  [
    "readonly workspace",
    (f) => (f.inspection.Mounts[0].RW = false),
    /writable/,
  ],
  [
    "shadow workspace",
    (f) => (f.inspection.HostConfig = { Tmpfs: { "/workspace/x": "" } }),
    /nested mounts/,
  ],
  [
    "foreign workspace",
    (f) => (f.inspection.Mounts[0].Name = "foreign"),
    /volume mismatch/,
  ],
])
  test(`runtime loss rejects ${name} before marker or stop`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.match(f.read("lifecycle-report.json").failure.message, error);
    assert(!f.dockerCalls().some((a) => ["exec", "stop", "rm"].includes(a[0])));
  });

test("runtime loss never assigns retained Agent as cleanup target", async (t) => {
  const f = await fixture(t);
  f.createdId = f.retainedId;
  const result = await f.run();
  assert.notEqual(result.exit_code, 0);
  assert(
    !f.requests.some(
      (r) => r.url === `/api/admin/agents/${f.retainedId}/delete`,
    ),
  );
});

for (const [name, mutate, error] of [
  [
    "nonzero stop",
    (f) => (f.stopped = { Running: false, ExitCode: 137, OOMKilled: false }),
    /Expected values/,
  ],
  [
    "OOM stop",
    (f) => (f.stopped = { Running: false, ExitCode: 0, OOMKilled: true }),
    /Expected values/,
  ],
  [
    "wrong generation",
    (f) => (f.inspection.Config.Labels["io.antnest.runtime-generation"] = "3"),
    /Expected values/,
  ],
  [
    "foreign App state",
    (f) => (f.appState = { agent_id: "foreign" }),
    /App state identity mismatch/,
  ],
  [
    "online app",
    (f) => (f.appState = { availability: "online" }),
    /Expected values/,
  ],
  [
    "foreign Agent reply",
    (f) => (f.agentResponse = (row) => ({ ...row, agent_id: "foreign" })),
    /identity mismatch/,
  ],
  [
    "duplicate lifecycle trace",
    (f) =>
      (f.lifecycles.disable.expected.traceID =
        f.lifecycles.create.expected.traceID),
    /distinct lifecycle/,
  ],
  [
    "duplicate lifecycle request",
    (f) =>
      (f.lifecycles.disable.expected.requestId =
        f.lifecycles.create.expected.requestId),
    /distinct lifecycle/,
  ],
  [
    "duplicate publication",
    (f) => (f.publications[1] = f.publications[0]),
    /distinct publication/,
  ],
  [
    "publication collides with lifecycle",
    (f) => {
      const old = f.publications[0].traceID,
        id = f.lifecycles.create.expected.traceID;
      f.publications[0] = JSON.parse(
        JSON.stringify(f.publications[0]).replaceAll(old, id),
      );
    },
    /distinct publication/,
  ],
  [
    "old collected publication",
    (f) =>
      (f.traceResponse = (trace) => {
        const copy = structuredClone(trace);
        if (
          copy.spans[0].operationName ===
          "agent_controller.execution_publication"
        )
          copy.spans[0].startTime = 999;
        return copy;
      }),
    /cutoff/,
  ],
])
  test(`runtime loss rejects ${name}`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(result.complete, true);
    assert.match(f.read("lifecycle-report.json").failure.message, error);
  });

test("runtime loss polls until three post-restart publication roots exist", async (t) => {
  const f = await fixture(t);
  let searches = 0;
  f.searchResponse = () =>
    ++searches < 3
      ? f.publications.map((t) => {
          const c = structuredClone(t);
          c.spans[0].startTime = 999;
          return c;
        })
      : f.publications;
  const result = await f.run();
  assert.equal(result.exit_code, 0, result.log);
  assert.equal(searches, 3);
});
