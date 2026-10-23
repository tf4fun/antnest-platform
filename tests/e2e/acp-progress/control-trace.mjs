import assert from "node:assert/strict";
import { requestBoundary, hasDiagnosticError } from "../acp-plan/requests.mjs";
import { tag } from "../observability/trace-tree.mjs";
import {
  assertPrivateACPApplicationJoined,
  privateACPProcessIdentity,
} from "../observability/private-acp-diagnostics.mjs";
import { inspectPrivateNotificationTrace } from "../identity-closeout/private-acp-notification.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { values, exactEvent } from "../observability/runtime-tool-evidence.mjs";

const normalize = (sql) => sql.replace(/\s+/gu, " ").trim();
const sessionRead =
  normalize(`SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
  client_mcp_revision_id, last_execution_revision, last_message_sequence, created_at, updated_at
  FROM acp_sessions WHERE id = $1`);
const admissionQueries = [
  sessionRead,
  "SELECT encrypted_sources, nonce FROM client_mcp_revisions WHERE id = $1",
  `SELECT t.run_id,t.organization_id,t.agent_id,t.execution_id,t.mcp_endpoint,
    r.execution_snapshot->'runtime'->>'revision' AS runtime_revision,
    r.execution_snapshot->'runtime'->>'connectionId' AS connection_id
    FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id WHERE t.organization_id=$1 AND t.agent_id=$2 AND t.released_at IS NULL ORDER BY t.run_id`,
  sessionRead,
  `SELECT EXISTS (
    SELECT 1 FROM tool_attempts AS attempt
    JOIN runs AS run ON run.id = attempt.run_id
    JOIN acp_sessions AS session ON session.id = run.session_id
    WHERE session.organization_id = $1 AND session.agent_id = $2
      AND ($3::text IS NULL OR run.execution_snapshot->'runtime'->>'revision' = $3)
      AND attempt.source = 'runtime' AND NOT attempt.runtime_call_stopped
  ) OR EXISTS (
    SELECT 1 FROM temporary_skill_scopes temporary JOIN runs run ON run.id=temporary.run_id
    WHERE temporary.organization_id=$1 AND temporary.agent_id=$2 AND temporary.released_at IS NULL
      AND ($3::text IS NULL OR run.execution_snapshot->'runtime'->>'revision'=$3)
  ) OR EXISTS (
    SELECT 1 FROM learning_runtime_protections protection
    WHERE protection.organization_id=$1 AND protection.agent_id=$2 AND protection.retired_at IS NULL
      AND ($3::text IS NULL OR protection.runtime_revision=$3)
  ) AS protected`,
].map(normalize);
const cancellationQueries = [
  "BEGIN",
  sessionRead + " FOR UPDATE",
  `UPDATE runs
    SET cancel_requested_at = COALESCE(cancel_requested_at, $2), updated_at = $2
    WHERE session_id = $1 AND state IN ('admitting', 'running')`,
  "COMMIT",
].map(normalize);
const end = (span) => span.startTime + span.duration;
const one = (items, name) => {
  assert.equal(items.length, 1, "missing or duplicate Progress " + name);
  return items[0];
};

function context(trace, expected, tree, root, connection) {
  const observations = [],
    owned = new Set([root]);
  const sources = [trace, connection];
  for (const source of sources)
    for (const span of source.spans) {
      assert(
        Number.isFinite(span.startTime) &&
          Number.isFinite(span.duration) &&
          span.duration >= 0 &&
          Number.isFinite(end(span)),
        "invalid Progress control lifetime",
      );
      for (const event of span.logs ?? [])
        assert(
          Number.isFinite(event.timestamp) &&
            event.timestamp >= span.startTime &&
            event.timestamp <= end(span),
          "Progress control event outside its own span",
        );
      for (const fields of [
        span.tags ?? [],
        ...(span.logs ?? []).map((event) => event.fields ?? []),
      ])
        for (const key of Object.keys(values(fields)))
          assert(
            !/^(antnest\.payload\.|pgx\.query\.parameters$|db\.(connection_string$|query\.(parameters?|results?)(\.|$)|statement\.parameters(\.|$)))/u.test(
              key,
            ),
            "Progress control captured SQL parameters or payload",
          );
    }
  for (const span of connection.spans) assertSessionSuccess(span);
  const children = (owner) =>
    trace.spans.filter((span) => tree.parent(span) === owner);
  const requireNode = (span) => {
    const resource = values(trace.processes[span.processID].tags);
    const names = [
      resource["process.runtime.name"],
      resource["telemetry.sdk.language"],
    ].filter((value) => value !== undefined);
    assert(
      names.length > 0 && names.every((value) => value === "nodejs"),
      "Progress sub-ms deferral requires explicit consistent Node identity",
    );
  };
  const joined = (span, parent) => {
    assert.equal(tree.parent(span), parent, "foreign Progress control parent");
    assert.equal(tree.service(span), "agent-acp-service");
    assert.equal(span.processID, root.processID);
    if (end(span) > end(parent)) requireNode(span);
    assertPrivateACPApplicationJoined(
      trace,
      parent,
      span,
      observations,
      "progress-control-joined",
    );
    owned.add(span);
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
      "Progress control work out of order",
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
      boundary: "progress-control-order",
      raw_left_us: end(left),
      raw_right_us: point,
      raw_difference_us: end(left) - point,
      raw_span_start_us: left.startTime,
      raw_next_start_us: right.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  };
  const application = one(children(root), "control application");
  joined(application, root);
  assert.equal(tag(application, "span.kind"), "internal");
  for (const key of ["agent.id", "antnest.agent.id"])
    assert.equal(tag(application, key), expected.agentId);
  for (const key of ["session.id", "antnest.session.id"])
    assert.equal(tag(application, key), expected.sessionId);
  const sql = (owner, statements) => {
    const available = children(owner).filter(
      (span) => tag(span, "db.query.text") !== undefined,
    );
    assert.equal(
      available.length,
      statements.length,
      "incomplete Progress control SQL inventory",
    );
    const sequence = statements.map((text) => {
      const matches = available
        .filter((span) => normalize(tag(span, "db.query.text")) === text)
        .sort((a, b) => a.startTime - b.startTime || end(a) - end(b));
      assert(matches.length, "missing Progress control SQL statement");
      const span = matches[0];
      available.splice(available.indexOf(span), 1);
      joined(span, owner);
      const operation = text.split(" ")[0];
      assert.equal(span.operationName, operation);
      for (const [key, value] of Object.entries({
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.namespace": "antnest_agent_acp",
        "db.operation.name": operation,
      }))
        assert.equal(tag(span, key), value);
      assertSessionSuccess(span);
      return span;
    });
    for (let index = 1; index < sequence.length; index++)
      before(sequence[index - 1], sequence[index]);
    return sequence;
  };
  const report = (claims = []) => {
    assert.equal(
      owned.size,
      trace.spans.length,
      "unaccounted Progress control work",
    );
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
      transport_boundary: "private-acp",
      sql_spans: 5,
      model_requests: 0,
      owned_error_spans: claims,
      time_observations: observations,
      warning_count: warnings.length,
      warnings: [...new Set(warnings)],
      error_spans: errors.length,
      strict_trace: warnings.length || errors.length ? "failed" : "passed",
    };
  };
  return { application, children, joined, before, sql, report };
}

