import assert from "node:assert/strict";
import { assertCostTraceSource } from "./trace-source.mjs";
import { requestTraceBoundary } from "../acp-commands/trace.mjs";
import { timingEvidence } from "../acp-plan/requests.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { inspectRunInformationReads } from "../observability/runtime-information-run.mjs";
import {
  privateACPDiagnosticView,
  privateACPProcessIdentity,
  assertPrivateACPApplicationJoined,
} from "../observability/private-acp-diagnostics.mjs";
import { tag } from "../observability/trace-tree.mjs";

const normalize = (sql) => sql.replace(/\s+/gu, " ").trim();
const appendQueries = new Map(
  [
    "BEGIN",
    "COMMIT",
    "SELECT session_id FROM runs WHERE id = $1",
    "SELECT last_message_sequence, organization_id, agent_id FROM acp_sessions WHERE id = $1 FOR UPDATE",
    `SELECT session_id, state, organization_id, agent_id, execution_owner_registration_id,
      execution_owner_member_id, execution_owner_incarnation_id, execution_owner_epoch::text
     FROM runs WHERE id = $1 FOR UPDATE`,
    "SELECT run_id, session_id, kind, visible, payload, created_at FROM session_messages WHERE id = $1",
    `INSERT INTO session_messages(
       id, session_id, run_id, sequence, kind, visible, payload, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    "UPDATE acp_sessions SET last_message_sequence = $2, updated_at = $3 WHERE id = $1",
  ].map((sql) => [normalize(sql), sql.trim().split(/\s/u, 1)[0]]),
);
const outputQueries = new Map(
  [
    `SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,
              client_mcp_revision_id,
              last_execution_revision, last_message_sequence, created_at, updated_at
         FROM acp_sessions WHERE id = $1`,
    `SELECT s.last_message_sequence AS sequence, s.append_version, s.title, s.updated_at,
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
        WHERE s.id = $1`,
    "SELECT configuration, configuration_revision FROM acp_sessions WHERE id = $1 AND state <> 'deleted'",
  ].map((sql) => [normalize(sql), sql.trim().split(/\s/u, 1)[0]]),
);
const finishQuery = normalize(`WITH finished AS (UPDATE runs
          SET state = $2, terminal_class = $2, executor_state = $3,
              tool_effect_state = $4, unknown_effect_source = $5,
              stop_reason = $6, error_class = $7, updated_at = $8
        WHERE id = $1 AND state = 'running' RETURNING id, session_id),
       refused_messages AS (
         UPDATE session_messages SET context_excluded = true
         FROM finished WHERE session_messages.session_id = finished.session_id
           AND session_messages.run_id = finished.id AND $6 = 'refusal'
         RETURNING session_messages.session_id, session_messages.sequence
       ),
       invalidated_checkpoints AS (
         DELETE FROM context_checkpoints USING refused_messages
         WHERE context_checkpoints.session_id = refused_messages.session_id
           AND context_checkpoints.through_sequence >= refused_messages.sequence
       ),
       cancelled_permissions AS (
         UPDATE tool_permissions SET decision = 'cancelled', reason = 'run_finished', decided_at = $8
         FROM finished WHERE tool_permissions.run_id = finished.id AND decision IS NULL
        ) SELECT id FROM finished`);

const replyQueries = [...appendQueries.keys()]
  .filter((sql) => sql !== "COMMIT")
  .concat("COMMIT");
const usageQueries = [
  ...replyQueries.slice(0, 5),
  "SELECT payload FROM session_messages WHERE session_id = $1 AND kind = 'usage' ORDER BY sequence DESC LIMIT 1",
  ...replyQueries.slice(5),
];
const [sessionRead, outputRead, configurationRead] = [...outputQueries.keys()];
const outputSequence = [
  sessionRead,
  outputRead,
  sessionRead,
  configurationRead,
];
const mcpRevisionRead =
  "SELECT encrypted_sources, nonce FROM client_mcp_revisions WHERE id = $1";
const temporaryReference = `t.run_id,t.organization_id,t.agent_id,t.execution_id,t.mcp_endpoint,
  r.execution_snapshot->'runtime'->>'revision' AS runtime_revision,
  r.execution_snapshot->'runtime'->>'connectionId' AS connection_id`;
const temporaryAgentRead = normalize(
  `SELECT ${temporaryReference} FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id WHERE t.organization_id=$1 AND t.agent_id=$2 AND t.released_at IS NULL ORDER BY t.run_id`,
);
const temporaryRunRead = normalize(
  `SELECT ${temporaryReference} FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id WHERE t.run_id=$1 AND t.released_at IS NULL`,
);
const admissionQueries = [
  sessionRead,
  mcpRevisionRead,
  temporaryAgentRead,
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
const intentQueries = [
  "BEGIN",
  `SELECT organization_id, agent_id, state, client_mcp_revision_id, configuration, append_version
             FROM acp_sessions WHERE id = $1 FOR UPDATE`,
  "SELECT id FROM runs WHERE session_id = $1 AND state IN ('admitting', 'running') LIMIT 1",
  `INSERT INTO runs(
             id, request_id, session_id, client_mcp_revision_id,
             expected_access_revision, state,
             pending_user_message_id, input_prompt,
             created_at, updated_at, session_configuration,
             bridge_intent_id, intent_digest, expected_append_version, append_version,
             organization_id, agent_id,
             execution_owner_registration_id, execution_owner_member_id,
             execution_owner_incarnation_id, execution_owner_epoch
           ) VALUES ($1, $2, $3, $4, $5, 'admitting', $6, $7::jsonb, $8, $8, $9::jsonb,
                     $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::bigint)
           RETURNING id, request_id, session_id, client_mcp_revision_id,
                     expected_access_revision, state,
                     pending_user_message_id, session_configuration`,
  "UPDATE acp_sessions SET append_version = $2 WHERE id = $1",
  "COMMIT",
].map(normalize);
const environmentInsert = normalize(`INSERT INTO session_messages(
       id, session_id, run_id, sequence, kind, visible, payload, created_at
     )
     SELECT $1, session_id, id, $2, 'environment_change', false, $3::jsonb, $4
       FROM runs WHERE id = $5`);
const acceptanceQueries = [
  "BEGIN",
  "SELECT session_id FROM runs WHERE id = $1",
  `SELECT organization_id, agent_id, state, last_message_sequence
         FROM acp_sessions WHERE id = $1 FOR UPDATE`,
  `SELECT session_id, organization_id, agent_id, client_mcp_revision_id, state,
              cancel_requested_at, pending_user_message_id,
              jsonb_typeof(input_prompt) = 'array' AS prompt_is_array,
              execution_owner_registration_id, execution_owner_member_id,
              execution_owner_incarnation_id, execution_owner_epoch::text
         FROM runs WHERE id = $1 FOR UPDATE`,
  `INSERT INTO session_messages(
           id, session_id, run_id, sequence, kind, visible, payload, created_at
         ) SELECT pending_user_message_id, session_id, id, $2, 'user_message', true,
                  jsonb_build_object('kind', 'user_message',
                    'messageId', pending_user_message_id, 'content', input_prompt), $3
             FROM runs WHERE id = $1`,
  `UPDATE runs
            SET state = 'running', execution_snapshot = $2::jsonb, deadline_at = $3,
                pending_user_message_id = NULL, updated_at = $4
          WHERE id = $1`,
  `UPDATE acp_sessions
            SET last_execution_revision = $2, last_message_sequence = $3,
                title = COALESCE(title, $5), updated_at = $4
          WHERE id = $1`,
  "COMMIT",
].map(normalize);
const contextQueries = [
  `SELECT through_sequence, summary
         FROM context_checkpoints
        WHERE session_id = $1
        ORDER BY through_sequence DESC
        LIMIT 1`,
  `SELECT sequence, kind, payload
         FROM session_messages
        WHERE session_id = $1
          AND sequence > $2
          AND NOT context_excluded
          AND kind IN ('user_message', 'agent_message', 'agent_thought', 'environment_change', 'tool_call')
        ORDER BY sequence`,
  "SELECT payload FROM session_messages WHERE session_id = $1 AND kind = 'plan' AND NOT context_excluded ORDER BY sequence DESC LIMIT 1",
].map(normalize);
const checkpointInsert = normalize(`INSERT INTO context_checkpoints(
         id, session_id, through_sequence, summary, token_count, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id, through_sequence) DO NOTHING`);
const unknownModel = new Set([
  "unpriced",
  "unpriced-again",
  "fresh-unknown",
  "restored-unpriced",
]);
const phases = new Set([
  ...unknownModel,
  "estimated",
  "reported",
  "zero",
  "cache",
  "current-default",
  "selected",
  "fork",
  "post-restart",
  "restored-fork",
  "free",
  "cache-fallback",
  "observer",
  "admission",
  "after-admission",
]);
const one = (spans, label) => {
  assert.equal(spans.length, 1, "missing or duplicate Cost " + label);
  return spans[0];
};
const text = (value) => assert(typeof value === "string" && value.length > 0);
const end = (span) => {
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
  );
  assert(Number.isFinite(span.startTime + span.duration));
  return span.startTime + span.duration;
};

function promptReceipt(expected) {
  const receipt = expected.promptReceipt;
  assert(
    receipt && typeof receipt === "object",
    "actual Cost SDK prompt receipt required",
  );
  assert.equal(receipt.requestId, expected.requestId);
  assert.equal(receipt.sessionId, expected.sessionId);
  assert.equal(receipt.error, null);
  if (expected.protocolVersion === 1) {
    assert.deepEqual(receipt.result, { stopReason: "end_turn" });
    assert.deepEqual(receipt.terminals, []);
  } else {
    assert.deepEqual(Object.keys(receipt.result ?? {}), ["messageId"]);
    text(receipt.result.messageId);
    assert.deepEqual(receipt.terminals, [
      {
        sessionId: expected.sessionId,
        update: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        },
      },
    ]);
  }
}

export function inspectPrivateCostRunTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assertCostTraceSource(trace, expected.connectionTrace);
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.kind, "native");
  assert.equal(expected.method, "session/prompt");
  assert.equal(expected.outcome, "succeeded");
  assert.equal(expected.rejection, undefined);
  assert.notEqual(expected.closedBeforeResponse, true);
  assert([1, 2].includes(expected.protocolVersion));
  assert.equal(expected.version, expected.protocolVersion);
  text(expected.inputSessionID);
  assert.equal(expected.inputSessionID, expected.sessionId);
  const match = /^v([12])-(ws|http):([a-z-]+)$/u.exec(expected.phase ?? "");
  assert(match && phases.has(match[3]), "unknown Cost phase");
  assert.equal(Number(match[1]), expected.protocolVersion);
  assert.equal(match[2], expected.transport === "http" ? "http" : "ws");
  const modelName = unknownModel.has(match[3])
    ? "unknown-model"
    : "priced-model";
  assert(Array.isArray(requests));
  assert.equal(requests.length, 1, "one actual Cost Provider receipt required");
  promptReceipt(expected);
  for (const source of [trace, expected.connectionTrace])
    for (const span of source?.spans ?? [])
      for (const fields of [
        span.tags ?? [],
        ...(span.logs ?? []).map((event) => event.fields ?? []),
      ])
        assert(
          !fields.some(({ key }) => key === "antnest.payload.json"),
          "Cost Trace captured payload",
        );
  const { tree, request, forwarded, http } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  const named = (name) =>
    trace.spans.filter((span) => span.operationName === name);
  const run = one(named("agent.run"), "Run");
  const runID = tag(run, "antnest.run.id"),
    runRequestID = tag(run, "antnest.request.id");
  text(runID);
  text(runRequestID); // Persisted Run intent ID is independent of its wire RPC ID.
  assert(tree.chain(run).includes(request), "Cost Run detached from prompt");
  // The executor emits Run/Session identity; its Agent comes from the checked
  // RPC -> admission -> Run parent chain below. Reject contradictory aliases
  // if present without inventing a duplicate field on the production span.
  for (const key of ["agent.id", "antnest.agent.id"])
    if (tag(run, key) !== undefined)
      assert.equal(tag(run, key), expected.agentId);
  assert.equal(tag(run, "antnest.session.id"), expected.sessionId);
  for (const [key, value] of Object.entries({
    "span.kind": "internal",
    "run.terminal_class": "completed",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": "none",
    "antnest.operation.phase": "execute",
    "antnest.outcome": "ok",
  }))
    assert.equal(tag(run, key), value);
  assert.equal(tag(run, "run.unknown_effect_source"), undefined);
  for (const span of trace.spans) {
    assert(
      !["mcp.tools.call", "runtime.mcp.tool"].includes(span.operationName) &&
        tag(span, "rpc.method") !== "tools/call",
      "Cost Run executed Tool",
    );
    assert(
      !(
        tree.chain(span).includes(run) &&
        ["agent-controller", "identity-service"].includes(tree.service(span))
      ),
      "Cost Run called management service",
    );
  }
  const information = inspectRunInformationReads(trace, {
    request,
    run,
    postPromptRequestOutcome: "success",
  });
  const observations = [...information.timeObservations];
  const same = (left, right) =>
    assert.deepEqual(
      privateACPProcessIdentity(trace, left),
      privateACPProcessIdentity(trace, right),
      "foreign Cost process",
    );
  const before = (leftSpan, rightSpan, left, right, boundary) => {
    assert(Number.isFinite(left) && Number.isFinite(right));
    if (left <= right) return;
    same(leftSpan, rightSpan);
    const attributes = trace.processes[leftSpan.processID].tags;
    const resource = Object.fromEntries(
      attributes.map(({ key, value }) => [key, value]),
    );
    assert.equal(Object.keys(resource).length, attributes.length);
    assert.equal(
      resource["process.runtime.name"] ?? resource["telemetry.sdk.language"],
      "nodejs",
    );
    if (resource["telemetry.sdk.language"] !== undefined)
      assert.equal(resource["telemetry.sdk.language"], "nodejs");
    if (resource["telemetry.sdk.name"] !== undefined)
      assert.equal(resource["telemetry.sdk.name"], "opentelemetry");
    assert(
      [leftSpan, rightSpan].every(
        (span) =>
          Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
      ) && left - right < 1000,
      "Cost order outside deferred same-Node sub-ms boundary",
    );
    const [host, pid, instance] = privateACPProcessIdentity(trace, leftSpan);
    observations.push({
      trace_id: trace.traceID,
      span_id: leftSpan.spanID,
      next_span_id: rightSpan.spanID,
      process_id: leftSpan.processID,
      host_name: host,
      process_pid: pid,
      service_instance_id: instance,
      boundary,
      raw_left_us: left,
      raw_right_us: right,
      raw_difference_us: left - right,
      raw_span_start_us: leftSpan.startTime,
      raw_next_start_us: rightSpan.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  };
  const joined = (span, owner, boundary) => {
    same(span, owner);
    assert(span.startTime >= owner.startTime);
    before(span, owner, end(span), end(owner), boundary);
  };
  same(run, request);
  end(run);
  const admission = one(named("acp.session.prompt"), "prompt admission");
  assert.equal(tree.parent(admission), request);
  assert.equal(tree.parent(run), admission, "Cost Run bypassed admission");
  for (const [key, value] of Object.entries({
    "span.kind": "internal",
    "agent.id": expected.agentId,
    "antnest.agent.id": expected.agentId,
    "session.id": expected.sessionId,
    "antnest.session.id": expected.sessionId,
    "antnest.operation.phase": "admit",
  }))
    assert.equal(tag(admission, key), value);
  assertPrivateACPApplicationJoined(
    trace,
    request,
    admission,
    observations,
    "cost-admission-joined-by-rpc",
  );
  // RunSupervisor starts the executor in this admission context. Execution and
  // its completion notification can outlive acceptPrompt without reparenting.
  assert(run.startTime >= admission.startTime);
  if (expected.protocolVersion === 1)
    assertPrivateACPApplicationJoined(
      trace,
      request,
      run,
      observations,
      "cost-run-joined-by-v1-rpc",
    );
  const model = one(named("model.complete"), "model attempt");
  assert.equal(tree.parent(model), run);
  assert.equal(tag(model, "span.kind"), "internal");
  assert.equal(tag(model, "model.purpose"), "response");
  assert.equal(tag(model, "model.name"), modelName);
  joined(model, run, "cost-model-joined-by-run");
  for (const prep of information.prepared)
    before(
      prep,
      model,
      end(prep),
      model.startTime,
      "cost-runtime-preparation-before-model",
    );
  const finish = one(
    trace.spans.filter((span) =>
      /WITH finished AS \(UPDATE runs\b/u.test(
        normalize(tag(span, "db.query.text") ?? ""),
      ),
    ),
    "durable Run finish",
  );
  assert.equal(tree.parent(finish), run);
  assert.equal(
    normalize(tag(finish, "db.query.text")),
    finishQuery,
    "not the complete atomic finish CTE",
  );
  for (const [key, value] of Object.entries({
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.namespace": "antnest_agent_acp",
    "db.operation.name": "SELECT",
  }))
    assert.equal(tag(finish, key), value);
  joined(finish, run, "cost-finish-joined-by-run");
  before(
    model,
    finish,
    end(model),
    finish.startTime,
    "cost-model-before-finish",
  );
  const provider = one(named("HTTP POST model"), "Provider span");
  assert.deepEqual(requests[0], {
    phase: expected.phase,
    model: modelName,
    trace_id: trace.traceID,
    model_span_id: provider.spanID,
  });
  assert.equal(tree.parent(provider), model);
  for (const [key, value] of Object.entries({
    "span.kind": "client",
    "http.request.method": "POST",
    "http.response.status_code": 200,
  }))
    assert.equal(tag(provider, key), value);
  assert(
    !provider.tags.some(({ key }) => key.startsWith("db.")),
    "Provider borrowed SQL identity",
  );
  joined(provider, model, "cost-provider-joined-by-model");

  const transactions = named("postgresql transaction");
  const sql = (span) => normalize(tag(span, "db.query.text") ?? "");
  const database = (span) =>
    span.tags?.some(({ key }) => key.startsWith("db."));
  const queriesUnder = (owner) =>
    trace.spans.filter(
      (span) =>
        tree.parent(span) === owner &&
        (tag(span, "db.query.text") !== undefined ||
          (tag(span, "span.kind") === "client" && database(span))),
    );
  const intent = one(
    transactions.filter(
      (span) =>
        tree.parent(span) === admission &&
        queriesUnder(span).some((query) => sql(query) === intentQueries[3]),
    ),
    "intent transaction",
  );
  const acceptance = one(
    transactions.filter(
      (span) =>
        tree.parent(span) === admission &&
        queriesUnder(span).some((query) => sql(query) === acceptanceQueries[4]),
    ),
    "acceptance transaction",
  );
  const reply = one(
    transactions.filter((span) => tree.chain(span).includes(model)),
    "reply transaction",
  );
  const usage = one(
    transactions.filter(
      (span) =>
        tree.chain(span).includes(run) && !tree.chain(span).includes(model),
    ),
    "usage transaction",
  );
  const ownedSQL = new Set();
  const sequence = (owner, expectedQueries) => {
    const actual = queriesUnder(owner);
    assert.equal(
      actual.length,
      expectedQueries.length,
      "incomplete or additional Cost SQL",
    );
    assert.deepEqual(
      actual.map(sql).sort(),
      [...expectedQueries].sort(),
      "wrong owning Cost SQL",
    );
    const remaining = [...actual].sort(
      (left, right) =>
        left.startTime - right.startTime || left.duration - right.duration,
    );
    const ordered = expectedQueries.map(
      (query) =>
        remaining.splice(
          remaining.findIndex((span) => sql(span) === query),
          1,
        )[0],
    );
    for (const span of actual) {
      same(span, owner);
      assert.equal(tag(span, "span.kind"), "client");
      assert.equal(tag(span, "db.system.name"), "postgresql");
      assert.equal(tag(span, "db.namespace"), "antnest_agent_acp");
      assert.equal(
        span.operationName,
        sql(span) === finishQuery ? "SELECT" : sql(span).split(" ", 1)[0],
      );
      assert.equal(tag(span, "db.operation.name"), span.operationName);
      assert(
        !span.tags.some(({ key }) => /^(?:http|rpc)\./u.test(key)),
        "SQL borrowed transport identity",
      );
      joined(span, owner, "cost-sql-joined-by-owner");
      ownedSQL.add(span);
    }
    for (let index = 1; index < ordered.length; index++)
      before(
        ordered[index - 1],
        ordered[index],
        end(ordered[index - 1]),
        ordered[index].startTime,
        "cost-sql-order",
      );
    return ordered;
  };
  const acceptedQueries = [...acceptanceQueries];
  const environmentFacts = queriesUnder(acceptance).filter(
    (span) => sql(span) === environmentInsert,
  );
  assert(environmentFacts.length <= 1, "duplicate Cost environment fact");
  if (environmentFacts.length) acceptedQueries.splice(4, 0, environmentInsert);
  const ownedTransactions = new Set([intent, acceptance, reply, usage]);
  assert.equal(
    transactions.length,
    ownedTransactions.size,
    "unexpected Cost transaction",
  );
  for (const [transaction, owner, queries] of [
    [intent, admission, intentQueries],
    [acceptance, admission, acceptedQueries],
    [reply, model, replyQueries],
    [usage, run, usageQueries],
  ]) {
    assert.equal(
      tree.parent(transaction),
      owner,
      "Cost transaction has wrong owning span",
    );
    for (const [key, value] of Object.entries({
      "span.kind": "internal",
      "db.system.name": "postgresql",
      "antnest.transaction.outcome": "committed",
    }))
      assert.equal(tag(transaction, key), value);
    joined(transaction, owner, "cost-transaction-joined-by-owner");
    sequence(transaction, queries);
  }
  const admissionReads = sequence(admission, admissionQueries);
  before(
    admissionReads.at(-1),
    intent,
    end(admissionReads.at(-1)),
    intent.startTime,
    "cost-protection-before-intent",
  );
  before(
    intent,
    acceptance,
    end(intent),
    acceptance.startTime,
    "cost-intent-before-acceptance",
  );
  before(
    acceptance,
    run,
    end(acceptance),
    run.startTime,
    "cost-acceptance-before-run",
  );
  const checkpoints = queriesUnder(run).filter(
    (span) => sql(span) === checkpointInsert,
  );
  assert(checkpoints.length <= 1, "duplicate Cost context checkpoint");
  const runQueries = [
    ...contextQueries,
    ...(checkpoints.length ? [checkpointInsert] : []),
    temporaryRunRead,
    finishQuery,
  ];
  const runSQL = sequence(run, runQueries);
  for (const prep of information.prepared)
    before(
      prep,
      runSQL[0],
      end(prep),
      runSQL[0].startTime,
      "cost-preparation-before-context",
    );
  const contextEnd = runSQL.at(-3);
  before(
    contextEnd,
    model,
    end(contextEnd),
    model.startTime,
    "cost-context-before-model",
  );
  const catalog = one(
    information.prepared.filter(
      (span) => span.operationName === "mcp.tools.list",
    ),
    "tool catalog preparation",
  );
  sequence(catalog, [mcpRevisionRead]);
  before(
    usage,
    runSQL.at(-2),
    end(usage),
    runSQL.at(-2).startTime,
    "cost-usage-before-temporary-cleanup",
  );
  const readiness = named("postgres.ready");
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
    joined(ready, http, "cost-readiness-joined-by-http-receiver");
    before(
      ready,
      admission,
      end(ready),
      admission.startTime,
      "cost-http-readiness-before-admission",
    );
    sequence(ready, ["SELECT 1"]);
  }
  before(model, usage, end(model), usage.startTime, "cost-model-before-usage");
  before(
    usage,
    finish,
    end(usage),
    finish.startTime,
    "cost-usage-before-finish",
  );
  const outputs = named("acp.session.output"),
    asynchronousOutput = [];
  assert(outputs.length > 0, "Cost Run output read subtree missing");
  for (const output of outputs) {
    const owner = tree.parent(output);
    assert(
      [request, admission, run, model].includes(owner),
      "Cost output has foreign owning span",
    );
    same(output, owner);
    for (const [key, value] of Object.entries({
      "span.kind": "internal",
      "agent.id": expected.agentId,
      "antnest.agent.id": expected.agentId,
      "session.id": expected.sessionId,
      "antnest.session.id": expected.sessionId,
      "antnest.operation.phase": "read",
    }))
      assert.equal(tag(output, key), value);
    assert(output.startTime >= owner.startTime);
    // Publishing invalidates output asynchronously. Retain its actual parent and
    // time evidence; unlike awaited SQL, the output need not finish with that parent.
    if (end(output) > end(owner))
      asynchronousOutput.push({
        trace_id: trace.traceID,
        span_id: output.spanID,
        parent_span_id: owner.spanID,
        output_start_us: output.startTime,
        output_end_us: end(output),
        parent_end_us: end(owner),
      });
    sequence(output, outputSequence);
  }
  for (const span of trace.spans.filter(
    (span) =>
      tree.chain(span).includes(model) && tag(span, "span.kind") === "client",
  ))
    assert(
      span === provider || ownedSQL.has(span),
      "unexpected Cost model CLIENT work",
    );
  for (const span of trace.spans.filter(database))
    assert(
      ownedSQL.has(span) ||
        ownedTransactions.has(span) ||
        readiness.includes(span),
      "unowned Cost database work",
    );

  const runtimeSpans = new Set([
    ...information.spans,
    ...information.toolLifecycles.flatMap((proof) => [
      proof.owner,
      ...proof.clients,
      ...proof.servers,
      ...proof.exchanges.map((exchange) => exchange.operation),
    ]),
  ]);
  for (const span of expected.connectionTrace?.spans ?? [])
    assertSessionSuccess(span);
  for (const span of trace.spans)
    assertSessionSuccess(
      privateACPDiagnosticView(
        trace,
        span,
        information.neutralDiagnostics,
        runtimeSpans,
      ),
      expected.transport === "http" && span.spanID === expected.clientSpanID
        ? {
            "antnest.outcome": tag(span, "antnest.outcome"),
            "antnest.http.body.outcome": tag(span, "antnest.http.body.outcome"),
          }
        : {},
    );
  const timing = timingEvidence(trace, tree, request, forwarded);
  if (expected.transport === "http")
    timing.timing = {
      acp_start_minus_private_http_client_us:
        request.startTime - forwarded.startTime,
    };
  const modelToFinishGap = finish.startTime - end(model);
  return {
    trace_id: trace.traceID,
    kind: expected.kind,
    label: expected.label,
    method: expected.method,
    request_id: expected.requestId,
    run_request_id: runRequestID,
    session_id: expected.sessionId,
    run_id: runID,
    runs: 1,
    spans: trace.spans.length,
    phase: expected.phase,
    model: modelName,
    provider_requests: 1,
    runtime_tool_calls: 0,
    no_tool_execution: true,
    persistence: true,
    reply_transactions: 1,
    usage_transactions: 1,
    admission_transactions: 2,
    environment_facts: environmentFacts.length,
    context_checkpoints: checkpoints.length,
    classified_sql_spans: ownedSQL.size,
    sql_parameters_observed: false,
    output_reads: outputs.length,
    asynchronous_output_reads: asynchronousOutput,
    runtime_information_reads: information.informationReads,
    post_prompt_information_reads: information.postPromptInformationReads,
    neutral_diagnostics: information.neutralDiagnostics,
    time_observations: observations,
    owned_error_spans: [],
    ...timing,
    transport_boundary: "private-acp",
    transport: expected.transport,
    model_finish_order: modelToFinishGap < 0 ? "failed" : "passed",
    model_to_finish_gap_us: modelToFinishGap,
    model_finish_timing: {
      model_start_us: model.startTime,
      model_duration_us: model.duration,
      finish_start_us: finish.startTime,
    },
    strict_trace: timing.warning_count ? "failed" : "passed",
  };
}
