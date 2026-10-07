import assert from "node:assert/strict";
import { tag } from "../observability/trace-tree.mjs";
import {
  requestBoundary,
  hasError,
  closedV1PromptResponse,
  timingEvidence,
} from "../acp-plan/requests.mjs";

export function inspectPermissionTrace(
  trace,
  requests,
  expected,
  secrets = [],
) {
  assert(requests?.length, "missing model request correlation");
  assert.equal(expected?.method, "session/prompt");
  const { tree, request, forwarded } = requestBoundary(
    trace,
    expected,
    secrets,
  );
  const select = (service, operation) =>
    trace.spans.filter(
      (span) =>
        tree.service(span) === service && span.operationName === operation,
    );
  const acp = (operation) => select("agent-acp-service", operation);
  const single = (spans, label) => {
    assert.equal(spans.length, 1, `missing or duplicate ${label}`);
    return spans[0];
  };
  const phase = expected.phase;
  assert.match(
    phase,
    /^v[12]-(once|once-again|deny|always|follow|reject|reject-follow|chat|read-hint|judge-safe|judge-ask|cancel|reconnect)$/,
  );
  const remote = /deny|reject|cancel|chat/.test(phase) ? 0 : 1;
  const stages = /cancel|chat/.test(phase)
    ? [0]
    : phase.includes("judge-")
      ? [0, "judge", 1]
      : [0, 1];
  assert.deepEqual(
    [...new Set(requests.map((request) => request.phase))],
    [phase],
  );
  assert.deepEqual(
    requests.map((request) => request.stage),
    stages,
  );
  const run = single(acp("agent.run"), "Run");
  const runId = tag(run, "antnest.run.id");
  assert(runId, "Run identity missing");
  assert(tree.chain(run).includes(request), "Run detached from prompt");
  const inside = (span) => tree.chain(span).includes(run);
  assert(
    !trace.spans.some(
      (span) =>
        inside(span) &&
        ["agent-controller", "identity-service"].includes(tree.service(span)),
    ),
    "Run calls management service",
  );
  const persisted = acp("postgresql transaction").filter(
    (span) =>
      inside(span) &&
      tag(span, "db.system.name") === "postgresql" &&
      tag(span, "antnest.transaction.outcome") === "committed",
  );
  assert(
    persisted.some((transaction) =>
      trace.spans.some(
        (span) =>
          tree.service(span) === "agent-acp-service" &&
          tag(span, "span.kind") === "client" &&
          tag(span, "db.system.name") === "postgresql" &&
          ["INSERT", "UPDATE"].includes(tag(span, "db.operation.name")) &&
          tree.chain(span).includes(transaction),
      ),
    ),
    "missing committed Run persistence path",
  );
  const catalogReads = phase.endsWith("chat") ? 0 : 1;
  assert.equal(
    acp("mcp.tools.list").length,
    catalogReads,
    "incorrect Tool catalog access",
  );
  const preparation = [
    "mcp.runtime.info",
    ...(catalogReads ? ["mcp.tools.list"] : []),
  ];
  const prepared = preparation.map((operation) => {
    const span = single(acp(operation), operation);
    assert(inside(span), "preparation detached from Run");
    assert(
      trace.spans.some(
        (child) =>
          tree.service(child) === "antnest-runtime" &&
          tree.chain(child).includes(span),
      ),
      "Runtime preparation descendant missing",
    );
    return span;
  });
  assert.equal(
    acp("model.complete").length,
    requests.length,
    "unaccounted model requests",
  );
  assert.equal(
    acp("HTTP POST model").length,
    requests.length,
    "unaccounted model HTTP requests",
  );
  assert.equal(
    new Set(requests.map((request) => request.model_span_id)).size,
    requests.length,
  );
  const models = new Set();
  for (const observed of requests) {
    assert.equal(observed.trace_id, trace.traceID);
    const http = tree.spans.get(observed.model_span_id);
    assert.equal(
      http?.operationName,
      "HTTP POST model",
      "model HTTP span missing",
    );
    assert.equal(tree.service(http), "agent-acp-service");
    assert.equal(tag(http, "span.kind"), "client");
    const model = tree.parent(http);
    assert.equal(model?.operationName, "model.complete");
    assert(inside(model), "model detached from Run");
    assert.equal(
      tag(model, "model.purpose"),
      observed.stage === "judge" ? "permission_judge" : "response",
      "incorrect model purpose",
    );
    models.add(model.spanID);
    for (const span of prepared)
      assert(
        span.startTime + span.duration <= model.startTime,
        "preparation followed model execution",
      );
  }
  assert.equal(
    models.size,
    requests.length,
    "multiple HTTP requests reused one model span",
  );
  const waits = acp("acp.permission.wait");
  const waitExpected =
    /once|deny|always$|reject$|cancel|reconnect|judge-ask/.test(phase) ? 1 : 0;
  assert.equal(waits.length, waitExpected, "incorrect approval wait count");
  for (const wait of waits) {
    assert(inside(wait), "approval detached from Run");
    assert.equal(tag(wait, "antnest.run.id"), runId, "foreign approval Run");
    assert.equal(tag(wait, "antnest.session.id"), expected.sessionId);
    assert.equal(
      tag(wait, "antnest.outcome"),
      /deny|reject/.test(phase)
        ? "rejected"
        : phase.endsWith("cancel")
          ? "cancelled"
          : "ok",
      "incorrect permission outcome",
    );
  }
  const calls = acp("mcp.tools.call");
  const tools = select("antnest-runtime", "runtime.mcp.tool");
  const servers = trace.spans.filter(
    (span) =>
      tree.service(span) === "antnest-runtime" &&
      tag(span, "rpc.method") === "tools/call" &&
      tag(span, "span.kind") === "server",
  );
  assert.equal(calls.length, remote, "incorrect Runtime effect count");
  assert.equal(
    tools.length,
    remote,
    "unexpected Runtime Tool invocation count",
  );
  assert.equal(servers.length, remote, "unexpected Runtime Tool SERVER count");
  for (const call of calls) {
    assert(inside(call));
    for (const wait of waits)
      assert(
        wait.startTime + wait.duration <= call.startTime,
        "Tool preceded approval",
      );
    assert.equal(tag(call, "antnest.run.id"), runId);
    assert.equal(
      tag(call, "tool.name"),
      phase.includes("judge-")
        ? "mcp__fixture__echo"
        : phase.endsWith("read-hint")
          ? "read"
          : "write",
      "unexpected Runtime Tool name",
    );
    const tool = single(
      tools.filter((tool) => tree.chain(tool).includes(call)),
      "actual Runtime Tool descendant",
    );
    const server = single(
      servers.filter((server) => tree.chain(tool).includes(server)),
      "Runtime SERVER ancestor",
    );
    const client = tree.parent(server);
    assert.equal(tree.service(client), "agent-acp-service");
    assert.equal(tag(client, "span.kind"), "client");
    assert(tree.chain(client).includes(call));
  }
  for (const span of trace.spans.filter(hasError)) {
    // The reconnect client closes the socket while the v1 prompt is pending.
    if (phase === "v1-reconnect" && closedV1PromptResponse(span, request))
      continue;
    // A rejected permission is a deliberate decision, not a failed Run.
    assert(
      waits.includes(span) &&
        /deny|reject/.test(phase) &&
        tag(span, "antnest.outcome") === "rejected" &&
        tag(span, "error") !== true &&
        tag(span, "otel.status_code") !== "ERROR" &&
        !span.logs?.some((event) =>
          event.fields?.some((field) => field.value === "antnest.error"),
        ),
      `unexpected error outside deliberate permission rejection: ${tree.service(span)} ${span.operationName}`,
    );
  }
  return {
    trace_id: trace.traceID,
    run_id: runId,
    phase,
    spans: trace.spans.length,
    model_requests: requests.length,
    permission_waits: waits.length,
    runtime_tool_calls: remote,
    information_reads: 1,
    catalog_reads: catalogReads,
    gateway_ancestry: true,
    persistence: true,
    ...timingEvidence(trace, tree, request, forwarded),
  };
}
