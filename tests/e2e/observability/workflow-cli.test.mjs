import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { workflowObservationFixture } from "./workflow-observation-fixtures.mjs";
import { lifecyclePlans } from "./lifecycle-workflow.mjs";
import { setTag } from "./gateway-resolution-fixtures.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const canary = "private-observation-error-canary";
function launch(
  t,
  entry,
  {
    kind = "create",
    source = "cache",
    mutate,
    omit,
    capture = true,
    ttl = "10000",
  } = {},
) {
  const f = workflowObservationFixture(kind, source);
  mutate?.(f);
  const temp = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-workflow-cli-"),
  );
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const document = join(temp, "responses.json"),
    directory = join(temp, "raw");
  writeFileSync(document, JSON.stringify(Object.fromEntries(f.traces)), {
    mode: 0o600,
  });
  const preload = `import fs from 'node:fs';import timers from 'node:timers/promises';import {syncBuiltinESMExports} from 'node:module';
    const traces=JSON.parse(fs.readFileSync(${JSON.stringify(document)},'utf8'));
    timers.setTimeout=async(ms)=>{console.log('WAIT:'+ms);};syncBuiltinESMExports();
    globalThis.fetch=async(url)=>{const id=new URL(url).pathname.split('/').at(-1);console.log('QUERY:'+id);return Response.json({data:[traces[id]]});};`;
  const args = [
    "--import",
    `data:text/javascript,${encodeURIComponent(preload)}`,
    "--",
    `tests/e2e/observability/check-${entry}.mjs`,
    "--request",
    f.requestID,
  ];
  if (entry === "create-workflow") args.push("--trace", f.trace.traceID);
  else
    args.push(
      "--admission",
      f.trace.traceID,
      "--agent",
      f.agentID,
      "--kind",
      kind,
    );
  if (omit !== "directory")
    args.push("--resolve-evidence-directory", directory);
  if (omit !== "ttl") args.push("--resolve-ttl-ms", ttl);
  if (omit !== "capture")
    args.push(capture ? "--capture-rpc-content" : "--no-capture-rpc-content");
  const result = spawnSync(process.execPath, args, {
    cwd: root,
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
    report: lines
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .at(-1),
  };
}

for (const source of ["rpc", "cache", "shared", "shared-background"])
  test(`offline create CLI uses actual ${source} provenance and its existing workflow inspector`, (t) => {
    const result = launch(t, "create-workflow", { source });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.report.gateway_resolution.source,
      source.startsWith("shared") ? "shared" : source,
    );
    assert.deepEqual(
      result.report.activities.slice(1).map((phase) => phase.name),
      lifecyclePlans.create,
    );
    assert.equal(result.queries.length, result.f.traces.size * 3);
    assert.deepEqual(result.waits, ["WAIT:6000", "WAIT:1000", "WAIT:1000"]);
  });

for (const kind of Object.keys(lifecyclePlans))
  test(`offline lifecycle CLI retains ${kind} closeout and explicit capture`, (t) => {
    const result = launch(t, "lifecycle", {
      kind,
      capture: kind !== "disable",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.report.phases, lifecyclePlans[kind]);
    assert.equal(result.report.admission_trace, result.f.trace.traceID);
    assert.equal(result.report.gateway_resolution.profile, "console");
    assert.equal(result.queries.length, 3);
    assert.equal(result.report.traces[0].trace_id, result.f.trace.traceID);
  });

for (const entry of ["create-workflow", "lifecycle"]) {
  test(`${entry} keeps successful full RPC payloads private and complete`, (t) => {
    const payload = {
      credentials: { password: "successful-rpc-credential-canary" },
      newField: { nested: "successful-rpc-nested-canary" + "x".repeat(24000) },
    };
    const result = launch(t, entry, {
      source: "shared",
      mutate: (f) => {
        const receiver = f.traces
          .get("b".repeat(32))
          .spans.find((s) =>
            s.logs?.some((log) =>
              log.fields?.some((field) => field.key === "antnest.payload.json"),
            ),
          );
        const field = receiver.logs[0].fields.find(
          (field) => field.key === "antnest.payload.json",
        );
        field.value = JSON.stringify(payload);
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert(
      !result.stdout.includes(payload.credentials.password) &&
        !result.stderr.includes(payload.credentials.password),
    );
    assert(
      !result.stdout.includes("successful-rpc-nested-canary") &&
        !result.stderr.includes("successful-rpc-nested-canary"),
    );
    const run = readdirSync(result.directory)[0];
    for (const sample of [1, 2, 3]) {
      const raw = JSON.parse(
        readFileSync(
          join(
            result.directory,
            run,
            `sample-${sample}`,
            `${"b".repeat(32)}.json`,
          ),
          "utf8",
        ),
      );
      assert(
        raw.spans.some((span) =>
          span.logs?.some((log) =>
            log.fields?.some(
              (field) =>
                field.key === "antnest.payload.json" &&
                field.value === JSON.stringify(payload),
            ),
          ),
        ),
      );
    }
  });

  for (const omit of ["directory", "ttl", "capture"])
    test(`${entry} requires explicit ${omit} before a query`, (t) => {
      const result = launch(t, entry, { omit });
      assert.notEqual(result.status, 0);
      assert.deepEqual(result.queries, []);
      assert.deepEqual(result.waits, []);
      assert.doesNotMatch(result.stderr, /Unknown option/u);
    });

  test(`${entry} checks observed cache budgets against declared TTL`, (t) => {
    const result = launch(t, entry, { ttl: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(result.queries.length, 1);
    assert.match(result.stderr, /observation failed/u);
  });

  test(`${entry} retains default rejection of duplicate workflow activities`, (t) => {
    const result = launch(t, entry, {
      mutate: (f) => {
        const activity = structuredClone(
          f.trace.spans.find((s) => s.spanID === "publish"),
        );
        activity.spanID = "duplicate-publish";
        f.trace.spans.push(activity);
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.queries.length, 1);
  });

  test(`${entry} returns nonzero strict diagnostics without printing raw error metadata`, (t) => {
    const result = launch(t, entry, {
      mutate: (f) =>
        setTag(
          f.trace.spans.find((s) => s.spanID === "sql-publish"),
          "antnest.error.code",
          canary,
        ),
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.report.strict_trace, "failed");
    assert.equal(result.report.error_spans, 1);
    assert(!result.stdout.includes(canary) && !result.stderr.includes(canary));
    const run = readdirSync(result.directory)[0];
    assert(
      readFileSync(
        join(
          result.directory,
          run,
          "sample-3",
          `${result.f.trace.traceID}.json`,
        ),
        "utf8",
      ).includes(canary),
    );
  });

  test(`${entry} source warnings retain raw evidence and only a generic failure`, (t) => {
    const result = launch(t, entry, {
      source: "shared",
      mutate: (f) => {
        f.traces.get("b".repeat(32)).warnings = [canary];
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /observation failed/u);
    assert(!result.stdout.includes(canary) && !result.stderr.includes(canary));
    const run = readdirSync(result.directory)[0];
    assert(
      readFileSync(
        join(result.directory, run, "sample-1", `${"b".repeat(32)}.json`),
        "utf8",
      ).includes(canary),
    );
  });
}
