import assert from "node:assert/strict";
import { assertCostTraceSource as assertTraceSource } from "../acp-cost/trace-source.mjs";
import {
  inspectPrivateCommandTrace,
  requestTraceBoundary,
} from "../acp-commands/trace.mjs";
import { assertPrivateACPApplicationJoined } from "../observability/private-acp-diagnostics.mjs";
import { tag } from "../observability/trace-tree.mjs";

const normalize = (sql) => sql.replace(/\s+/gu, " ").trim();
const sessionRead =
  normalize(`SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
  client_mcp_revision_id, last_execution_revision, last_message_sequence, created_at, updated_at
  FROM acp_sessions WHERE id = $1`);
const configurationRead =
  "SELECT configuration, configuration_revision FROM acp_sessions WHERE id = $1 AND state <> 'deleted'";
const outputRead =
  normalize(`SELECT s.last_message_sequence AS sequence, s.append_version, s.title, s.updated_at,
  COALESCE((SELECT jsonb_agg(
    CASE WHEN $3::boolean THEN jsonb_build_object(
      'sequence', m.sequence, 'runId', m.run_id, 'messageId', m.id, 'payload', m.payload
    ) ELSE m.payload END ORDER BY m.sequence)
    FROM session_messages m WHERE m.session_id = s.id AND m.visible
      AND m.sequence > COALESCE($2::bigint, s.last_message_sequence)), '[]'::jsonb) AS events,
  r.state, r.stop_reason
  FROM acp_sessions s
  LEFT JOIN LATERAL (SELECT state, stop_reason FROM runs
    WHERE session_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1) r ON true
  WHERE s.id = $1`);
const configurationWrite = [
  "BEGIN",
  "SET LOCAL lock_timeout = '5s'",
  "SET LOCAL statement_timeout = '10s'",
  `UPDATE acp_sessions SET configuration = $3::jsonb,
     configuration_revision = configuration_revision + 1,
     last_message_sequence = last_message_sequence + 1, updated_at = $4
   WHERE id = $1 AND configuration_revision = $2 AND state <> 'deleted'
   RETURNING last_message_sequence, configuration_revision`,
  `INSERT INTO session_messages(id, session_id, sequence, kind, visible, payload, created_at)
   VALUES ($1, $2, $3, 'configuration', true, $4::jsonb, $5)`,
  "COMMIT",
].map(normalize);
const one = (spans, label) => {
  assert.equal(spans.length, 1, "missing or duplicate Permissions " + label);
  return spans[0];
};
const text = (value) =>
  assert(typeof value === "string" && value.trim().length > 0);

function configurationReceipt(expected) {
  const actual = expected.requestReceipt;
  assert(
    actual && typeof actual === "object",
    "actual Permissions configuration receipt required",
  );
  assert.equal(
    actual.requestId,
    expected.requestId,
    "foreign configuration receipt",
  );
  const { configId, value } = expected.configuration ?? {};
  assert(
    ["mode", "model"].includes(configId),
    "unknown Permissions configuration",
  );
  text(value);
  assert.deepEqual(actual.params, {
    sessionId: expected.inputSessionID,
    configId,
    value,
    ...(expected.protocolVersion === 2 ? { type: "id" } : {}),
  });
  assert(Array.isArray(actual.result?.configOptions));
  const key = expected.protocolVersion === 1 ? "id" : "configId";
  const selected = one(
    actual.result.configOptions.filter((option) => option[key] === configId),
    "actual selected configuration",
  );
  assert.equal(selected.currentValue, value);
  // Other configuration options may change legitimately when a model changes.
  // Keep their original response; do not flatten grouped choices or thinking.
  return {
    configuration_committed: true,
    configuration_id: configId,
    selection: selected.currentValue,
  };
}

export function inspectPermissionConfigurationTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assertTraceSource(trace, expected.connectionTrace);
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert.equal(expected.kind, "request");
  assert.equal(expected.method, "session/set_config_option");
  assert.equal(expected.outcome, "succeeded");
  assert.equal(expected.rejection, undefined);
  assert.equal(expected.rejectionReceipt, undefined);
  assert([1, 2].includes(expected.protocolVersion));
  assert.equal(expected.version, expected.protocolVersion);
  text(expected.inputSessionID);
  assert.equal(expected.sessionId, expected.inputSessionID);
  assert.deepEqual(requests, [], "configuration reached Provider");
  const sdk = configurationReceipt(expected);
  const result = inspectPrivateCommandTrace(trace, expected, secrets, requests);
  const { tree, request } = requestTraceBoundary(trace, expected, secrets);
  const observations = [...result.time_observations];
  for (const source of [trace, expected.connectionTrace])
    for (const span of source?.spans ?? [])
      assert(
        ![
          "agent.run",
          "model.complete",
          "acp.permission.wait",
          "runtime.mcp.tool",
          "mcp.tools.call",
        ].includes(span.operationName) &&
          tag(span, "rpc.method") !== "tools/call",
        "configuration executed Run, model, approval or Tool",
      );

  const applications = trace.spans.filter((span) =>
    span.operationName.startsWith("acp.session."),
  );
  const application = one(
    applications.filter(
      (span) => span.operationName === "acp.session.set_configuration",
    ),
    "configuration application",
  );
  const outputs = applications.filter(
    (span) => span.operationName === "acp.session.output",
  );
  assert.equal(
    applications.length,
    1 + outputs.length,
    "unknown configuration application",
  );
  assert(outputs.length > 0, "original pre-configuration output read missing");
  assert(
    outputs.some((output) => output.startTime <= application.startTime),
    "configuration preceded its output read",
  );
  const joined = (span, owner, boundary) => {
    assert.equal(tree.service(span), "agent-acp-service");
    assert.equal(
      tree.parent(span),
      owner,
      "configuration work detached from owner",
    );
    assertPrivateACPApplicationJoined(
      trace,
      owner,
      span,
      observations,
      boundary,
    );
  };
  for (const owner of applications) {
    joined(
      owner,
      request,
      "permission-configuration-application-joined-by-rpc",
    );
    assert.equal(tag(owner, "span.kind"), "internal");
    for (const key of ["agent.id", "antnest.agent.id"])
      assert.equal(tag(owner, key), expected.agentId);
    for (const key of ["session.id", "antnest.session.id"])
      assert.equal(tag(owner, key), expected.sessionId);
    if (owner !== application)
      assert.equal(tag(owner, "antnest.operation.phase"), "read");
  }
  const transaction = one(
    trace.spans.filter(
      (span) => span.operationName === "postgresql transaction",
    ),
    "configuration transaction",
  );
  joined(
    transaction,
    application,
    "permission-configuration-transaction-joined",
  );
  assert.equal(tag(transaction, "span.kind"), "internal");
  assert.equal(tag(transaction, "db.system.name"), "postgresql");
  assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
  assert.equal(
    trace.spans.filter((span) => span.operationName === "postgres.ready")
      .length,
    0,
    "WS configuration invented HTTP readiness",
  );
  const queries = trace.spans.filter(
    (span) =>
      span !== transaction &&
      span.tags?.some(({ key }) => key.startsWith("db.")),
  );
  const queryText = (span) => normalize(tag(span, "db.query.text"));
  for (const span of queries) {
    const sql = queryText(span),
      owner = tree.parent(span);
    assert.equal(tag(span, "span.kind"), "client");
    assert.equal(tag(span, "db.system.name"), "postgresql");
    assert.equal(tag(span, "db.namespace"), "antnest_agent_acp");
    assert.equal(tag(span, "db.operation.name"), sql.split(" ", 1)[0]);
    assert.equal(span.operationName, tag(span, "db.operation.name"));
    assert(
      applications.includes(owner) || owner === transaction,
      "SQL outside configuration ownership",
    );
    assert.equal(
      configurationWrite.includes(sql),
      owner === transaction,
      "SQL belongs to another configuration scope",
    );
    joined(span, owner, "permission-configuration-sql-joined");
    assert(
      !trace.spans.some((child) => tree.parent(child) === span),
      "work hidden below SQL",
    );
  }
  const ordered = (rows, statements) => {
    assert.equal(
      rows.length,
      statements.length,
      "incomplete or extra configuration SQL",
    );
    const remaining = rows.toSorted((a, b) => a.startTime - b.startTime);
    const sequence = statements.map((sql) => {
      const index = remaining.findIndex((span) => queryText(span) === sql);
      assert(index >= 0, "missing original configuration SQL");
      return remaining.splice(index, 1)[0];
    });
    // Awaited statements may share an SDK millisecond start. Their original
    // enumeration is not an execution order, nor is an end/start overlap.
    assert(
      sequence.every(
        (span, index) =>
          index === 0 || sequence[index - 1].startTime <= span.startTime,
      ),
      "configuration statement starts out of order",
    );
    return sequence;
  };
  ordered(
    queries.filter((span) =>
      [application, transaction].includes(tree.parent(span)),
    ),
    [sessionRead, configurationRead, ...configurationWrite],
  );
  const outputSequences = outputs.map((output) =>
    ordered(
      queries.filter((span) => tree.parent(span) === output),
      [sessionRead, outputRead, sessionRead, configurationRead],
    ),
  );
  assert(
    outputSequences.some(
      (sequence) => sequence.at(-1).startTime <= application.startTime,
    ),
    "pre-configuration reads followed configuration mutation",
  );
  return {
    ...result,
    ...sdk,
    no_execution: true,
    input_session_id: expected.inputSessionID,
    database_queries: queries.length,
    output_reads: outputs.length,
    time_observations: observations,
    // PostgreSQL telemetry intentionally omits values and result rows. The
    // actual SDK receipt supplies the observed configuration projection.
    sql_parameters_observed: false,
  };
}
