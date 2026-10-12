import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as lifecycle from "./acp.mjs";
import { fixture as commandFixture } from "../acp-commands/trace-fixtures.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { inspectManagedTrace } from "../managed-mcp/request-trace.mjs";
import { fixture as resolutionFixture } from "../workspace-closeout/request-resolution-fixtures.mjs";
import { inspectLossDenial } from "./loss-current.mjs";
import { strictSessionEvidence } from "../identity-closeout/session-trace.mjs";
import {
  foundationAcceptedTraceExitCode,
  collectLifecycleEvidence,
} from "./foundation-evidence.mjs";
import {
  sourceID,
  triggerID,
  resolvePrefix as prefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { unreviewedWarnings } from "../../support/strict-findings.mjs";

function fixture(t, source = "shared", kind = "request") {
  const f = resolutionFixture(source);
  const business = commandFixture(kind === "ordinary" ? kind : "request");
  const rejection = kind.startsWith("agent_") ? kind : undefined;
  const method = rejection ? "session/prompt" : business.expected.method;
  f.expected = {
    ...f.expected,
    ...business.expected,
    connectionTraceID: f.expected.connectionTraceID,
    method,
    ...(rejection ? { rejection } : {}),
    ...(kind === "ordinary" ? { runId: "run" } : {}),
  };
  for (const span of [f.root, f.upstream]) {
    span.operationName = `acp ${method}`;
    if (span === f.root) setTag(span, "rpc.method", method);
  }
  Object.assign(f.trace.processes, business.trace.processes);
  f.trace.spans = f.trace.spans.filter((span) => span.spanID !== "request");
  for (const original of business.trace.spans.slice(2)) {
    const span = structuredClone(original);
    span.traceID = f.trace.traceID;
    span.startTime += f.upstream.startTime;
    for (const ref of span.references) {
      ref.traceID = f.trace.traceID;
      if (ref.spanID === "forward") ref.spanID = "upstream";
    }
    if (span.spanID === "request") {
      span.operationName = `acp ${method}`;
      setTag(span, "rpc.method", method);
    }
    f.trace.spans.push(span);
  }
  if (rejection) {
    const request = f.trace.spans.find((span) => span.spanID === "request");
    for (const [key, value] of Object.entries({
      "rpc.response.status_code": -32020,
      "antnest.outcome": "rejected",
      "antnest.error.code": "-32020",
      error: true,
    }))
      setTag(request, key, value);
    const denial = structuredClone(request);
    denial.spanID = "denial";
    denial.operationName = "acp.session.prompt";
    denial.startTime++;
    denial.references[0].spanID = "request";
    denial.tags = request.tags.filter((field) =>
      ["antnest.outcome", "antnest.error.code", "error"].includes(field.key),
    );
    setTag(denial, "antnest.error.code", rejection);
    f.trace.spans.push(denial);
  }
  f.requests = (business.requests ?? []).map((item) => ({
    ...item,
    trace_id: f.trace.traceID,
  }));
  const evidence = mkdtempSync(join(temporaryStorageRoot(), "lifecycle-acp-"));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  f.config = { evidence, jaeger: "http://jaeger" };
  f.directory = join(evidence, "traces");
  f.options = {
    attempts: 4,
    wait: async () => {},
    request: async (url) => {
      const path = new URL(url).pathname;
      return path === "/api/v3/trace-summaries"
        ? Response.json({ summaries: [{ traceId: f.trace.traceID }] })
        : Response.json({ data: [f.traces.get(path.split("/").at(-1))] });
    },
  };
  f.inspections = 0;
  f.inspect = async (trace, expected, secrets, calls) => {
    await Promise.resolve();
    f.inspections++;
    const checked =
      expected.rejection === "agent_unavailable"
        ? inspectLossDenial(trace, expected, secrets)
        : expected.rejection
          ? inspectManagedTrace(trace, expected, secrets, calls)
          : inspectCommandTrace(trace, expected, secrets, calls);
    if (expected.runId)
      assert.equal(
        checked.run_id,
        expected.runId,
        "trace belongs to another Run",
      );
    return strictSessionEvidence(checked, trace);
  };
  return f;
}

const collect = (f) => {
  assert.equal(typeof lifecycle.collectLifecycleACPTrace, "function");
  return lifecycle.collectLifecycleACPTrace(
    f.config,
    f.expected,
    ["PRIVATE"],
    f.requests,
    f.inspect,
    f.signal,
    f.options,
  );
};

for (const source of ["rpc", "cache", "shared"])
  for (const kind of ["request", "ordinary", "agent_busy", "agent_unavailable"])
    test(`Lifecycle ACP ${kind} retains business admission with ${source} provenance`, async (t) => {
      const f = fixture(t, source, kind);
      delete f.expected.traceID;
      const result = await collect(f);
      assert.equal(result.gateway_resolution.profile, "acp");
      assert.equal(result.gateway_resolution.source, source);
      assert.equal(result.gateway_resolution.admission, true);
      assert.equal(f.expected.traceID, f.trace.traceID);
      assert.equal(f.inspections, 3);
      if (kind.startsWith("agent_")) {
        assert.equal(result.rejection, kind);
        assert.equal(result.no_execution, true);
        assert.equal(result.runs, 0);
        assert.equal(result.error_spans, 2);
        assert.equal(result.strict_trace, "failed");
        if (kind === "agent_busy")
          assert.equal(
            foundationAcceptedTraceExitCode([
              { ...result, topology: "passed" },
            ]),
            0,
          );
      } else {
        assert.equal(result.error_spans, 0);
        assert.equal(result.strict_trace, "passed");
        if (kind === "ordinary") assert.equal(result.run_id, "run");
        else assert.equal(result.no_model_or_tools, true);
      }
      for (const [id, trace] of f.traces)
        assert.deepEqual(
          JSON.parse(readFileSync(join(f.directory, `${id}.json`))),
          trace,
        );
    });

for (const [name, mutate, match] of [
  [
    "missing durable Run",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "write");
    },
    /missing durable Run write/u,
  ],
  [
    "different Run",
    (f) => {
      f.expected.runId = "other-run";
    },
    /trace belongs to another Run/u,
  ],
  [
    "wrong model phase",
    (f) => {
      f.requests[1].phase = "other-phase";
    },
    /falsy/u,
  ],
  [
    "duplicate model span",
    (f) => {
      f.requests[1].model_span_id = f.requests[0].model_span_id;
    },
    /1 !== 2/u,
  ],
])
  test(`Lifecycle ACP preserves owning rejection for ${name}`, async (t) => {
    const f = fixture(t, "shared", "ordinary");
    mutate(f);
    delete f.expected.traceID;
    await assert.rejects(collect(f), match);
    assert.equal(f.expected.traceID, f.trace.traceID);
    for (const [id, trace] of f.traces)
      assert.deepEqual(
        JSON.parse(readFileSync(join(f.directory, `${id}.json`))),
        trace,
      );
  });

