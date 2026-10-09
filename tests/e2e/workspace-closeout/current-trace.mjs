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
  databaseChildrenTopology,
} from "../observability/trace-tree.mjs";
import { strictSessionEvidence } from "../identity-closeout/session-trace.mjs";

export function inspectWorkspaceWatch(trace, expected, secrets) {
  assert.equal(trace?.traceID, expected.traceID);
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
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
  assert(
    Number.isFinite(window?.start) &&
      Number.isFinite(window?.end) &&
      window.end >= window.start,
    "observed closure window missing",
  );
  const inWindow = (s) =>
    s.duration > 0 &&
    (s.startTime + s.duration) / 1000 >= window.start &&
    (s.startTime + s.duration) / 1000 <= window.end;
  assert(inWindow(root), "watch did not finish in observed closure window");
  assert.equal(tag(root, "http.response.status_code"), 200);
  const identities = trace.spans.filter(
    (s) =>
      tree.service(s) === "identity-service" &&
      tag(s, "span.kind") === "server",
  );
  assert(identities.length > 0);
  const denied = [];
  function forwarded(server, peer) {
    const client = tree.parent(server);
    assert.equal(tree.service(client), "edge-gateway");
    assert.equal(tag(client, "span.kind"), "client");
    assert.equal(tree.parent(client), root);
    assert.equal(client.operationName, `HTTP POST ${peer}`);
    assert.equal(tag(client, "http.request.method"), "POST");
    return client;
  }
  for (const s of identities) {
    assert.equal(tag(s, "http.route"), "/rpc/identity/resolve-access-token");
    assert.equal(tag(s, "http.request.method"), "POST");
    assert.equal(tag(s, "rpc.method"), "resolve_access_token");
    databaseChildrenTopology(trace, s);
    const client = forwarded(s, "identity-service"),
      status = tag(s, "http.response.status_code");
    assert.equal(tag(client, "http.response.status_code"), status);
    if (status !== 200) {
      assert.equal(expected.revoked, true);
      assert.equal(status, 401);
      assert.equal(tag(s, "error.type"), "unauthenticated");
      assert.equal(tag(client, "error.type"), "401");
      assert(
        inWindow(s) && inWindow(client),
        "denial outside revocation window",
      );
      denied.push(s, client);
    }
  }
  assert(denied.length <= 2, "duplicate unauthorized revalidation");
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
  const cancellation = (s) =>
    inWindow(s) &&
    tag(s, "http.response.status_code") === 200 &&
    ((s === server && tag(s, "error.type") === "stream_interrupted") ||
      (s === client && tag(s, "error.type") === "cancelled") ||
      (s === root &&
        tag(s, "otel.status_description") === "handler_aborted" &&
        tag(s, "antnest.http.request_cancelled") === true));
  for (const s of trace.spans) {
    assert(tree.chain(s).includes(root));
    assert(!["agent-controller", "admin-console"].includes(tree.service(s)));
    if (!hasError(s)) continue;
    assert(
      denied.includes(s) ||
        cancellation(s) ||
        (s === root &&
          denied.length === 2 &&
          tag(s, "error.type") === "operation_failed" &&
          tag(s, "otel.status_description") ===
            "Operation failed; unclassified error text was not exported"),
      "unrelated watch error",
    );
  }
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((s) => s.warnings ?? []),
  ];
  return strictSessionEvidence(
    {
      trace_id: trace.traceID,
      spans: trace.spans.length,
      gateway_ancestry: true,
      identity_checks: identities.length,
      revocation_verified: denied.length === 2,
      stop_window_verified: true,
      warning_count: warnings.length,
      warnings: [...new Set(warnings)],
      strict_trace: warnings.length ? "failed" : "passed",
    },
    trace,
  );
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
