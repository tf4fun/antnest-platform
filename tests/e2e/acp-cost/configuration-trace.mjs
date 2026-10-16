import assert from "node:assert/strict";
import { assertCostTraceSource } from "./trace-source.mjs";
import {
  inspectPrivateCommandTrace,
  requestTraceBoundary,
} from "../acp-commands/trace.mjs";
import {
  assertPrivateACPApplicationJoined,
  privateACPProcessIdentity,
} from "../observability/private-acp-diagnostics.mjs";
import { tag } from "../observability/trace-tree.mjs";

const normalize = (sql) => sql.replace(/\s+/gu, " ").trim();
const sessionRead =
  normalize(`SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
              client_mcp_revision_id,
              last_execution_revision, last_message_sequence, created_at, updated_at
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
              r.state,
              r.stop_reason
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
const listRead =
  normalize(`SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
              client_mcp_revision_id,
              last_execution_revision, last_message_sequence, created_at, updated_at
         FROM acp_sessions
        WHERE principal_id = $1
          AND agent_id = $2
          AND organization_id = $7
          AND state <> 'deleted'
          AND ($3::text IS NULL OR cwd = $3)
          AND ($4::timestamptz IS NULL OR (updated_at, id) < ($4, $5))
        ORDER BY updated_at DESC, id DESC
        LIMIT $6`);
const one = (spans, name) => {
  assert.equal(spans.length, 1, "missing or duplicate Cost " + name);
  return spans[0];
};
const text = (value) =>
  assert(typeof value === "string" && value.trim().length > 0);

function receipt(expected, listing) {
  const actual = listing ? expected.listReceipt : expected.configurationReceipt;
  assert(
    actual && typeof actual === "object",
    "actual Cost SDK receipt required",
  );
  assert.equal(
    actual.requestId,
    expected.requestId,
    "foreign Cost SDK request",
  );
  if (listing) {
    assert.deepEqual(actual.params, {});
    assert(Array.isArray(expected.listSessionIds));
    expected.listSessionIds.forEach(text);
    assert.equal(
      new Set(expected.listSessionIds).size,
      expected.listSessionIds.length,
    );
    assert(
      Array.isArray(actual.result?.sessions),
      "actual Cost Session list missing",
    );
    assert.equal(
      actual.result.nextCursor,
      undefined,
      "Cost Session list truncated",
    );
    const sessions = actual.result.sessions;
    for (const session of sessions) {
      text(session.sessionId);
      assert.equal(session.cwd, "/workspace");
      if (session.title !== undefined) text(session.title);
      assert(
        Number.isFinite(Date.parse(session.updatedAt)),
        "actual Session timestamp missing",
      );
    }
    const ids = sessions.map((session) => session.sessionId);
    assert.deepEqual([...ids].sort(), [...expected.listSessionIds].sort());
    return { list_read_only: true, list_session_ids: ids };
  }
  text(expected.modelSelection);
  assert.deepEqual(actual.params, {
    sessionId: expected.inputSessionID,
    configId: "model",
    value: expected.modelSelection,
    ...(expected.protocolVersion === 2 ? { type: "id" } : {}),
  });
  assert(Array.isArray(actual.result?.configOptions));
  const key = expected.protocolVersion === 1 ? "id" : "configId";
  const model = one(
    actual.result.configOptions.filter((option) => option[key] === "model"),
    "actual model option",
  );
  assert.equal(model.currentValue, expected.modelSelection);
  return { configuration_committed: true, selection: model.currentValue };
}

function before(trace, left, right, observations) {
  const leftEnd = left.startTime + left.duration;
  if (leftEnd <= right.startTime) return;
  assert.deepEqual(
    privateACPProcessIdentity(trace, left),
    privateACPProcessIdentity(trace, right),
  );
  const resource = Object.fromEntries(
    trace.processes[left.processID].tags.map(({ key, value }) => [key, value]),
  );
  assert.equal(
    resource["process.runtime.name"] ?? resource["telemetry.sdk.language"],
    "nodejs",
  );
  assert(
    [left, right].every(
      (span) =>
        Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
    ) && leftEnd - right.startTime < 1000,
    "Cost SQL order outside deferred same-Node sub-ms boundary",
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
    boundary: "cost-configuration-sql-order",
    raw_left_us: leftEnd,
    raw_right_us: right.startTime,
    raw_difference_us: leftEnd - right.startTime,
    raw_span_start_us: left.startTime,
    raw_next_start_us: right.startTime,
    reason: "deferred-same-node-sdk-sub-ms-endpoint",
  });
}

// Only the owning Cost configuration/list operations are admitted here. Run,
// replay, fork, initialization and pricing retain separate business oracles.
export function inspectPrivateCostConfigurationTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assertCostTraceSource(trace, expected.connectionTrace);
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.kind, "request");
  assert.equal(expected.outcome, "succeeded");
  assert.equal(expected.rejection, undefined);
  assert.equal(expected.rejectionReceipt, undefined);
  assert(
    ["session/set_config_option", "session/list"].includes(expected.method),
  );
  assert([1, 2].includes(expected.protocolVersion));
  assert.equal(expected.version, expected.protocolVersion);
  assert.deepEqual(requests, [], "nonexecution Cost request reached Provider");
  const listing = expected.method === "session/list";
  if (listing) {
    assert.equal(expected.protocolVersion, 1);
    assert.equal(expected.transport, "websocket");
    assert.equal(expected.inputSessionID, null);
    assert.equal(expected.sessionId, undefined);
  } else {
    text(expected.inputSessionID);
    assert.equal(expected.sessionId, expected.inputSessionID);
  }
  const sdk = receipt(expected, listing);
  const result = inspectPrivateCommandTrace(trace, expected, secrets, requests);
  const { tree, request, http } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  const observations = [...result.time_observations];
  for (const source of [trace, expected.connectionTrace])
    for (const span of source?.spans ?? []) {
      for (const fields of [
        span.tags ?? [],
        ...(span.logs ?? []).map((event) => event.fields ?? []),
      ])
        assert(
          !fields.some(({ key }) => key === "antnest.payload.json"),
          "Cost Trace captured payload",
        );
      assert(
        span.operationName !== "runtime.mcp.tool" &&
          tag(span, "rpc.method") !== "tools/call",
        "Cost configuration/list executed Tool",
      );
    }
  const applications = trace.spans.filter((span) =>
    span.operationName.startsWith("acp.session."),
  );
  const operation = listing
    ? "acp.session.list"
    : "acp.session.set_configuration";
  const application = one(
    applications.filter((span) => span.operationName === operation),
    "configuration/list application",
  );
  const outputs = applications.filter(
    (span) => span.operationName === "acp.session.output",
  );
  assert.equal(
    applications.length,
    1 + outputs.length,
    "unknown Cost application",
  );
  if (listing)
    assert.equal(outputs.length, 0, "list unexpectedly read Session output");
  else {
    assert(
      outputs.length > 0,
      "original pre-configuration output read missing",
    );
    const first = [...outputs].sort(
      (left, right) => left.startTime - right.startTime,
    )[0];
    before(trace, first, application, observations);
  }
  for (const owner of applications) {
    assert.equal(
      tree.parent(owner),
      request,
      "Cost application detached from RPC",
    );
    assert.equal(tag(owner, "span.kind"), "internal");
    for (const key of ["agent.id", "antnest.agent.id"])
      assert.equal(tag(owner, key), expected.agentId);
    for (const key of ["session.id", "antnest.session.id"])
      assert.equal(tag(owner, key), expected.inputSessionID ?? undefined);
    if (owner !== application)
      assert.equal(tag(owner, "antnest.operation.phase"), "read");
    assertPrivateACPApplicationJoined(
      trace,
      request,
      owner,
      observations,
      "cost-configuration-application-joined-by-rpc",
    );
  }
  const transactions = trace.spans.filter(
    (span) => span.operationName === "postgresql transaction",
  );
  const readiness = trace.spans.filter(
    (span) => span.operationName === "postgres.ready",
  );
  assert.equal(
    readiness.length,
    expected.transport === "http" ? 1 : 0,
    "wrong Cost HTTP readiness inventory",
  );
  if (readiness.length) {
    const ready = readiness[0];
    assert.equal(
      tree.parent(ready),
      http,
      "Cost readiness outside actual HTTP receiver",
    );
    assert.equal(tag(ready, "span.kind"), "internal");
    assert.equal(tag(ready, "db.system.name"), "postgresql");
    assert.equal(tag(ready, "db.query.text"), undefined);
    assertPrivateACPApplicationJoined(
      trace,
      http,
      ready,
      observations,
      "cost-configuration-readiness-joined-by-http",
    );
    before(
      trace,
      ready,
      [...applications].sort(
        (left, right) => left.startTime - right.startTime,
      )[0],
      observations,
    );
    const children = trace.spans.filter((span) => tree.parent(span) === ready);
    assert.equal(
      children.length,
      1,
      "incomplete or additional Cost readiness SQL",
    );
    assert.equal(normalize(tag(children[0], "db.query.text")), "SELECT 1");
  }
  let transaction;
  if (listing)
    assert.equal(transactions.length, 0, "list invented a transaction");
  else {
    transaction = one(transactions, "configuration transaction");
    assert.equal(tree.parent(transaction), application);
    assert.equal(tag(transaction, "span.kind"), "internal");
    assert.equal(tag(transaction, "db.system.name"), "postgresql");
    assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
    assertPrivateACPApplicationJoined(
      trace,
      application,
      transaction,
      observations,
      "cost-configuration-transaction-joined",
    );
  }
  const queries = trace.spans.filter(
    (span) =>
      span !== transaction &&
      !readiness.includes(span) &&
      span.tags?.some(({ key }) => key.startsWith("db.")),
  );
  const queryText = (span) => normalize(tag(span, "db.query.text"));
  for (const span of queries) {
    const sql = queryText(span);
    assert.equal(tag(span, "span.kind"), "client");
    assert.equal(tag(span, "db.system.name"), "postgresql");
    assert.equal(tag(span, "db.namespace"), "antnest_agent_acp");
    assert.equal(tag(span, "db.operation.name"), sql.split(" ", 1)[0]);
    const owner = tree.parent(span);
    assert(
      applications.includes(owner) ||
        owner === transaction ||
        readiness.includes(owner),
      "Cost SQL detached from its application/transaction",
    );
    if (configurationWrite.includes(sql)) assert.equal(owner, transaction);
    else
      assert.notEqual(
        owner,
        transaction,
        "unexpected SQL inside configuration transaction",
      );
    if (readiness.includes(owner)) assert.equal(sql, "SELECT 1");
    assertPrivateACPApplicationJoined(
      trace,
      owner,
      span,
      observations,
      "cost-configuration-sql-joined",
    );
  }
  if (listing) {
    assert.equal(queries.length, 1);
    assert.equal(
      queryText(queries[0]),
      listRead,
      "list is not the complete scoped SELECT",
    );
  } else {
    const expectedQueries = [
      sessionRead,
      configurationRead,
      ...configurationWrite,
    ];
    const configurationQueries = queries.filter((span) =>
      [application, transaction].includes(tree.parent(span)),
    );
    assert.equal(configurationQueries.length, expectedQueries.length);
    const ordered = expectedQueries.map((sql) =>
      one(
        configurationQueries.filter((span) => queryText(span) === sql),
        "owning configuration SQL",
      ),
    );
    for (let index = 1; index < ordered.length; index++)
      before(trace, ordered[index - 1], ordered[index], observations);
    for (const output of outputs) {
      const reads = queries.filter((span) => tree.parent(span) === output);
      assert.equal(reads.length, 4, "incomplete Cost output read");
      const sessionReads = reads
        .filter((span) => queryText(span) === sessionRead)
        .sort(
          (left, right) =>
            left.startTime - right.startTime || left.duration - right.duration,
        );
      assert.equal(sessionReads.length, 2);
      const sequence = [
        sessionReads[0],
        one(
          reads.filter((span) => queryText(span) === outputRead),
          "output SELECT",
        ),
        sessionReads[1],
        one(
          reads.filter((span) => queryText(span) === configurationRead),
          "output configuration SELECT",
        ),
      ];
      for (let index = 1; index < sequence.length; index++)
        before(trace, sequence[index - 1], sequence[index], observations);
    }
  }
  return {
    ...result,
    ...sdk,
    no_execution: true,
    input_session_id: expected.inputSessionID,
    database_queries: queries.length,
    http_readiness_checks: readiness.length,
    output_reads: outputs.length,
    time_observations: observations,
    // Query parameters are intentionally not exported by PostgreSQL telemetry.
    sql_parameters_observed: false,
  };
}
