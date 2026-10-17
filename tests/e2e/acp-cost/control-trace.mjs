import assert from "node:assert/strict";
import { assertCostTraceSource } from "./trace-source.mjs";
import {
  inspectPrivateCommandTrace,
  requestTraceBoundary,
} from "../acp-commands/trace.mjs";
import { inspectCatalogRuntime } from "../acp-plan/requests.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  assertPrivateACPApplicationJoined,
  privateACPProcessIdentity,
} from "../observability/private-acp-diagnostics.mjs";
import { tag } from "../observability/trace-tree.mjs";

const sessionRead =
  `SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
  client_mcp_revision_id,
  last_execution_revision, last_message_sequence, created_at, updated_at
  FROM acp_sessions WHERE id = $1`
    .replace(/\s+/gu, " ")
    .trim();
const one = (values, label) => {
  assert.equal(values.length, 1, "missing or duplicate Cost control " + label);
  return values[0];
};
function initialization(expected, secrets) {
  const result = expected.initializationResult;
  assertSecretFree(JSON.stringify(result) ?? "", secrets);
  assert(
    result && typeof result === "object",
    "actual Cost initialization result missing",
  );
  assert.equal(result.protocolVersion, expected.protocolVersion);
  const info = expected.protocolVersion === 1 ? result.agentInfo : result.info;
  assert.deepEqual(info, {
    name: "antnest-agent-acp-service",
    title: "Antnest Agent",
    version: "0.1.0",
  });
  if (expected.protocolVersion === 1) {
    const caps = result.agentCapabilities;
    assert(caps && typeof caps === "object");
    assert.equal(caps.loadSession, true);
    assert.deepEqual(caps.mcpCapabilities, {});
    assert(
      caps.promptCapabilities && typeof caps.promptCapabilities === "object",
    );
    assert.deepEqual(caps.sessionCapabilities, {
      list: {},
      delete: {},
      fork: {},
      resume: {},
      close: {},
    });
  } else {
    const caps = result.capabilities?.session;
    assert(caps && typeof caps === "object");
    assert.deepEqual(caps.delete, {});
    assert.deepEqual(caps.fork, {});
    assert(caps.prompt && typeof caps.prompt === "object");
  }
}