test("Lifecycle ACP binds model evidence to the selected request Trace", async (t) => {
  const f = fixture(t, "shared", "ordinary");
  f.requests.push(
    ...f.requests.map((item) => ({ ...item, trace_id: "f".repeat(32) })),
  );
  assert.equal((await collect(f)).run_id, "run");
});

for (const kind of ["agent_busy", "agent_unavailable"])
  test(`Lifecycle ACP ${kind} still forbids execution`, async (t) => {
    const f = fixture(t, "cache", kind);
    const hidden = structuredClone(f.trace.spans.at(-1));
    hidden.spanID = "hidden";
    hidden.operationName = "model.complete";
    hidden.tags = [];
    delete hidden.logs;
    f.trace.spans.push(hidden);
    await assert.rejects(collect(f));
  });

test("Lifecycle ACP fixes owning inspection, selection, evidence directory and signal", async (t) => {
  const f = fixture(t, "shared", "ordinary");
  let overridden = false;
  Object.assign(f.options, {
    directory: join(f.config.evidence, "wrong-directory"),
    signal: AbortSignal.abort(new Error("unrelated abort")),
    onSelected: () => {
      overridden = true;
    },
    inspect: () => {
      overridden = true;
      return {};
    },
  });
  delete f.expected.traceID;
  const result = await collect(f);
  assert.equal(overridden, false);
  assert.equal(f.inspections, 3);
  assert.equal(result.run_id, "run");
  assert.equal(f.expected.traceID, f.trace.traceID);
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.directory, `${sourceID}.json`))),
    f.traces.get(sourceID),
  );
});

