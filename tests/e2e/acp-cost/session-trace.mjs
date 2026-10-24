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
import { inspectCatalogRuntime } from "../acp-plan/requests.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

const normalize = (sql) => sql.replace(/\s+/gu, " ").trim();
const sessionRead =
  normalize(`SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
  client_mcp_revision_id,
  last_execution_revision, last_message_sequence, created_at, updated_at
  FROM acp_sessions WHERE id = $1`);
const sessionLock = sessionRead + " FOR UPDATE";
const runGuard =
  normalize(`SELECT organization_id, agent_id, execution_owner_registration_id,
  execution_owner_member_id, execution_owner_incarnation_id,
  execution_owner_epoch::text
  FROM runs
  WHERE session_id = $1 AND
    (($2::text IS NULL AND state IN ('admitting', 'running')) OR id = $2)
  ORDER BY id FOR UPDATE`);
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
const mcpRead =
  "SELECT encrypted_sources, nonce FROM client_mcp_revisions WHERE id = $1";
const mcpInsert = normalize(`INSERT INTO client_mcp_revisions(
  id, session_id, revision, encrypted_sources, nonce, created_at
) VALUES ($1, $2, $3, $4, $5, $6)`);
const mcpPointer =
  "UPDATE acp_sessions SET client_mcp_revision_id = $2 WHERE id = $1";
const newQueries = [
  "BEGIN",
  `INSERT INTO acp_sessions(
    id, principal_id, agent_id, cwd, state,
    client_mcp_revision_id, created_at, updated_at, organization_id
  ) VALUES ($1, $2, $3, $4, 'active', NULL, $5, $5, $6)`,
  mcpInsert,
  mcpPointer,
  "COMMIT",
].map(normalize);
const replayQueries = ["BEGIN", sessionLock, runGuard, mcpRead, "COMMIT"];
const forkQueries = [
  "BEGIN",
  sessionLock,
  runGuard,
  `INSERT INTO acp_sessions(
    id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
    client_mcp_revision_id, last_execution_revision,
    last_message_sequence, created_at, updated_at, organization_id
  ) VALUES ($1, $2, $3, $4, 'active', $5, $6, NULL, $7, $8, $9, $9, $10)`,
  mcpInsert,
  `INSERT INTO session_messages(
    id, session_id, run_id, sequence, kind, visible, payload, created_at, context_excluded
  )
  SELECT copied_id,
    $2, NULL, sequence, kind, visible,
    CASE WHEN payload ? 'messageId'
      THEN jsonb_set( payload, '{messageId}', to_jsonb(copied_id), false )
      ELSE payload END,
    created_at, context_excluded
  FROM (
    SELECT *, 'message_' || substr(encode(sha256(
      convert_to('fork-message', 'UTF8') || decode('00', 'hex') ||
      convert_to($2 || ':' || sequence::text, 'UTF8')
    ), 'hex'), 1, 32) AS copied_id
    FROM session_messages WHERE session_id = $1 AND kind <> 'model_attempt'
  ) source ORDER BY sequence`,
  `INSERT INTO context_checkpoints(
    id, session_id, through_sequence, summary, token_count, created_at
  )
  SELECT 'checkpoint_' || substr(encode(sha256(
    convert_to('fork-checkpoint', 'UTF8') || decode('00', 'hex') ||
    convert_to($2 || ':' || through_sequence::text, 'UTF8')
  ), 'hex'), 1, 32),
  $2, through_sequence, summary, token_count, created_at
  FROM context_checkpoints WHERE session_id = $1`,
  `UPDATE acp_sessions SET configuration = source.configuration - 'toolRules'
    FROM acp_sessions source WHERE acp_sessions.id = $2 AND source.id = $1`,
  mcpPointer,
  "COMMIT",
].map(normalize);
const outputQueries = [sessionRead, outputRead, sessionRead, configurationRead];
const one = (spans, label) => {
  assert.equal(spans.length, 1, "missing or duplicate Cost Session " + label);
  return spans[0];
};
const nonempty = (value) =>
  assert(typeof value === "string" && value.trim().length > 0);
const end = (span) => {
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0 &&
      Number.isFinite(span.startTime + span.duration),
    "unfinished Cost Session span",
  );
  return span.startTime + span.duration;
};

function receipt(expected, creating, forking) {
  const actual = expected.requestReceipt;
  assert(actual && typeof actual === "object", "actual SDK receipt required");
  assert.equal(actual.requestId, expected.requestId, "foreign SDK receipt");
  assert.deepEqual(actual.params, {
    cwd: "/workspace",
    mcpServers: [],
    ...(!creating ? { sessionId: expected.inputSessionID } : {}),
    ...(expected.method === "session/resume"
      ? { replayFrom: { type: "start" } }
      : {}),
  });
  assert(actual.result && typeof actual.result === "object");
  if (creating || forking)
    assert.equal(actual.result.sessionId, expected.sessionId);
  assert(Array.isArray(actual.result.configOptions));
  const key = expected.protocolVersion === 1 ? "id" : "configId";
  const model = one(
    actual.result.configOptions.filter((option) => option[key] === "model"),
    "actual model option",
  );
  nonempty(model.currentValue);
  return model.currentValue;
}

