import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { workflowObservationFixture } from "./workflow-observation-fixtures.mjs";
import {
  fixture as readinessFixture,
  creationFixture,
} from "./runtime-readiness-fixtures.mjs";
import { lifecyclePlans } from "./lifecycle-workflow.mjs";
import { setTag } from "./gateway-resolution-fixtures.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const agentID = "agent_" + "1".repeat(32);
const readyID = "d".repeat(32);
const canary = "private-live-workflow-canary";

function launch(
  t,
  entry,
  {
    kind = "create",
    source = "cache",
    existing = false,
    omitDirectory = false,
    omitHistorical,
    mutate,
    ttl = "10s",
    capture = "true",
    historicalTTL = "10000",
    envTTL,
  } = {},
) {
  const original = workflowObservationFixture(kind, source);
  const f = {
    ...original,
    traces: new Map(
      JSON.parse(
        JSON.stringify([...original.traces]).replaceAll("agent-test", agentID),
      ),
    ),
  };
  f.trace = f.traces.get(original.trace.traceID);
  const current = JSON.parse(
    JSON.stringify(creationFixture())
      .replaceAll("agent-test", agentID)
      .replaceAll("b".repeat(32), readyID),
  );
  current.agent.desired_state = "enabled";
  if (kind === "disable")
    Object.assign(current.agent, {
      activation_state: "disabled",
      desired_state: "disabled",
      readiness: "unavailable",
      executable_execution_revision: null,
    });
  if (kind === "delete")
    current.agent = {
      agent_id: agentID,
      lifecycle_state: "deleted",
      desired_state: "deleted",
      runtime_state: "absent",
      readiness: "unavailable",
    };
  const readiness = JSON.parse(
    JSON.stringify(readinessFixture().trace)
      .replaceAll("agent-test", agentID)
      .replaceAll("b".repeat(32), readyID),
  );
  const binding = [
    {
      agent_id: agentID,
      request_id: original.requestID,
      creation_trace_id: f.trace.traceID,
      readiness_trace_id: readyID,
      execution_revision: "execution-test",
      runtime_revision: "runtime-test",
      runtime_execution_id: "process-test",
      mcp_endpoint: "http://runtime:8093/mcp",
      binding_coherent: true,
      creation_unbound: true,
      execution_count: 1,
    },
  ];
  const response = {
    traces: Object.fromEntries(f.traces),
    readiness,
    current,
    binding,
    agentID,
    requestID: original.requestID,
    traceID: f.trace.traceID,
    kind,
  };
  mutate?.(response, f);
  const temp = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-live-observation-"),
  );
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const directory = join(temp, "raw"),
    document = join(temp, "responses.json"),
    envFile = join(temp, "settings.env");
  writeFileSync(document, JSON.stringify(response), { mode: 0o600 });
  writeFileSync(
    envFile,
    `ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=local\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=admin@example.test\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=${canary}\nANTNEST_EDGE_RESOLVE_CACHE_TTL=${ttl}\nANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=${capture}\n`,
    { mode: 0o600 },
  );
  const preload = `import assert from 'node:assert/strict';import fs from 'node:fs';import timers from 'node:timers/promises';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    const f=JSON.parse(fs.readFileSync(${JSON.stringify(document)},'utf8'));
    timers.setTimeout=async(ms)=>{console.log('WAIT:'+ms);};
    childProcess.execFileSync=(command,args,options)=>{assert.equal(command,'docker');assert.deepEqual(args.slice(0,5),['exec','-i','acceptance-postgres','psql','-U']);assert(args.includes('agent_id='+f.agentID));assert.equal(options.timeout,15000);assert(options.input.includes('creation_unbound'));console.log('BINDING');return JSON.stringify(f.binding);};
    syncBuiltinESMExports();
    let admitted;let writes=0;let eventReads=0;
    globalThis.fetch=async(input,options={})=>{
      const url=new URL(input);const method=options.method??'GET';
      if(url.pathname.startsWith('/api/traces/')) {const id=url.pathname.split('/').at(-1);console.log('QUERY:'+id);return Response.json({data:[id===f.readiness.traceID?f.readiness:f.traces[id]]});}
      console.log('HTTP:'+method+' '+url.pathname);
      if(url.pathname==='/api/session/login') return Response.json({principal:{user_id:'admin-test'}},{headers:{'Set-Cookie':'antnest_session=test; Path=/; HttpOnly'}});
      if(url.pathname==='/api/admin/agents'&&method==='POST'||url.pathname.endsWith('/'+f.kind)&&method==='POST') {
        const key=options.headers['Idempotency-Key'];assert(key);const body=JSON.parse(options.body);
        if(!admitted) admitted={key,body};else assert.deepEqual({key,body},admitted);
        writes++;return Response.json({agent:{agent_id:f.agentID},operation:{...f.current.operation,request_id:f.replayRequest&&writes>1?'wrong-request':f.requestID}},{status:202,headers:{'x-antnest-trace-id':f.traceID}});
      }
      if(url.pathname==='/api/admin/operations/'+f.requestID) return Response.json(f.current.operation);
      if(url.pathname==='/api/admin/agents/'+f.agentID) return Response.json(f.current.agent);
      if(url.pathname==='/api/admin/agents/'+f.agentID+'/events') {eventReads++;return Response.json({events:f.replayEvents&&eventReads>1?[...f.current.events,f.current.events[0]]:f.current.events});}
      throw new Error('unexpected test HTTP');
    };`;
  const args = [
    "--import",
    `data:text/javascript,${encodeURIComponent(preload)}`,
    "--",
    `tests/e2e/observability/exercise-${entry}.mjs`,
    "--confirm-development",
    "--env-file",
    envFile,
  ];
  if (!omitDirectory) args.push("--resolve-evidence-directory", directory);
  if (entry === "lifecycles") {
    args.push("--kind", kind);
    if (kind !== "create") args.push("--agent", agentID);
    if (["create", "rebuild"].includes(kind))
      args.push("--template", "template-test", "--revision", "1");
  } else {
    args.push(
      "--retain-for-review",
      "--postgres-container",
      "acceptance-postgres",
    );
    if (existing) {
      args.push(
        "--agent",
        agentID,
        "--request",
        original.requestID,
        "--trace",
        f.trace.traceID,
      );
      if (omitHistorical !== "ttl")
        args.push("--resolve-ttl-ms", historicalTTL);
      if (omitHistorical !== "capture") args.push("--capture-rpc-content");
    } else args.push("--template", "template-test", "--revision", "1");
  }
  const environment = { ...process.env };
  delete environment.ANTNEST_EDGE_RESOLVE_CACHE_TTL;
  delete environment.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT;
  if (envTTL !== undefined) environment.ANTNEST_EDGE_RESOLVE_CACHE_TTL = envTTL;
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  const lines = result.stdout.trim().split("\n");
  return {
    ...result,
    f,
    directory,
    queries: lines.filter((line) => line.startsWith("QUERY:")),
    waits: lines.filter((line) => line.startsWith("WAIT:")),
    calls: lines.filter((line) => line.startsWith("HTTP:")),
    binding: lines.filter((line) => line === "BINDING").length,
    report: lines
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .at(-1),
  };
}