function removeFields(fields, allowed) {
  const original = values(fields);
  for (const [key, value] of Object.entries(allowed))
    assert.deepEqual(original[key], value);
  return fields.filter(({ key }) => !Object.hasOwn(allowed, key));
}

export function inspectProgressBarrierTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert.equal(expected.kind, "request");
  assert([1, 2].includes(expected.protocolVersion));
  assert.equal(expected.method, "session/prompt");
  assert.equal(expected.outcome, "rejected");
  assert.equal(expected.rejection, "runtime_barrier_required");
  assert.equal(expected.requestReceipt, undefined);
  assert.equal(expected.initializationResult, undefined);
  assert.equal(expected.closedBeforeResponse, undefined);
  assert(
    typeof expected.sessionId === "string" && expected.sessionId.length > 0,
  );
  assert.equal(expected.inputSessionID, expected.sessionId);
  assert.deepEqual(expected.rejectionReceipt, {
    rpcCode: -32020,
    code: "runtime_barrier_required",
    retryable: false,
  });
  assert.deepEqual(requests, [], "barrier rejection reached Provider");
  const { tree, request } = requestBoundary(trace, expected, secrets);
  assert.equal(request.operationName, "acp session/prompt");
  const ctx = context(trace, expected, tree, request, expected.connectionTrace);
  const app = ctx.application;
  assert.equal(app.operationName, "acp.session.prompt");
  const reads = ctx.sql(app, admissionQueries);
  assert.equal(
    request.logs?.length ?? 0,
    0,
    "RPC must retain the application origin without another error event",
  );
  assert.equal(app.logs?.length, 1);
  const code = "runtime_barrier_required",
    message = "Operation reported runtime_barrier_required";
  const causeTypes = values(app.logs[0].fields)["antnest.error.cause_types"];
  assert.deepEqual(
    typeof causeTypes === "string" ? JSON.parse(causeTypes) : causeTypes,
    [],
  );
  const fields = {
    "antnest.error.stage": "acp.session.prompt",
    "antnest.operation.phase": "acp.session.prompt",
    "antnest.error.type": "DomainError",
    "antnest.error.code": code,
    "antnest.error.message": message,
    "antnest.error.cause_types": causeTypes,
    "antnest.error.causes": JSON.stringify([
      { type: "DomainError", code, message },
    ]),
  };
  const error = exactEvent(app, "antnest.error", fields);
  ctx.before(reads.at(-1), app, error.timestamp);
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
  return {
    ...ctx.report(
      [request, app].map((span) => ({
        trace_id: trace.traceID,
        span_id: span.spanID,
        reason: "progress-barrier-rejection",
        request_id: expected.requestId,
        origin_span_id: app.spanID,
      })),
    ),
    request_id: expected.requestId,
    barrier_rejection: true,
  };
}

export function inspectProgressCancelTrace(
  trace,
  receipt,
  connectionTrace,
  secrets = [],
) {
  const { tree, notification, connection } = inspectPrivateNotificationTrace(
    trace,
    receipt,
    connectionTrace,
    secrets,
  );
  const ctx = context(
    trace,
    connection.expected,
    tree,
    notification,
    connectionTrace,
  );
  assert.equal(tag(notification, "rpc.response.status_code"), undefined);
  assert.equal(notification.logs?.length ?? 0, 0);
  const app = ctx.application;
  assert.equal(app.operationName, "acp.session.cancel");
  assert.equal(tag(app, "antnest.outcome"), "ok");
  const [authorization] = ctx.sql(app, [sessionRead]);
  const transaction = one(
    ctx
      .children(app)
      .filter((span) => span.operationName === "postgresql transaction"),
    "cancellation transaction",
  );
  ctx.joined(transaction, app);
  assert.equal(tag(transaction, "span.kind"), "internal");
  assert.equal(tag(transaction, "db.system.name"), "postgresql");
  assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
  ctx.before(authorization, transaction);
  ctx.sql(transaction, cancellationQueries);
  for (const span of trace.spans) assertSessionSuccess(span);
  return { ...ctx.report(), cancellation_requested: true };
}
