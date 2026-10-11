import assert from "node:assert/strict";
import { requestTraceBoundary } from "../acp-commands/trace.mjs";
import {
  closedV1PromptResponse,
  hasError,
  timingEvidence,
} from "../acp-plan/requests.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";
import { strictSessionEvidence } from "../identity-closeout/session-trace.mjs";
import {
  collectResolveTraceEvidence,
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { inspectWatchResolutions } from "./watch-resolution.mjs";
import { assertGatewayResolutionAttributes } from "../../support/gateway-resolution.mjs";

export async function collectWorkspaceWatch(
  base,
  expected,
  secrets,
  options = {},
) {
  const [result] = await collectResolveTraceEvidence(
    base,
    [expected],
    secrets,
    {
      ...options,
      inspect: inspectWorkspaceWatch,
    },
  );
  return result;
}

export function inspectWorkspaceWatch(trace, expected, secrets, options = {}) {
  assert.equal(trace?.traceID, expected.traceID);
  assert(
    !["aborted", "invalid-state"].includes(expected.closure?.kind),
    "watch observation did not complete",
  );
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const sources = resolveTraceSources(trace, secrets, options);
  for (const source of sources) assertGatewayResolutionAttributes(source);
  const one = (rows, label) => {
    assert.equal(rows.length, 1, `missing or duplicate ${label}`);
    return rows[0];
  };
  const root = one(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "edge-gateway" &&
        tag(s, "span.kind") === "server" &&
        tag(s, "http.route") === "/api/app/agents/{agent_id}/state/watch",
    ),
    "Gateway watch",
  );
  assert.equal(tree.parent(root), undefined, "invented watch parent");
  assert.equal(tag(root, "http.request.method"), "GET");
  const window = expected.stopWindow;
  if (expected.revoked)
    assert.match(
      expected.revocationTraceID ?? "",
      /^[a-f0-9]{32}$/,
      "revocation source trace missing",
    );
  assert(
    Number.isFinite(window?.start) &&
      Number.isFinite(window?.end) &&
      window.end >= window.start,
    "observed closure window missing",
  );
  const clock = expected.clock,
    serverDate = Date.parse(clock?.serverDate);
  assert(
    Number.isFinite(serverDate) &&
      new Date(serverDate).toUTCString() === clock.serverDate &&
      Number.isSafeInteger(clock.requestStartedAt) &&
      Number.isSafeInteger(clock.responseReceivedAt) &&
      clock.responseReceivedAt >= clock.requestStartedAt &&
      window.start >= clock.responseReceivedAt,
    "observed Gateway clock interval missing or invalid",
  );
  // HTTP Date has one-second precision. The server sent those headers between
  // the host's request and response observations; retain that measured range
  // instead of assuming the host and Docker VM share an exact wall clock.
  const clockOffset = {
    min: serverDate - clock.responseReceivedAt,
    max: serverDate + 1000 - clock.requestStartedAt,
  };
  const inWindow = (s) =>
    s.duration > 0 &&
    (s.startTime + s.duration) / 1000 >= window.start + clockOffset.min &&
    (s.startTime + s.duration) / 1000 < window.end + clockOffset.max;
  assert(inWindow(root), "watch did not finish in observed closure window");
  assert.equal(tag(root, "http.response.status_code"), 200);
  function forwarded(server, peer) {
    const client = tree.parent(server);
    assert.equal(tree.service(client), "edge-gateway");
    assert.equal(tag(client, "span.kind"), "client");
    assert.equal(tree.parent(client), root);
    assert.equal(client.operationName, `HTTP POST ${peer}`);
    assert.equal(tag(client, "http.request.method"), "POST");
    return client;
  }
  const server = one(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" &&
        tag(s, "span.kind") === "server",
    ),
    "ACP watch",
  );
  assert.equal(
    tag(server, "http.route"),
    "/rpc/agent-acp/watch-agent-execution-state",
  );
  assert.equal(tag(server, "rpc.method"), "watch_agent_execution_state");
  assert.equal(tag(server, "http.request.method"), "POST");
  assert.equal(tag(server, "http.response.status_code"), 200);
  const client = forwarded(server, "agent-acp-workspace");
  assert.equal(tag(client, "http.response.status_code"), 200);
  // A private revocation feed may cancel the stream before another Resolve.
  // Its custom context cause is recorded by the HTTP transport as an
  // operation failure while reading the already admitted response body.
  const revokedStreamRead =
    expected.revoked === true &&
    inWindow(client) &&
    inWindow(server) &&
    tag(client, "error.type") === "operation_failed" &&
    tag(client, "otel.status_description") ===
      "Operation failed; unclassified error text was not exported" &&
    client.logs?.some(
      (entry) =>
        entry.fields?.some(
          (field) => field.key === "event" && field.value === "antnest.error",
        ) &&
        entry.fields?.some(
          (field) =>
            field.key === "antnest.error.stage" &&
            field.value === "read_response",
        ),
    ) &&
    tag(server, "error.type") === "stream_interrupted" &&
    tag(server, "antnest.outcome") === "disconnected";
  const cancellation = (s) =>
    inWindow(s) &&
    tag(s, "http.response.status_code") === 200 &&
    ((s === server && tag(s, "error.type") === "stream_interrupted") ||
      (s === client &&
        (tag(s, "error.type") === "cancelled" || revokedStreamRead)) ||
      (s === root &&
        tag(s, "otel.status_description") === "handler_aborted" &&
        tag(s, "antnest.http.request_cancelled") === true));
  const { allowedErrors, ...resolution } = inspectWatchResolutions(
    trace,
    root,
    client,
    expected,
    options,
    inWindow,
    {
      clockOffset,
      localCancelled: hasError(root) && cancellation(root),
      feedCancelled: revokedStreamRead,
    },
  );
  for (const s of trace.spans) {
    assert(tree.chain(s).includes(root));
    assert(!["agent-controller", "admin-console"].includes(tree.service(s)));
    if (!hasError(s)) continue;
    assert(
      allowedErrors.has(s) ||
        cancellation(s) ||
        (s === root &&
          resolution.revocation_verified &&
          tag(s, "error.type") === "operation_failed" &&
          tag(s, "otel.status_description") ===
            "Operation failed; unclassified error text was not exported"),
      "unrelated watch error",
    );
  }
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    gateway_ancestry: true,
    ...resolution,
    ...(expected.revoked
      ? { revocation_trace_id: expected.revocationTraceID }
      : {}),
    stop_window_verified: true,
    clock_offset_ms: clockOffset,
    ...resolveTraceDiagnostics(trace, sources),
  };
}