// Only the successful new/replay/fork operations exercised by Cost belong here.
// Its replay uses an active Session and unchanged empty client MCP sources.
export function inspectPrivateCostSessionTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  // Check before assertions can render private receipt fields in diagnostics.
  assertSecretFree(JSON.stringify(expected.requestReceipt) ?? "", secrets);
  assertCostTraceSource(trace, expected.connectionTrace);
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.kind, "request");
  assert.equal(expected.outcome, "succeeded");
  assert.equal(expected.rejection, undefined);
  assert.equal(expected.rejectionReceipt, undefined);
  assert([1, 2].includes(expected.protocolVersion));
  assert.equal(expected.version, expected.protocolVersion);
  assert(
    [
      "session/new",
      "session/fork",
      expected.protocolVersion === 1 ? "session/load" : "session/resume",
    ].includes(expected.method),
  );
  assert.deepEqual(requests, [], "nonexecution Cost Session reached Provider");
  const creating = expected.method === "session/new";
  const forking = expected.method === "session/fork";
  nonempty(expected.sessionId);
  if (creating) assert.equal(expected.inputSessionID, null);
  else {
    nonempty(expected.inputSessionID);
    if (forking) assert.notEqual(expected.inputSessionID, expected.sessionId);
    else assert.equal(expected.inputSessionID, expected.sessionId);
  }
  const modelSelection = receipt(expected, creating, forking);
  const result = inspectPrivateCommandTrace(trace, expected, secrets, requests);
  const { tree, request, http, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  const catalog = inspectCatalogRuntime(trace, tree, request, expected);
  const observations = [...result.time_observations];
  const same = (left, right) => {
    assert.equal(tree.service(left), "agent-acp-service");
    assert.deepEqual(
      privateACPProcessIdentity(trace, left),
      privateACPProcessIdentity(trace, right),
    );
  };
  const before = (left, right, boundary) => {
    const leftEnd = end(left);
    end(right);
    same(left, right);
    if (leftEnd <= right.startTime) return;
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
      ) && leftEnd - right.startTime < 1000,
      "Cost Session order outside deferred same-Node sub-ms boundary",
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
      boundary,
      raw_left_us: leftEnd,
      raw_right_us: right.startTime,
      raw_difference_us: leftEnd - right.startTime,
      raw_span_start_us: left.startTime,
      raw_next_start_us: right.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  };
  const joined = (span, owner, boundary) => {
    same(span, owner);
    end(span);
    end(owner);
    assertPrivateACPApplicationJoined(
      trace,
      owner,
      span,
      observations,
      boundary,
    );
  };
  for (const source of [trace, expected.connectionTrace])
    for (const span of source?.spans ?? []) {
      assert(
        !["agent.run", "runtime.mcp.tool"].includes(span.operationName) &&
          tag(span, "rpc.method") !== "tools/call",
        "Cost Session unexpectedly executed a Run or Tool",
      );
      for (const fields of [
        span.tags ?? [],
        ...(span.logs ?? []).map((event) => event.fields ?? []),
      ])
        assert(
          !fields.some(({ key }) => key === "antnest.payload.json"),
          "Cost Session Trace captured payload",
        );
    }
  const named = (name) =>
    trace.spans.filter((span) => span.operationName === name);
  const application = one(
    named(`acp.session.${creating ? "new" : forking ? "fork" : "resume"}`),
    "application",
  );
  const configuration = one(
    named("acp.session.get_configuration"),
    "configuration",
  );
  const outputs = named("acp.session.output");
  assert(outputs.length > 0, "Cost Session initial output subtree missing");
  const applications = [application, configuration, ...outputs];
  assert.equal(
    trace.spans.filter((span) => span.operationName.startsWith("acp.session."))
      .length,
    applications.length,
    "unknown Cost Session application",
  );
  const asynchronousOutput = [];
  for (const span of applications) {
    assert.equal(
      tree.parent(span),
      request,
      "Cost Session application detached from RPC",
    );
    same(span, request);
    end(span);
    assert.equal(tag(span, "span.kind"), "internal");
    for (const key of ["agent.id", "antnest.agent.id"])
      assert.equal(tag(span, key), expected.agentId);
    for (const key of ["session.id", "antnest.session.id"])
      assert.equal(
        tag(span, key),
        span === application
          ? (expected.inputSessionID ?? undefined)
          : expected.sessionId,
      );
    if (!outputs.includes(span))
      joined(span, request, "cost-session-application-joined-by-rpc");
    else {
      assert.equal(tag(span, "antnest.operation.phase"), "read");
      assert(span.startTime >= request.startTime);
      // Output invalidations retain the original asynchronous subscription context.
      if (end(span) > end(request))
        asynchronousOutput.push({
          trace_id: trace.traceID,
          span_id: span.spanID,
          parent_span_id: request.spanID,
          output_start_us: span.startTime,
          output_end_us: end(span),
          parent_end_us: end(request),
        });
      before(application, span, "cost-session-mutation-before-output");
    }
  }
  const orderedOutputs = [...outputs].sort(
    (left, right) => left.startTime - right.startTime,
  );
  const requiredOutputs =
    expected.protocolVersion === 2 && (creating || forking) ? 2 : 1;
  assert(
    orderedOutputs.length >= requiredOutputs,
    "Cost Session required output read missing",
  );
  for (let index = 0; index < requiredOutputs; index++) {
    const output = orderedOutputs[index];
    joined(output, request, "cost-session-initial-output-joined-by-rpc");
    before(
      output,
      configuration,
      "cost-session-initial-output-before-configuration",
    );
    if (index > 0)
      before(
        orderedOutputs[index - 1],
        output,
        "cost-session-prepare-before-subscription-output",
      );
  }
  for (const read of named("mcp.runtime.info.read")) {
    assert.equal(
      expected.protocolVersion,
      1,
      "Cost v2 invented a Skill catalog refresh",
    );
    joined(read, request, "cost-session-catalog-joined-by-rpc");
    before(configuration, read, "cost-session-configuration-before-catalog");
  }

  const transaction = one(named("postgresql transaction"), "transaction");
  assert.equal(tree.parent(transaction), application);
  assert.equal(tag(transaction, "span.kind"), "internal");
  assert.equal(tag(transaction, "db.system.name"), "postgresql");
  assert.equal(tag(transaction, "db.query.text"), undefined);
  assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
  joined(transaction, application, "cost-session-transaction-joined");
  const ownedSQL = new Set();
  const database = (span) =>
    span.tags?.some(({ key }) => key.startsWith("db."));
  const sql = (span) => normalize(tag(span, "db.query.text") ?? "");
  const sequence = (owner, expectedQueries) => {
    const queries = trace.spans.filter(
      (span) =>
        tree.parent(span) === owner && span !== transaction && database(span),
    );
    assert.equal(
      queries.length,
      expectedQueries.length,
      "incomplete or extra Cost Session SQL",
    );
    const used = new Set();
    const ordered = expectedQueries.map((statement) => {
      const matches = queries
        .filter((span) => !used.has(span) && sql(span) === statement)
        .sort(
          (left, right) =>
            left.startTime - right.startTime || left.duration - right.duration,
        );
      assert(
        matches.length > 0,
        "complete Cost Session SQL missing: " + statement,
      );
      const span = matches[0];
      used.add(span);
      ownedSQL.add(span);
      assert.equal(tag(span, "span.kind"), "client");
      assert.equal(tag(span, "db.system.name"), "postgresql");
      assert.equal(tag(span, "db.namespace"), "antnest_agent_acp");
      assert.equal(tag(span, "db.operation.name"), statement.split(" ", 1)[0]);
      joined(span, owner, "cost-session-sql-joined");
      return span;
    });
    for (let index = 1; index < ordered.length; index++)
      before(ordered[index - 1], ordered[index], "cost-session-sql-order");
    return ordered;
  };
  sequence(
    transaction,
    creating ? newQueries : forking ? forkQueries : replayQueries,
  );
  const direct = sequence(
    application,
    creating ? [] : forking ? [sessionRead] : [sessionRead, outputRead],
  );
  if (!creating)
    before(
      direct[0],
      transaction,
      "cost-session-authorization-before-transaction",
    );
  if (!creating && !forking)
    before(transaction, direct[1], "cost-session-replay-after-transaction");
  sequence(configuration, [sessionRead, configurationRead]);
  for (const output of outputs) sequence(output, outputQueries);
  const readiness = named("postgres.ready");
  assert.equal(readiness.length, expected.transport === "http" ? 1 : 0);
  if (readiness.length) {
    const ready = readiness[0];
    assert.equal(
      tree.parent(ready),
      http,
      "Cost Session readiness outside actual HTTP receiver",
    );
    assert.equal(tag(ready, "span.kind"), "internal");
    assert.equal(tag(ready, "db.system.name"), "postgresql");
    assert.equal(tag(ready, "db.query.text"), undefined);
    joined(ready, http, "cost-session-readiness-joined-by-http");
    before(ready, application, "cost-session-http-ready-before-application");
    sequence(ready, ["SELECT 1"]);
  }
  for (const span of trace.spans.filter(database))
    assert(
      ownedSQL.has(span) || span === transaction || readiness.includes(span),
      "unowned Cost Session database work",
    );
  for (const span of trace.spans.filter(
    (span) => tag(span, "span.kind") === "client",
  ))
    assert(
      ownedSQL.has(span) ||
        catalog.spans.has(span) ||
        (expected.transport === "http" && span === forwarded),
      "unowned successful Cost Session CLIENT work",
    );
  return {
    ...result,
    no_execution: true,
    input_session_id: expected.inputSessionID,
    session_transactions: 1,
    model_selection: modelSelection,
    database_queries: ownedSQL.size,
    http_readiness_checks: readiness.length,
    output_reads: outputs.length,
    asynchronous_output_reads: asynchronousOutput,
    ...(!creating && !forking ? { replay_writes: 0 } : {}),
    time_observations: observations,
    // PostgreSQL does not export query parameters or prove copied row counts.
    sql_parameters_observed: false,
  };
}
