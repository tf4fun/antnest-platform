import assert from "node:assert/strict";
import {
  inspectPrivateCommandTrace,
  requestTraceBoundary,
} from "../acp-commands/trace.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { values } from "../observability/runtime-tool-evidence.mjs";
import {
  assertPrivateACPApplicationJoined,
  privateACPProcessIdentity,
} from "../observability/private-acp-diagnostics.mjs";

const normalize = (text) => text.replace(/\s+/gu, " ").trim();
// This probe runs after the observer confirms revocation. Prompt reads the
// original Session and its MCP revision, then the pre-preparation access check
// rejects it before temporary scopes, protection reads or Run acceptance.
const reads = [
  `SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
    client_mcp_revision_id, last_execution_revision, last_message_sequence, created_at, updated_at
    FROM acp_sessions WHERE id = $1`,
  "SELECT encrypted_sources, nonce FROM client_mcp_revisions WHERE id = $1",
].map(normalize);

export function inspectWorkspaceAccessDeniedTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  for (const [key, value] of Object.entries({
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: 1,
    kind: "request",
    method: "session/prompt",
    outcome: "rejected",
    rejection: "access_denied",
  }))
    assert.equal(expected[key], value);
  for (const key of [
    "requestReceipt",
    "initializationResult",
    "closedBeforeResponse",
  ])
    assert.equal(expected[key], undefined);
  assert(
    typeof expected.sessionId === "string" && expected.sessionId.length > 0,
  );
  assert.equal(expected.inputSessionID, expected.sessionId);
  assert.deepEqual(requests, [], "revoked Workspace Prompt reached Provider");
  const report = inspectPrivateCommandTrace(trace, expected, secrets, requests);
  const { tree, request } = requestTraceBoundary(trace, expected, secrets);
  const children = (owner) =>
    trace.spans.filter((span) => tree.parent(span) === owner);
  const applications = children(request);
  assert.equal(applications.length, 1, "extra Workspace denial dispatch work");
  const app = applications[0];
  assert.equal(app.operationName, "acp.session.prompt");
  const before = (left, right, point) => {
    const end = left.startTime + left.duration;
    if (end <= point) return;
    assert.deepEqual(
      privateACPProcessIdentity(trace, left),
      privateACPProcessIdentity(trace, right),
    );
    const resource = values(trace.processes[left.processID].tags);
    const runtimes = [
      resource["process.runtime.name"],
      resource["telemetry.sdk.language"],
    ].filter((value) => value !== undefined);
    // Preserve the existing same-Node endpoint observation policy used by
    // Progress admission, without changing either original timestamp.
    assert(
      runtimes.length > 0 &&
        runtimes.every((value) => value === "nodejs") &&
        [left, right].every(
          (span) =>
            Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
        ) &&
        end - point < 1000,
      "Workspace denial SQL was not awaited before its next operation",
    );
    const [host, pid, instance] = privateACPProcessIdentity(trace, left);
    report.time_observations.push({
      trace_id: trace.traceID,
      span_id: left.spanID,
      next_span_id: right.spanID,
      process_id: left.processID,
      host_name: host,
      process_pid: pid,
      service_instance_id: instance,
      boundary: "workspace-denial-sql-order",
      raw_left_us: end,
      raw_right_us: point,
      raw_difference_us: end - point,
      raw_span_start_us: left.startTime,
      raw_next_start_us: right.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  };
  for (const [key, value] of Object.entries({
    "agent.id": expected.agentId,
    "session.id": expected.sessionId,
  }))
    assert.equal(tag(app, key), value);
  const available = children(app);
  assert.equal(
    available.length,
    2,
    "Workspace denial requires exactly the Session and MCP admission reads",
  );
  const ordered = reads.map((query) => {
    const matches = available.filter(
      (span) =>
        typeof tag(span, "db.query.text") === "string" &&
        normalize(tag(span, "db.query.text")) === query,
    );
    assert.equal(
      matches.length,
      1,
      "missing or duplicate Workspace denial query",
    );
    const span = matches[0];
    assert.equal(tree.service(span), "agent-acp-service");
    assert.equal(span.processID, request.processID);
    assert.equal(span.operationName, "SELECT");
    for (const [key, value] of Object.entries({
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": "SELECT",
    }))
      assert.equal(tag(span, key), value);
    assertPrivateACPApplicationJoined(
      trace,
      app,
      span,
      report.time_observations,
      "workspace-denial-read-joined",
    );
    before(span, app, app.logs[0].timestamp);
    return span;
  });
  for (let index = 1; index < ordered.length; index++)
    before(ordered[index - 1], ordered[index], ordered[index].startTime);
  assert.equal(
    trace.spans.length,
    4,
    "unaccounted work in revoked Workspace Prompt",
  );
  for (const source of [trace, expected.connectionTrace])
    for (const span of source.spans)
      for (const fields of [
        span.tags ?? [],
        ...(span.logs ?? []).map((event) => event.fields ?? []),
      ])
        for (const key of Object.keys(values(fields)))
          assert(
            !/^(antnest\.payload\.|pgx\.query\.parameters$|db\.(connection_string$|query\.(parameters?|results?)(\.|$)|statement\.parameters(\.|$)))/u.test(
              key,
            ),
            "Workspace denial captured SQL parameters or payload",
          );
  return {
    ...report,
    no_execution: true,
    sql_spans: 2,
    model_requests: 0,
    runtime_tool_calls: 0,
  };
}
