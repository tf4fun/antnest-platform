import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entry = (name) => join(root, "tests/support", name);
const traceID = "a".repeat(32);
const json = (path, value) => writeFileSync(path, JSON.stringify(value));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-offline-evidence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  mkdirSync(output);
  return { directory, output, config: join(directory, "config.json") };
}
function node(args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, ...env },
  });
}
const capturePreload = `
  import timers from 'node:timers/promises';
  import {syncBuiltinESMExports} from 'node:module';
  timers.setTimeout = async (ms) => console.log(JSON.stringify({wait:ms}));
  syncBuiltinESMExports();
  AbortSignal.timeout = (ms) => ({timeout:ms});
  globalThis.fetch = async (url, options) => {
    console.log(JSON.stringify({url, timeout:options.signal.timeout}));
    return {text:async () => 'saved raw response'};
  };
`;
function capture(config) {
  return node([
    "--import",
    `data:text/javascript,${encodeURIComponent(capturePreload)}`,
    entry("diagnostics/capture-http-failure-traces.mjs"),
    "--config",
    config,
  ]);
}

test("HTTP observer preserves selection, query removal, causes and private output", (t) => {
  const f = fixture(t);
  json(f.config, {
    output: f.output,
    originPrefix: "http://127.0.0.1:",
    pathPrefix: "/api/",
  });
  const result = node(
    [
      "--import",
      entry("diagnostics/http-errors.mjs"),
      "--input-type=module",
      "--eval",
      `import {channel} from 'node:diagnostics_channel';
     const c=channel('undici:request:error');
     const error={name:'Error',code:'OUTER',message:'outer',cause:{name:'Error',code:'INNER',message:'inner'}};
     for(const [origin,path] of [['http://127.0.0.1:1234','/api/runs?private=secret'],['http://other:1234','/api/runs'],['http://127.0.0.1:1234','/health']])
       c.publish({request:{origin,path,method:'GET'},error});
     c.publish({});`,
    ],
    { ANTNEST_HTTP_DIAGNOSTICS_CONFIG: f.config },
  );
  assert.equal(result.status, 0, result.stderr);
  const file = join(f.output, "http-errors.private.jsonl");
  const rows = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "/api/runs");
  assert.equal(rows[0].method, "GET");
  assert.equal(rows[0].error.cause.code, "INNER");
  assert(!readFileSync(file, "utf8").includes("secret"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("HTTP observer rejects a cached output-file alias before subscribing", (t) => {
  const f = fixture(t);
  symlinkSync(
    join(root, ".cache"),
    join(f.output, "http-errors.private.jsonl"),
  );
  json(f.config, {
    output: f.output,
    originPrefix: "http://127.0.0.1:",
    pathPrefix: "/api/",
  });
  const result = node(
    ["--import", entry("diagnostics/http-errors.mjs"), "--eval", ""],
    {
      ANTNEST_HTTP_DIAGNOSTICS_CONFIG: f.config,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cache alias/);
});

test("HTTP diagnostics reject a missing output directory instead of dropping evidence", (t) => {
  const f = fixture(t);
  const output = join(f.directory, "absent");
  json(f.config, {
    output,
    originPrefix: "http://127.0.0.1:",
    pathPrefix: "/api/",
  });
  const observer = node(
    ["--import", entry("diagnostics/http-errors.mjs"), "--eval", ""],
    {
      ANTNEST_HTTP_DIAGNOSTICS_CONFIG: f.config,
    },
  );
  assert.notEqual(observer.status, 0);
  const inputLog = join(f.directory, "input.log");
  json(inputLog, { status_code: 500, trace_id: traceID });
  json(f.config, { output, inputLog, jaeger: "http://127.0.0.1:16686" });
  const collected = capture(f.config);
  assert.notEqual(collected.status, 0);
  assert.equal(collected.stdout, "");
});

test("failure capture deduplicates only HTTP 500 trace IDs and retains wait and request deadline", (t) => {
  const f = fixture(t);
  const inputLog = join(f.directory, "input.log");
  const row = JSON.stringify({ status_code: 500, trace_id: traceID });
  writeFileSync(
    inputLog,
    [
      "prefix " + row,
      row,
      '{"status_code":500,"trace_id":"invalid"}',
      JSON.stringify({ status_code: 404, trace_id: "b".repeat(32) }),
      "non JSON",
    ].join("\n"),
  );
  json(f.config, {
    output: f.output,
    inputLog,
    jaeger: "http://127.0.0.1:16686",
  });
  const result = capture(f.config);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").map(JSON.parse), [
    { wait: 6000 },
    { url: `http://127.0.0.1:16686/api/traces/${traceID}`, timeout: 5000 },
  ]);
  const file = join(f.output, `identity-failure-${traceID}.private.json`);
  assert.equal(readFileSync(file, "utf8"), "saved raw response");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("failure capture validates its Jaeger endpoint before waiting or fetching", (t) => {
  const f = fixture(t);
  const inputLog = join(f.directory, "input.log");
  json(inputLog, { status_code: 500, trace_id: traceID });
  for (const jaeger of [
    undefined,
    "ftp://localhost",
    "http://user:password@localhost",
    "http://localhost/?token=secret",
  ]) {
    json(f.config, { output: f.output, inputLog, jaeger });
    const result = capture(f.config);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /jaeger/i);
    assert.equal(result.stdout, "");
  }
});

test("failure capture rejects an individual output alias before its request", (t) => {
  const f = fixture(t);
  const inputLog = join(f.directory, "input.log");
  json(inputLog, { status_code: 500, trace_id: traceID });
  symlinkSync(
    join(root, ".cache"),
    join(f.output, `identity-failure-${traceID}.private.json`),
  );
  json(f.config, {
    output: f.output,
    inputLog,
    jaeger: "http://127.0.0.1:16686",
  });
  const result = capture(f.config);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cache alias/);
  assert(!result.stdout.includes('"url"'));
});

function auditFixture(t) {
  const f = fixture(t);
  const project = "antnest-lifecycle-1234abcd";
  const evidenceRoot = join(f.directory, "evidence");
  const scenario = join(evidenceRoot, project);
  mkdirSync(join(scenario, "traces"), { recursive: true });
  const log = join(f.directory, "run.log");
  writeFileSync(log, `Disposable foundation project: ${project}\n`);
  const business = {
    traces: [{ trace_id: traceID, topology: "passed", strict_trace: "failed" }],
  };
  json(join(scenario, "business.json"), business);
  const trace = {
    traceID,
    spans: [
      {
        spanID: "1",
        traceID,
        processID: "p",
        operationName: "GET",
        tags: [],
        references: [],
      },
    ],
    processes: { p: { serviceName: "edge-gateway" } },
  };
  json(join(scenario, "traces", `${traceID}.json`), trace);
  const config = {
    output: f.output,
    profiles: [
      {
        profile: "foundation",
        expectedTraceCount: 1,
        log,
        evidenceRoot,
        projectPattern:
          "Disposable foundation project: (antnest-lifecycle-[a-f0-9]{8})",
      },
    ],
  };
  json(f.config, config);
  return { ...f, project, scenario, business, trace, configuration: config };
}
const audit = (f) =>
  node([
    entry("verification/audit-lifecycle-evidence.mjs"),
    "--config",
    f.config,
  ]);

test("lifecycle audit retains strict failures and rejects missing parents or Runtime errors", (t) => {
  const f = auditFixture(t);
  const result = audit(f);
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(readFileSync(join(f.output, "trace-audit.json")));
  assert.equal(rows[0].strict_failed, 1);
  f.trace.spans[0].references = [
    { refType: "CHILD_OF", traceID, spanID: "missing" },
  ];
  json(join(f.scenario, "traces", `${traceID}.json`), f.trace);
  assert.match(audit(f).stderr, /missing synchronous parent/);
  f.trace.spans[0].references = [];
  f.trace.spans[0].tags = [{ key: "error", value: true }];
  f.trace.processes.p.serviceName = "runtime-controller";
  json(join(f.scenario, "traces", `${traceID}.json`), f.trace);
  assert.notEqual(audit(f).status, 0);
});

test("lifecycle audit rejects empty profiles and cached report aliases", (t) => {
  const f = auditFixture(t);
  for (const profiles of [
    [],
    undefined,
    [{ ...f.configuration.profiles[0], profile: "interupted" }],
    [{ ...f.configuration.profiles[0], expectedTraceCount: 0 }],
  ]) {
    json(f.config, { output: f.output, profiles });
    assert.notEqual(audit(f).status, 0);
  }
  json(f.config, f.configuration);
  symlinkSync(join(root, ".cache"), join(f.output, "trace-audit.json"));
  const result = audit(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cache alias/);
});

test("interrupted audit preserves revision, receipts, recovery identity and error count assertions", (t) => {
  const f = auditFixture(t);
  Object.assign(f.configuration.profiles[0], {
    profile: "interrupted",
    expectedTargetTemplateRevision: 2,
    expectedErrors: 1,
  });
  json(f.config, f.configuration);
  f.business.target_template_revision = 2;
  json(join(f.scenario, "business.json"), f.business);
  f.trace.spans[0].tags = [{ key: "error", value: true }];
  json(join(f.scenario, "traces", `${traceID}.json`), f.trace);
  const checkpoint = {
    checkpoint: { rc: { request_id: "same" } },
    recovered: { rc: { request_id: "same" } },
    receipts: {
      records: [{ delivery: "caller_disconnected" }, { delivery: "delivered" }],
    },
  };
  json(join(f.scenario, "checkpoint.private.json"), checkpoint);
  assert.equal(audit(f).status, 0);
  for (const bad of [
    { ...checkpoint, recovered: { rc: { request_id: "different" } } },
    {
      ...checkpoint,
      receipts: {
        records: [
          { delivery: "delivered" },
          { delivery: "caller_disconnected" },
        ],
      },
    },
  ]) {
    json(join(f.scenario, "checkpoint.private.json"), bad);
    assert.notEqual(audit(f).status, 0);
  }
  json(join(f.scenario, "checkpoint.private.json"), checkpoint);
  f.business.target_template_revision = 3;
  json(join(f.scenario, "business.json"), f.business);
  assert.notEqual(audit(f).status, 0);
  f.business.target_template_revision = 2;
  json(join(f.scenario, "business.json"), f.business);
  f.configuration.profiles[0].expectedErrors = 2;
  json(f.config, f.configuration);
  assert.notEqual(audit(f).status, 0);
});

test("crash replay rejects symlinked evidence files inside its durable input directory", (t) => {
  const f = fixture(t);
  symlinkSync(join(root, ".cache"), join(f.directory, "business.json"));
  const result = node([
    entry("verification/recheck-crash-traces.mjs"),
    "--input",
    f.directory,
    "--output",
    join(f.output, "result.json"),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cache alias/);
  assert(!existsSync(join(f.output, "result.json")));
});

test("crash replay also checks derived proof and raw-trace file aliases", (t) => {
  for (const leaf of [
    "before-create.recovered.private.json",
    `traces/${traceID}.json`,
  ]) {
    const f = fixture(t);
    mkdirSync(join(f.directory, "traces"));
    json(join(f.directory, "business.json"), {
      traces: [{ request_id: "request", trace_id: traceID, agent_id: "agent" }],
    });
    if (leaf.startsWith("traces/"))
      json(join(f.directory, "before-create.recovered.private.json"), {
        checkpoint: { ac: { request_id: "request" } },
      });
    symlinkSync(join(root, ".cache"), join(f.directory, leaf));
    const result = node([
      entry("verification/recheck-crash-traces.mjs"),
      "--input",
      f.directory,
      "--output",
      join(f.output, "result.json"),
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cache alias/);
  }
});

test("Markdown checker preserves local link checks and rejects cached document inputs", (t) => {
  const f = fixture(t);
  const file = join(f.directory, "README.md");
  writeFileSync(join(f.directory, "target file.md"), "target");
  writeFileSync(
    file,
    "[target](target%20file.md#anchor) [web](https://example.org) [mail](mailto:user@example.org) [self](#anchor)",
  );
  const python = (args) =>
    spawnSync(
      "python3",
      ["-B", entry("verification/check-links.py"), ...args],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
  const result = python([file]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /'local_links_checked': 1/);
  writeFileSync(file, "[missing](absent.md)");
  assert.notEqual(python([file]).status, 0);
  const invalid = python([join(root, ".cache", "forbidden.md")]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /durable files must not use/);
});
