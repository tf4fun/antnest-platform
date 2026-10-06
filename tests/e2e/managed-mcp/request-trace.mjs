import assert from "node:assert/strict";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { setTimeout as delay } from "node:timers/promises";
import {
  requestTraceBoundary,
  inspectCommandTrace,
  selectCommandTrace,
} from "../acp-commands/trace.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { hasError, timingEvidence } from "../acp-plan/requests.mjs";
import { collectTrace } from "./trace.mjs";

const plans = {
  "managed-bootstrap": ["write", "write"],
  "managed-exercise": ["mcp__alpha__fail", "mcp__alpha__echo", "bash"],
  "managed-mutate": ["write"],
  "managed-fresh": ["mcp__alpha__echo"],
  "managed-draining": ["mcp__alpha__echo", "mcp__alpha__echo"],
  "managed-rebuilt": ["mcp__beta__echo"],
};
export function inspectManagedTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  if (expected.kind === "request" && !expected.rejection)
    return inspectCommandTrace(trace, expected, secrets, requests);
  const { tree, request, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  const acp = (name) =>
    trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" && s.operationName === name,
    );
  const one = (spans, label) => {
    assert.equal(spans.length, 1, `missing or duplicate ${label}`);
    return spans[0];
  };
  const errors = trace.spans.filter(hasError);
  const timing = timingEvidence(trace, tree, request, forwarded);
  if (expected.rejection) {
    assert.equal(expected.rejection, "agent_busy");
    assert.equal(expected.kind, "request");
    assert.equal(requests.length, 0);
    assert.equal(tag(request, "rpc.response.status_code"), -32020);
    assert.equal(tag(request, "antnest.outcome"), "rejected");
    for (const s of trace.spans) {
      assert(!/^(agent\.run|model\.|mcp\.)/.test(s.operationName));
      assert.notEqual(tree.service(s), "antnest-runtime");
    }
    for (const s of errors) {
      assert.equal(tree.service(s), "agent-acp-service");
      assert(tree.chain(s).includes(request));
      assert.equal(tag(s, "antnest.outcome"), "rejected");
      assert.equal(
        tag(s, "antnest.error.code"),
        s === request ? "-32020" : "agent_busy",
      );
      if (s !== request) assert.equal(s.operationName, "acp.session.prompt");
    }
    return {
      label: expected.label,
      trace_id: trace.traceID,
      runs: 0,
      no_execution: true,
      rejection: expected.rejection,
      ...timing,
    };
  }
  const plan = plans[expected.phase];
  assert(plan, "unknown Managed phase");
  const run = one(acp("agent.run"), "Run");
  const runId = tag(run, "antnest.run.id");
  assert(runId && tree.chain(run).includes(request));
  const inside = (s) => tree.chain(s).includes(run);
  for (const s of trace.spans)
    assert(
      !(
        inside(s) &&
        ["agent-controller", "identity-service"].includes(tree.service(s))
      ),
      "Run called management service",
    );
  const finish = one(
    acp("SELECT").filter(
      (s) =>
        inside(s) &&
        tag(s, "span.kind") === "client" &&
        tag(s, "db.system.name") === "postgresql" &&
        /^WITH finished AS \(UPDATE runs\b/i.test(
          (tag(s, "db.query.text") ?? "").replace(/\s+/g, " "),
        ),
    ),
    "durable Run closure",
  );
  const prepared = ["mcp.runtime.info", "mcp.tools.list"].map((name) => {
    const span = one(acp(name), name);
    assert(inside(span));
    assert(
      trace.spans.some(
        (s) =>
          tree.service(s) === "antnest-runtime" && tree.chain(s).includes(span),
      ),
      "Runtime preparation descendant missing",
    );
    return span;
  });
  assert.equal(requests.length, plan.length + 1);
  assert.deepEqual(
    requests.map((r) => r.step),
    Array.from({ length: plan.length + 1 }, (_, i) => i),
  );
  assert.equal(acp("model.complete").length, requests.length);
  assert.equal(acp("HTTP POST model").length, requests.length);
  const models = requests.map((item) => {
    assert.equal(item.phase, expected.phase);
    assert.equal(item.trace_id, trace.traceID);
    assert.equal(item.outcome, "validated");
    const http = tree.spans.get(item.model_span_id);
    assert.equal(http?.operationName, "HTTP POST model");
    assert.equal(tree.service(http), "agent-acp-service");
    assert.equal(tag(http, "span.kind"), "client");
    const model = tree.parent(http);
    assert.equal(model?.operationName, "model.complete");
    assert(inside(model));
    for (const [key, field] of [
      ["antnest.execution.revision", "execution_revision"],
      ["antnest.runtime.revision", "runtime_revision"],
      ["antnest.runtime.execution_id", "runtime_execution_id"],
    ])
      assert.equal(
        tag(model, key),
        expected.snapshot[field],
        "Run changed captured execution",
      );
    assert(tag(model, "antnest.agent.revision"), "captured Agent spec missing");
    assert(Number.isSafeInteger(tag(model, "antnest.configuration.revision")));
    for (const prep of prepared)
      assert(
        prep.startTime + prep.duration <= model.startTime,
        "model preceded preparation",
      );
    return model;
  });
  assert.equal(new Set(models.map((s) => s.spanID)).size, requests.length);
  for (const key of [
    "antnest.agent.revision",
    "antnest.configuration.revision",
  ])
    assert.equal(
      new Set(models.map((s) => tag(s, key))).size,
      1,
      "Run changed captured configuration",
    );
  const calls = acp("mcp.tools.call").sort((a, b) => a.startTime - b.startTime);
  assert.deepEqual(
    calls.map((s) => tag(s, "tool.name")),
    plan,
  );
  const allTools = trace.spans.filter(
    (s) =>
      tree.service(s) === "antnest-runtime" &&
      s.operationName === "runtime.mcp.tool",
  );
  assert.equal(allTools.length, plan.length);
  assert.equal(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "antnest-runtime" &&
        s.operationName === "runtime.mcp.stdio",
    ).length,
    plan.filter((name) => name.startsWith("mcp__")).length,
    "unexpected managed stdio dispatch count",
  );
  const failedCalls = [];
  for (const call of calls) {
    assert(inside(call));
    assert.equal(tag(call, "antnest.run.id"), runId);
    const tool = one(
      allTools.filter((s) => tree.chain(s).includes(call)),
      "Runtime Tool descendant",
    );
    const server = one(
      tree
        .chain(tool)
        .filter(
          (s) =>
            tree.service(s) === "antnest-runtime" &&
            tag(s, "span.kind") === "server" &&
            tag(s, "rpc.method") === "tools/call",
        ),
      "Runtime Tool SERVER",
    );
    const client = tree.parent(server);
    assert.equal(tree.service(client), "agent-acp-service");
    assert.equal(tag(client, "span.kind"), "client");
    assert(tree.chain(client).includes(call));
    const name = tag(call, "tool.name");
    const stdio = trace.spans.filter(
      (s) =>
        tree.service(s) === "antnest-runtime" &&
        s.operationName === "runtime.mcp.stdio" &&
        tree.chain(s).includes(tool),
    );
    assert.equal(
      stdio.length,
      name.startsWith("mcp__") ? 1 : 0,
      "missing or duplicate managed stdio dispatch",
    );
    if (stdio.length) {
      assert.equal(tag(stdio[0], "span.kind"), "client");
      assert.equal(tag(stdio[0], "rpc.method"), "tools/call");
      assert.equal(tag(stdio[0], "mcp.tool.name"), name);
    }
    if (name === "mcp__alpha__fail") {
      for (const span of [call, tool, stdio[0]])
        assert(hasError(span), "controlled failure disappeared from tracing");
      failedCalls.push(call);
    }
  }
  for (const s of errors) {
    const failed = failedCalls.find((call) => tree.chain(s).includes(call));
    assert(failed, "unexpected error outside controlled Tool failure");
    if (tree.service(s) === "agent-acp-service") {
      assert.equal(s, failed, "unexpected ACP error under controlled failure");
      assert.equal(tag(s, "error.type"), "mcp_tool_error");
    } else {
      assert.equal(tree.service(s), "antnest-runtime");
      assert(
        [
          "runtime.mcp.tool",
          "runtime.mcp.stdio",
          "runtime.mcp.operation",
          "HTTP POST /mcp",
        ].includes(s.operationName),
        "unexpected Runtime error under controlled failure",
      );
      assert.equal(tag(s, "error.type"), "managed_tool_error");
    }
  }
  const gap =
    finish.startTime - models.at(-1).startTime - models.at(-1).duration;
  return {
    label: expected.label,
    phase: expected.phase,
    trace_id: trace.traceID,
    request_id: expected.requestId,
    run_id: runId,
    runs: 1,
    spans: trace.spans.length,
    provider_requests: requests.length,
    information_reads: 1,
    catalog_reads: 1,
    tool_calls: calls.length,
    runtime_tool_calls: allTools.length,
    execution_snapshot_verified: true,
    persistence: true,
    expected_tool_error_spans: errors.length,
    ...timing,
    model_to_finish_gap_us: gap,
    strict_trace:
      timing.strict_trace === "failed" || gap < 0 ? "failed" : "passed",
  };
}

export async function collectManagedTrace(
  base,
  expected,
  secrets,
  requests,
  save,
  inspect = inspectManagedTrace,
  signal,
) {
  const query = new URLSearchParams({
    service: "agent-acp-service",
    limit: "100",
    lookback: "1h",
    tags: JSON.stringify({
      "rpc.method": expected.method,
      "antnest.agent.id": expected.agentId,
      "antnest.request.id": expected.requestId,
    }),
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    signal?.throwIfAborted();
    const data = await searchJaegerTraces(base, query, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
    const id = selectCommandTrace(data, expected);
    if (id)
      return collectTrace(
        base,
        id,
        (trace) => {
          if (trace) save?.(trace);
          return inspect(
            trace,
            expected,
            secrets,
            requests.filter((r) => r.trace_id === id),
          );
        },
        signal,
      );
    await delay(1000, undefined, { signal });
  }
  throw new Error("actual Managed request trace missing");
}
