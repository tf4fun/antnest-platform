import assert from "node:assert/strict";
import { requestBoundary, hasDiagnosticError } from "../acp-plan/requests.mjs";
import { tag } from "../observability/trace-tree.mjs";
import {
  assertPrivateACPApplicationJoined,
  privateACPProcessIdentity,
} from "../observability/private-acp-diagnostics.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { values, exactEvent } from "../observability/runtime-tool-evidence.mjs";

const normalize = (sql) => sql.replace(/\s+/gu, " ").trim();
const sessionRead =
  normalize(`SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
  client_mcp_revision_id, last_execution_revision, last_message_sequence, created_at, updated_at
  FROM acp_sessions WHERE id = $1`);
const reads = [
  sessionRead,
  "SELECT encrypted_sources, nonce FROM client_mcp_revisions WHERE id = $1",
  `SELECT t.run_id,t.organization_id,t.agent_id,t.execution_id,t.mcp_endpoint,
    r.execution_snapshot->'runtime'->>'revision' AS runtime_revision,
    r.execution_snapshot->'runtime'->>'connectionId' AS connection_id
    FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id WHERE t.organization_id=$1 AND t.agent_id=$2 AND t.released_at IS NULL ORDER BY t.run_id`,
  sessionRead,
].map(normalize);
const end = (span) => span.startTime + span.duration;
function removeFields(fields, allowed) {
  const original = values(fields);
  for (const [key, value] of Object.entries(allowed))
    assert.deepEqual(original[key], value);
  return fields.filter(({ key }) => !Object.hasOwn(allowed, key));
}
export function inspectPrivateClosedPrompt(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  for (const [key, value] of Object.entries({
    boundary: "private-acp",
    transport: "websocket",
    kind: "request",
    method: "session/prompt",
    outcome: "rejected",
    rejection: "agent_unavailable",
  }))
    assert.equal(expected[key], value);
  assert([1, 2].includes(expected.protocolVersion));
  assert.equal(expected.requestReceipt, undefined);
  assert.equal(expected.initializationResult, undefined);
  assert.equal(expected.closedBeforeResponse, undefined);
  assert(
    typeof expected.sessionId === "string" && expected.sessionId.length > 0,
  );
  assert.equal(expected.inputSessionID, expected.sessionId);
  assert.deepEqual(expected.rejectionReceipt, {
    rpcCode: -32020,
    code: "agent_unavailable",
    retryable: false,
  });
  assert.deepEqual(requests, [], "closed admission reached Provider");
  const { tree, request } = requestBoundary(trace, expected, secrets);
  const connection = expected.connectionTrace,
    sources = [trace, connection],
    observations = [];
  const children = (owner) =>
    trace.spans.filter((span) => tree.parent(span) === owner);
  const owned = new Set([request]);
  const requireNode = (span) => {
    const resource = values(trace.processes[span.processID].tags);
    const names = [
      resource["process.runtime.name"],
      resource["telemetry.sdk.language"],
    ].filter((value) => value !== undefined);
    assert(
      names.length > 0 && names.every((value) => value === "nodejs"),
      "RPC sub-ms deferral requires explicit consistent Node identity",
    );
  };
  const before = (left, right, point = right.startTime) => {
    assert.deepEqual(
      privateACPProcessIdentity(trace, left),
      privateACPProcessIdentity(trace, right),
    );
    if (end(left) <= point) return;
    requireNode(left);
    assert(
      [left, right].every(
        (span) =>
          Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
      ) && end(left) - point < 1000,
      "RPC control work out of order",
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
      boundary: "rpc-closed-admission-order",
      raw_left_us: end(left),
      raw_right_us: point,
      raw_difference_us: end(left) - point,
      raw_span_start_us: left.startTime,
      raw_next_start_us: right.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  };

  const joined = (span, parent) => {
    assert.equal(tree.parent(span), parent);
    assert.equal(tree.service(span), "agent-acp-service");
    assert.equal(span.processID, request.processID);
    assertPrivateACPApplicationJoined(
      trace,
      parent,
      span,
      observations,
      "rpc-closed-admission-joined",
    );
    owned.add(span);
  };
  for (const source of sources)
    for (const span of source.spans) {
      assert(
        Number.isFinite(span.startTime) &&
          Number.isFinite(span.duration) &&
          span.duration >= 0 &&
          Number.isFinite(end(span)),
      );
      for (const event of span.logs ?? [])
        assert(
          Number.isFinite(event.timestamp) &&
            event.timestamp >= span.startTime &&
            event.timestamp <= end(span),
        );
      for (const fields of [
        span.tags ?? [],
        ...(span.logs ?? []).map((e) => e.fields ?? []),
      ])
        for (const key of Object.keys(values(fields)))
          assert(
            !/^(antnest\.payload\.|pgx\.query\.parameters$|db\.(connection_string$|query\.(parameters?|results?)(\.|$)|statement\.parameters(\.|$)))/u.test(
              key,
            ),
            "closed admission captured private payload",
          );
    }
  for (const span of connection.spans) assertSessionSuccess(span);
  assert.equal(request.operationName, "acp session/prompt");
  assert.equal(children(request).length, 1);
  const app = children(request)[0];
  joined(app, request);
  assert.equal(app.operationName, "acp.session.prompt");
  assert.equal(tag(app, "span.kind"), "internal");
  for (const key of ["agent.id", "antnest.agent.id"])
    assert.equal(tag(app, key), expected.agentId);
  for (const key of ["session.id", "antnest.session.id"])
    assert.equal(tag(app, key), expected.sessionId);
  const available = children(app);
  assert.equal(
    available.length,
    4,
    "closed admission requires exactly four reads",
  );
  const sequence = reads.map((text) => {
    const matches = available
      .filter(
        (span) =>
          typeof tag(span, "db.query.text") === "string" &&
          normalize(tag(span, "db.query.text")) === text,
      )
      .sort((a, b) => a.startTime - b.startTime || end(a) - end(b));
    assert(matches.length, "closed admission SQL missing");
    const span = matches[0];
    available.splice(available.indexOf(span), 1);
    joined(span, app);
    assert.equal(span.operationName, "SELECT");
    for (const [key, value] of Object.entries({
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": "SELECT",
    }))
      assert.equal(tag(span, key), value);
    assertSessionSuccess(span);
    return span;
  });
  // Use the existing Progress endpoint policy for serial admission reads.
  for (let i = 1; i < sequence.length; i++)
    before(sequence[i - 1], sequence[i]);
  assert.equal(
    owned.size,
    trace.spans.length,
    "unaccounted closed-admission work",
  );
  assert.equal(
    request.logs?.length ?? 0,
    0,
    "RPC duplicated the application error event",
  );
  assert.equal(app.logs?.length, 1);
  const code = "agent_unavailable",
    message = "Operation reported agent_unavailable";
  const causeTypes = values(app.logs[0].fields)["antnest.error.cause_types"];
  assert.deepEqual(
    typeof causeTypes === "string" ? JSON.parse(causeTypes) : causeTypes,
    [],
  );
  const error = exactEvent(app, "antnest.error", {
    "antnest.error.stage": "acp.session.prompt",
    "antnest.operation.phase": "acp.session.prompt",
    "antnest.error.type": "DomainError",
    "antnest.error.code": code,
    "antnest.error.message": message,
    "antnest.error.cause_types": causeTypes,
    "antnest.error.causes": JSON.stringify([
      { type: "DomainError", code, message },
    ]),
  });
  before(sequence.at(-1), app, error.timestamp);
  const appTags = removeFields(app.tags, {
    "error.type": "DomainError",
    "error.code": code,
    "antnest.error.code": code,
    "antnest.outcome": "rejected",
    "antnest.operation.phase": "acp.session.prompt",
  });
  const rpcTags = removeFields(request.tags, {
    "error.type": "RequestError",
    "error.code": "-32020",
    "antnest.error.code": "-32020",
    "antnest.outcome": "rejected",
    "antnest.operation.phase": "acp.dispatch",
    "rpc.response.status_code": -32020,
    "antnest.error.origin_trace_id": trace.traceID,
    "antnest.error.origin_span_id": app.spanID,
  });
  assertSessionSuccess({ ...app, tags: appTags, logs: [] });
  assertSessionSuccess({ ...request, tags: rpcTags });
  const warnings = sources.flatMap((source) => [
    ...(source.warnings ?? []),
    ...source.spans.flatMap((span) => span.warnings ?? []),
  ]);
  const errors = sources.flatMap((source) =>
    source.spans.filter(hasDiagnosticError),
  );
  return {
    trace_id: trace.traceID,
    method: expected.method,
    request_id: expected.requestId,
    transport_boundary: "private-acp",
    sql_spans: 4,
    no_execution: true,
    model_requests: 0,
    owned_error_spans: [request, app].map((span) => ({
      trace_id: trace.traceID,
      span_id: span.spanID,
      reason: "rpc-closed-admission",
      request_id: expected.requestId,
      origin_span_id: app.spanID,
    })),
    time_observations: observations,
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
    error_spans: errors.length,
    strict_trace: warnings.length || errors.length ? "failed" : "passed",
  };
}