// Initialize and known access refusals have no Session mutation or execution.
// HTTP readiness belongs to the actual receiver, not to a synthetic business RPC.
export function inspectPrivateCostControlTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assertCostTraceSource(trace, expected.connectionTrace);
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.kind, "request");
  assert([1, 2].includes(expected.protocolVersion));
  assert.equal(expected.version, expected.protocolVersion);
  assert.deepEqual(requests, [], "Cost control request reached Provider");
  const initialize = expected.method === "initialize";
  assert.equal(
    expected.requestReceipt,
    undefined,
    "control request borrowed a business success receipt",
  );
  if (initialize) {
    assert.equal(expected.outcome, "succeeded");
    assert.equal(expected.inputSessionID, null);
    assert.equal(expected.sessionId, undefined);
    assert.equal(expected.rejection, undefined);
    assert.equal(expected.rejectionReceipt, undefined);
    initialization(expected, secrets);
  } else {
    assert.equal(expected.initializationResult, undefined);
    assert.equal(expected.outcome, "rejected");
    if (expected.method === "session/new") {
      assert.equal(expected.rejection, "access_denied");
      assert.equal(expected.inputSessionID, null);
      assert.equal(expected.sessionId, undefined);
    } else {
      assert(
        [
          "session/fork",
          "session/prompt",
          "session/close",
          "session/delete",
          expected.protocolVersion === 1 ? "session/load" : "session/resume",
        ].includes(expected.method),
      );
      assert.equal(expected.rejection, "session_access_denied");
      assert(
        typeof expected.inputSessionID === "string" &&
          expected.inputSessionID.length > 0,
      );
      assert.equal(expected.sessionId, expected.inputSessionID);
    }
  }
  const result = inspectPrivateCommandTrace(trace, expected, secrets, requests);
  const { tree, root, request, http, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  const catalog = inspectCatalogRuntime(trace, tree, request, expected);
  if (
    !initialize ||
    expected.protocolVersion === 2 ||
    expected.agentAccessDenied === true
  )
    assert.equal(
      catalog.informationReads,
      0,
      "Cost control cannot read Runtime catalog",
    );
  const observations = [...result.time_observations];
  const owned = new Set(
    [root, request, http, forwarded, ...catalog.spans].filter(Boolean),
  );
  const queries = new Set();
  const named = (name) =>
    trace.spans.filter((span) => span.operationName === name);
  const joined = (span, owner, boundary) => {
    assert.equal(tree.service(span), "agent-acp-service");
    assertPrivateACPApplicationJoined(
      trace,
      owner,
      span,
      observations,
      boundary,
    );
  };
  const before = (
    left,
    right,
    leftEnd = left.startTime + left.duration,
    rightStart = right.startTime,
  ) => {
    assert.deepEqual(
      privateACPProcessIdentity(trace, left),
      privateACPProcessIdentity(trace, right),
    );
    if (leftEnd <= rightStart) return;
    const resource = Object.fromEntries(
      trace.processes[left.processID].tags.map(({ key, value }) => [
        key,
        value,
      ]),
    );
    assert.equal(
      resource["process.runtime.name"] ?? resource["telemetry.sdk.language"],
      "nodejs",
    );
    assert(
      [left, right].every(
        (span) =>
          Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
      ) && leftEnd - rightStart < 1000,
      "Cost control order outside deferred same-Node sub-ms boundary",
    );
    const [host, pid, instance] = privateACPProcessIdentity(trace, left);
    observations.push({
      trace_id: trace.traceID,
      span_id: left.spanID,
      next_span_id: right.spanID,
      process_id: left.processID,
      host_name: host,
      process_pid: pid,
      service_instance_id: instance,
      boundary: "cost-control-sql-order",
      raw_left_us: leftEnd,
      raw_right_us: rightStart,
      raw_difference_us: leftEnd - rightStart,
      raw_span_start_us: left.startTime,
      raw_next_start_us: right.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  };
  const query = (owner, text) => {
    const span = one(
      trace.spans.filter(
        (span) =>
          tree.parent(span) === owner &&
          span.tags?.some(({ key }) => key.startsWith("db.")),
      ),
      "SQL",
    );
    for (const [key, value] of Object.entries({
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": "SELECT",
    }))
      assert.equal(tag(span, key), value);
    assert.equal(
      (tag(span, "db.query.text") ?? "").replace(/\s+/gu, " ").trim(),
      text,
    );
    joined(span, owner, "cost-control-sql-joined");
    queries.add(span);
    owned.add(span);
    return span;
  };
  let application;
  const applications = trace.spans.filter((span) =>
    span.operationName.startsWith("acp.session."),
  );
  assert.equal(applications.length, initialize ? 0 : 1);
  if (!initialize) {
    application = applications[0];
    // The shared rejection proof binds the original error event and RPC cause.
    for (const key of ["agent.id", "antnest.agent.id"])
      assert.equal(tag(application, key), expected.agentId);
    for (const key of ["session.id", "antnest.session.id"])
      assert.equal(tag(application, key), expected.inputSessionID ?? undefined);
    owned.add(application);
    if (expected.rejection === "session_access_denied") {
      const authorization = query(application, sessionRead);
      before(
        authorization,
        application,
        authorization.startTime + authorization.duration,
        application.logs[0].timestamp,
      );
    }
  }
  for (const read of named("mcp.runtime.info.read"))
    joined(read, request, "cost-control-catalog-joined-by-rpc");
  const readiness = named("postgres.ready");
  assert.equal(readiness.length, expected.transport === "http" ? 1 : 0);
  if (readiness.length) {
    const ready = readiness[0];
    assert.equal(tree.parent(ready), http);
    assert.equal(tag(ready, "span.kind"), "internal");
    assert.equal(tag(ready, "db.system.name"), "postgresql");
    assert.equal(tag(ready, "db.query.text"), undefined);
    joined(ready, http, "cost-control-readiness-joined-by-http");
    owned.add(ready);
    query(ready, "SELECT 1");
    if (http !== request) before(ready, request);
    for (const next of [application, ...named("mcp.runtime.info.read")].filter(
      Boolean,
    ))
      before(ready, next);
  }
  for (const source of [trace, expected.connectionTrace])
    for (const span of source?.spans ?? []) {
      assert(
        !["agent.run", "runtime.mcp.tool"].includes(span.operationName) &&
          tag(span, "rpc.method") !== "tools/call",
        "Cost control unexpectedly executed a Run or Tool",
      );
      for (const fields of [
        span.tags ?? [],
        ...(span.logs ?? []).map((event) => event.fields ?? []),
      ])
        assert(
          !fields.some(({ key }) => key === "antnest.payload.json"),
          "Cost control captured payload",
        );
    }
  for (const span of trace.spans) {
    assert(owned.has(span), "unowned Cost control work");
    if (span.tags?.some(({ key }) => key.startsWith("db.")))
      assert(
        queries.has(span) || readiness.includes(span),
        "unowned Cost control database work",
      );
  }
  return {
    ...result,
    no_execution: true,
    initialization: initialize,
    session_transactions: 0,
    input_session_id: expected.inputSessionID,
    database_queries: queries.size,
    http_readiness_checks: readiness.length,
    owned_error_spans: (result.owned_error_spans ?? []).map((record) => ({
      ...record,
      reason:
        record.reason === "command-rejection"
          ? "cost-rejection"
          : record.reason,
    })),
    time_observations: observations,
    sql_parameters_observed: false,
  };
}