for (const entry of ["lifecycles", "creation-observation"]) {
  for (const source of ["rpc", "cache", "shared", "shared-background"])
    test(`${entry} preserves business acceptance with actual ${source} Resolve closure`, (t) => {
      const result = launch(t, entry, { source });
      assert.equal(result.status, 0, result.stderr);
      const created =
        entry === "lifecycles" ? result.report : result.report.creation;
      assert.equal(
        created.gateway_resolution.source,
        source.startsWith("shared") ? "shared" : source,
      );
      assert.deepEqual(
        created.activities.slice(1).map((item) => item.name),
        lifecyclePlans.create,
      );
      assert.equal(result.report.replay_verified, true);
      assert.equal(result.report.state, "verified");
      assert.equal(
        result.queries.length,
        result.f.traces.size * 3 + (entry === "creation-observation" ? 1 : 0),
      );
      assert.deepEqual(result.waits, ["WAIT:6000", "WAIT:1000", "WAIT:1000"]);
      if (entry === "creation-observation") {
        assert.equal(result.binding, 1);
        assert.equal(result.report.readiness.trace_id, readyID);
        assert.equal(result.report.persisted_binding.creation_unbound, true);
        assert.equal(result.report.retained_for_review, true);
      }
    });
  test(`${entry} requires durable evidence before login`, (t) => {
    const result = launch(t, entry, { omitDirectory: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resolve-evidence-directory/u);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.queries, []);
  });
  test(`${entry} checks the effective deployment TTL`, (t) => {
    const result = launch(t, entry, { envTTL: "1ms" });
    assert.notEqual(result.status, 0);
    assert.equal(result.queries.length, 1);
    assert.match(result.stderr, /observation failed/u);
  });
  test(`${entry} source warnings are archived and stop before success`, (t) => {
    const result = launch(t, entry, {
      source: "shared",
      mutate: (r) => {
        r.traces["b".repeat(32)].warnings = [canary];
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /observation failed/u);
    assert.notEqual(result.report?.state, "verified");
    assert(!result.stdout.includes(canary) && !result.stderr.includes(canary));
    const run = readdirSync(result.directory)[0];
    assert(
      readFileSync(
        join(result.directory, run, "sample-1", `${"b".repeat(32)}.json`),
        "utf8",
      ).includes(canary),
    );
  });
  test(`${entry} strict business errors remain a failed process`, (t) => {
    const result = launch(t, entry, {
      mutate: (r, f) =>
        setTag(
          f.trace.spans.find((s) => s.spanID === "sql-publish"),
          "antnest.error.code",
          canary,
        ),
    });
    assert.notEqual(result.status, 0);
    assert.notEqual(result.report?.state, "verified");
    const created =
      entry === "lifecycles" ? result.report : result.report.creation;
    assert.equal(created.strict_trace, "failed");
    assert.equal(created.error_spans, 1);
    assert(!result.stdout.includes(canary) && !result.stderr.includes(canary));
  });
  for (const mutation of ["replayRequest", "replayEvents"])
    test(`${entry} keeps ${mutation} rejection before Trace collection`, (t) => {
      const result = launch(t, entry, {
        mutate: (r) => {
          r[mutation] = true;
        },
      });
      assert.notEqual(result.status, 0);
      assert.deepEqual(result.queries, []);
    });
}

for (const kind of ["rebuild", "disable", "enable", "delete"])
  test(`live lifecycle ${kind} retains terminal state and owning phases`, (t) => {
    const result = launch(t, "lifecycles", {
      kind,
      capture: ["disable", "delete"].includes(kind) ? "false" : "true",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.kind, kind);
    assert.deepEqual(
      result.report.activities
        .slice(1)
        .map((item) => item.name.replace("lifecycle.", "")),
      lifecyclePlans[kind],
    );
    assert.equal(result.report.replay_verified, true);
  });

test("existing creation review uses explicit historical config without creating or replaying", (t) => {
  const result = launch(t, "creation-observation", {
    existing: true,
    source: "shared",
    ttl: "0s",
    capture: "false",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.replay_verified, null);
  assert(!result.calls.includes("HTTP:POST /api/admin/agents"));
  assert.equal(result.binding, 1);
});
for (const omitHistorical of ["ttl", "capture"])
  test(`existing creation review requires explicit historical ${omitHistorical} before login`, (t) => {
    const result = launch(t, "creation-observation", {
      existing: true,
      omitHistorical,
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.queries, []);
  });

for (const [name, mutate] of [
  [
    "independent readiness",
    (r) => {
      r.readiness.spans = r.readiness.spans.filter(
        (s) => s.spanID !== "status",
      );
    },
  ],
  [
    "persisted creation binding",
    (r) => {
      r.binding[0].creation_unbound = false;
    },
  ],
])
  test(`creation observation preserves ${name} acceptance`, (t) => {
    const result = launch(t, "creation-observation", { mutate });
    assert.notEqual(result.status, 0);
    assert.notEqual(result.report?.state, "verified");
    assert.match(result.stderr, /observation failed/u);
  });