export function inspectCancelledTrace(trace, expected, secrets, requests) {
  assert.equal(expected.kind, "cancelled");
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
  const run = one(acp("agent.run"), "cancelled Run");
  assert.equal(tag(run, "antnest.run.id"), expected.runId);
  assert(tree.chain(run).includes(request));
  const inside = (s) => tree.chain(s).includes(run);
  for (const s of trace.spans)
    assert(
      !(
        inside(s) &&
        ["identity-service", "agent-controller"].includes(tree.service(s))
      ),
      "Run called management service",
    );
  one(
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
  for (const name of ["mcp.runtime.info", "mcp.tools.list"]) {
    const prep = one(acp(name), name);
    assert(inside(prep));
    assert(
      trace.spans.some(
        (s) =>
          tree.service(s) === "antnest-runtime" && tree.chain(s).includes(prep),
      ),
    );
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stage, "tool");
  assert.equal(requests[0].phase, expected.phase);
  assert.equal(requests[0].trace_id, trace.traceID);
  const model = one(acp("model.complete"), "model request");
  assert(inside(model));
  const http = one(acp("HTTP POST model"), "actual Provider request");
  assert.equal(http.spanID, requests[0].model_span_id);
  assert.equal(tree.parent(http), model);
  const call = one(acp("mcp.tools.call"), "Tool call");
  assert(inside(call));
  assert.equal(tag(call, "antnest.run.id"), expected.runId);
  assert.equal(tag(call, "tool.name"), "bash");
  const tool = one(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "antnest-runtime" &&
        s.operationName === "runtime.mcp.tool",
    ),
    "Runtime Tool",
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
  for (const s of trace.spans.filter(hasError)) {
    const type = tag(s, "error.type");
    assert(
      (expected.closedBeforeResponse === true &&
        closedV1PromptResponse(s, request)) ||
        (s === run && type === "run_unresolved") ||
        (s === call && type === "McpToolCallError") ||
        (tree.service(s) === "antnest-runtime" &&
          tree.chain(s).includes(call) &&
          [
            "runtime.executor",
            "runtime.mcp.tool",
            "runtime.mcp.operation",
            "HTTP POST /mcp",
          ].includes(s.operationName) &&
          type === "outcome_unknown"),
      `unexpected cancellation error: ${tree.service(s)} ${s.operationName} ${type}`,
    );
  }
  return strictSessionEvidence(
    {
      label: expected.label,
      trace_id: trace.traceID,
      run_id: expected.runId,
      runs: 1,
      provider_requests: 1,
      runtime_tool_calls: 1,
      persistence: true,
      ...timingEvidence(trace, tree, request, forwarded),
    },
    trace,
  );
}