test("Lifecycle ACP records actual Trace and complete archives before source admission fails", async (t) => {
  const f = fixture(t);
  delete f.expected.traceID;
  setTag(
    f.traces.get(sourceID).spans.find((s) => s.spanID === "sql"),
    "error",
    true,
  );
  const failures = [];
  const results = await collectLifecycleEvidence(
    [f.expected],
    () => collect(f),
    (expected, error) => {
      failures.push({ id: expected.traceID, error: error.message });
    },
  );
  assert.equal(f.inspections, 0);
  assert.deepEqual(failures, [
    { id: f.trace.traceID, error: "failed actual Resolve RPC or SQL" },
  ]);
  assert.equal(results[0].topology, "failed");
  assert.equal(results[0].trace_id, f.trace.traceID);
  for (const [id, trace] of f.traces)
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.directory, `${id}.json`))),
      trace,
    );
});

test("Lifecycle busy allowance cannot absorb trigger errors or unknown source warnings", async (t) => {
  const f = fixture(t, "shared", "agent_busy");
  const trigger = f.traces.get(triggerID);
  setTag(trigger.spans[0], "error", true);
  trigger.warnings = ["unknown source warning"];
  const result = await collect(f);
  assert.equal(result.error_spans, 3);
  assert.equal(result.inspector_diagnostics.error_spans, 2);
  assert.equal(result.strict_trace, "failed");
  assert.equal(
    foundationAcceptedTraceExitCode([{ ...result, topology: "passed" }]),
    2,
  );
  assert.deepEqual(unreviewedWarnings(JSON.stringify(result)), [
    "unknown source warning",
  ]);
});

test("Lifecycle ACP late source diagnostics reset full closure convergence", async (t) => {
  const f = fixture(t);
  const request = f.options.request;
  let sourceReads = 0;
  f.options.request = async (url, options) => {
    if (new URL(url).pathname.endsWith(`/${triggerID}`) && ++sourceReads === 2)
      f.traces.get(triggerID).warnings = ["late source warning"];
    return request(url, options);
  };
  const result = await collect(f);
  assert.equal(sourceReads, 4);
  assert.equal(f.inspections, 4);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(result.warnings, ["late source warning"]);
});

for (const phase of ["query", "body", "inspector"])
  test(`Lifecycle ACP ${phase} cancellation joins active work and propagates actual reason`, async (t) => {
    const f = fixture(t);
    const abort = new AbortController();
    f.signal = abort.signal;
    const reason = new Error(`stop Lifecycle ${phase}`);
    let joined = false;
    const request = f.options.request;
    const inspect = f.inspect;
    f.options.signal = AbortSignal.timeout(60000);
    if (phase === "inspector") {
      f.inspect = async (...args) => {
        abort.abort(reason);
        const result = await inspect(...args);
        joined = true;
        return result;
      };
    } else {
      f.options.request = async (url, options) => {
        const path = new URL(url).pathname;
        if (
          (phase === "query" && path.endsWith("/trace-summaries")) ||
          (phase === "body" && path.endsWith(`/${sourceID}`))
        ) {
          const read = async () => {
            abort.abort(reason);
            assert.equal(options.signal.reason, reason);
            await Promise.resolve();
            joined = true;
            return phase === "query" ? { summaries: [] } : "{}";
          };
          return { ok: true, status: 200, json: read, text: read };
        }
        return request(url, options);
      };
    }
    await assert.rejects(collect(f), (error) => error === reason);
    assert.equal(joined, true);
    assert.equal(f.inspections, phase === "inspector" ? 1 : 0);
  });

test("Lifecycle ACP cannot override the fixed acp profile", async (t) => {
  const f = fixture(t, "cache");
  setTag(f.decision, prefix + "profile", "console");
  await assert.rejects(collect(f), /profile/u);
  assert.equal(f.inspections, 0);
});
