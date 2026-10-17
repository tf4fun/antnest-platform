import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { requestTraceBoundary } from "../acp-commands/trace.mjs";
import { assertCostTraceSource } from "../acp-cost/trace-source.mjs";
import { hasDiagnosticError, timingEvidence } from "../acp-plan/requests.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import {
  privateACPDiagnosticView,
  privateACPProcessIdentity,
} from "../observability/private-acp-diagnostics.mjs";
import { inspectRunInformationReads } from "../observability/runtime-information-run.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { assertDurable, assertRecovered } from "./evidence.mjs";

const one = (spans, label) => {
  assert.equal(spans.length, 1, `missing or duplicate ${label}`);
  return spans[0];
};
const normalize = (text) => text.replace(/\s+/gu, " ").trim();
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
const intentQueries = [
  "BEGIN",
  `SELECT state, client_mcp_revision_id, configuration, append_version
             FROM acp_sessions WHERE id = $1 FOR UPDATE`,
  `INSERT INTO runs(
             id, request_id, session_id, client_mcp_revision_id,
             expected_access_revision, state,
             pending_user_message_id, input_prompt,
             created_at, updated_at, session_configuration,
             bridge_intent_id, intent_digest, expected_append_version, append_version
           ) VALUES ($1, $2, $3, $4, $5, 'admitting', $6, $7::jsonb, $8, $8, $9::jsonb,
                     $10, $11, $12, $13)
           RETURNING id, request_id, session_id, client_mcp_revision_id,
                     expected_access_revision, state,
                     pending_user_message_id, input_prompt, session_configuration`,
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
  "SELECT state, last_message_sequence FROM acp_sessions WHERE id = $1 FOR UPDATE",
  `SELECT session_id, client_mcp_revision_id, state,
                cancel_requested_at, pending_user_message_id, input_prompt
           FROM runs WHERE id = $1 FOR UPDATE`,
  `INSERT INTO session_messages(
           id, session_id, run_id, sequence, kind, visible, payload, created_at
         ) VALUES ($1, $2, $3, $4, 'user_message', true, $5::jsonb, $6)`,
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
const fields = (rows) => {
  const result = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  assert.equal(
    Object.keys(result).length,
    rows.length,
    "duplicate fault diagnostic",
  );
  return result;
};
function remove(rows, allowed) {
  const actual = fields(rows);
  for (const [key, value] of Object.entries(allowed))
    assert.deepEqual(
      actual[key],
      value,
      `contradictory fault diagnostic ${key}`,
    );
  return rows.filter(({ key }) => !Object.hasOwn(allowed, key));
}
function status(span) {
  const code = tag(span, "otel.status_code");
  assert(["ERROR", 2].includes(code), "lost response error status missing");
  const legacy = tag(span, "error");
  if (legacy !== undefined) assert.equal(legacy, true);
  return {
    "otel.status_code": code,
    ...(legacy === undefined ? {} : { error: true }),
  };
}
function inside(event, span) {
  assert(
    Number.isFinite(event.timestamp) &&
      event.timestamp >= span.startTime &&
      event.timestamp <= span.startTime + span.duration,
    "fault event outside its span",
  );
}
function databaseErrorView(span) {
  const type = tag(span, "error.type");
  assert(
    ["Error", "database_error"].includes(type),
    "unrelated SQL error type",
  );
  const allowed = { ...status(span), "error.type": type };
  const description = tag(span, "otel.status_description");
  if (description !== undefined) {
    assert(typeof description === "string" && description.length > 0);
    allowed["otel.status_description"] = description;
  }
  const events = span.logs ?? [];
  assert(events.length <= 1, "extra SQL diagnostic event");
  assert.equal(
    events.length,
    type === "Error" ? 1 : 0,
    "driver error type lost its original exception",
  );
  return {
    ...span,
    tags: remove(span.tags, allowed),
    logs: events.map((event) => {
      inside(event, span);
      const attributes = fields(event.fields);
      assert.equal(attributes.event, "exception");
      assert.equal(attributes["exception.type"], "Error");
      assert.equal(type, "Error");
      assert(
        typeof attributes["exception.message"] === "string" &&
          attributes["exception.message"].length > 0,
      );
      const owned = {
        event: "exception",
        "exception.type": "Error",
        "exception.message": attributes["exception.message"],
      };
      if (Object.hasOwn(attributes, "exception.stacktrace")) {
        assert.equal(typeof attributes["exception.stacktrace"], "string");
        owned["exception.stacktrace"] = attributes["exception.stacktrace"];
      }
      if (Object.hasOwn(attributes, "exception.escaped")) {
        assert.equal(typeof attributes["exception.escaped"], "boolean");
        owned["exception.escaped"] = attributes["exception.escaped"];
      }
      return { ...event, fields: remove(event.fields, owned) };
    }),
  };
}
function propagatedErrorView(trace, span, origin, phase) {
  const allowed = {
    ...status(span),
    "error.type": "Error",
    "antnest.outcome": "error",
    "antnest.operation.phase": phase,
  };
  const events = span.logs ?? [];
  let logs;
  if (span === origin) {
    const event = one(events, "original persistence boundary error");
    inside(event, span);
    const attributes = fields(event.fields);
    const causes = JSON.parse(attributes["antnest.error.causes"]);
    assert(Array.isArray(causes) && causes.length >= 1 && causes.length <= 4);
    for (const cause of causes)
      assert.deepEqual(cause, {
        type: "Error",
        message: "Error: unregistered message omitted",
      });
    const types = attributes["antnest.error.cause_types"];
    assert.deepEqual(
      typeof types === "string" ? JSON.parse(types) : types,
      causes.slice(1).map((cause) => cause.type),
    );
    logs = [
      {
        ...event,
        fields: remove(event.fields, {
          event: "antnest.error",
          "antnest.error.stage": phase,
          "antnest.operation.phase": phase,
          "antnest.error.type": "Error",
          "antnest.error.message": "Error: unregistered message omitted",
          "antnest.error.causes": attributes["antnest.error.causes"],
          "antnest.error.cause_types": types,
        }),
      },
    ];
  } else {
    assert.equal(
      events.length,
      0,
      "propagator repeated or replaced original error",
    );
    Object.assign(allowed, {
      "antnest.error.origin_trace_id": trace.traceID,
      "antnest.error.origin_span_id": origin.spanID,
    });
    logs = [];
  }
  if (span.operationName === "postgresql transaction")
    allowed["antnest.transaction.outcome"] = "failed";
  return { ...span, tags: remove(span.tags, allowed), logs };
}

// Only the injected SQL, its original boundary, and exact origin-linked
// propagators can own the fault. Raw sources are never rewritten for admission.
export function inspectPrivatePersistenceFaultTrace(
  trace,
  expected,
  fault,
  secrets = [],
  requests = [],
) {
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert.equal(expected.kind, "fault");
  assert.equal(expected.method, "session/prompt");
  assert([1, 2].includes(expected.version));
  assert.equal(expected.protocolVersion, expected.version);
  assert(["intent", "accept", "finish"].includes(expected.phase));
  assert.equal(expected.label, `v${expected.version}-${expected.phase}-fault`);
  assert.notEqual(expected.closedBeforeResponse, true);
  const finish = expected.phase === "finish";
  assert.equal(expected.inputSessionID, expected.sessionId);
  assert.equal(expected.requestParams?.sessionId, expected.sessionId);
  assert.equal(
    expected.outcome,
    finish && expected.version === 2 ? "succeeded" : "failed",
  );
  if (expected.outcome === "succeeded")
    assert(
      typeof expected.requestResult?.messageId === "string" &&
        expected.requestResult.messageId.length > 0,
      "actual v2 ACK missing",
    );
  else
    assert(
      typeof expected.failure === "string" && expected.failure.length > 0,
      "actual rejected fault response missing",
    );
  assert.equal(fault.held.phase, expected.phase);
  assert.equal(fault.held.session_id, expected.sessionId);
  assert.deepEqual(
    fault.record,
    { ...fault.held, delivery: "dropped" },
    "different held/drop receipt",
  );
  assert.equal(fault.natural_exit, 1, "natural failure exit required");
  assert.equal(fault.replays, 2);
  assertDurable(fault.before, fault.held);
  assertRecovered(fault.before, fault.after, expected.phase);
  assert.equal(fault.after.run.session_id, expected.sessionId);
  if (finish && expected.version === 2)
    assert.equal(
      expected.requestResult.messageId,
      one(
        fault.before.events.items.filter(
          (item) => item.kind === "user_message",
        ),
        "durable user message",
      ).payload.messageId,
      "ACK belongs to another durable message",
    );
  assertCostTraceSource(trace, expected.connectionTrace);
  const { tree, request, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  for (const span of expected.connectionTrace.spans) assertSessionSuccess(span);
  const acp = (name) =>
    trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        span.operationName === name,
    );
  const identity = privateACPProcessIdentity(trace, request);
  const sameProcess = (span) =>
    assert.deepEqual(
      privateACPProcessIdentity(trace, span),
      identity,
      "fault belongs to another ACP process",
    );
  const application = one(acp("acp.session.prompt"), "prompt admission");
  sameProcess(application);
  assert.equal(tree.parent(application), request);
  assert.equal(tag(application, "span.kind"), "internal");
  assert.equal(tag(application, "antnest.agent.id"), expected.agentId);
  assert.equal(tag(application, "antnest.session.id"), expected.sessionId);
  const sql = one(
    trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        tag(span, "db.system.name") === "postgresql" &&
        typeof tag(span, "db.query.text") === "string" &&
        createHash("sha256")
          .update(normalize(tag(span, "db.query.text")))
          .digest("hex") === fault.held.query_hash,
    ),
    "intercepted persistence SQL",
  );
  assert.match(
    normalize(tag(sql, "db.query.text")),
    {
      intent: /^INSERT INTO runs\s*\(/u,
      accept:
        /^UPDATE runs SET state = 'running', execution_snapshot = \$2::jsonb\b/u,
      finish: /^WITH finished AS \(UPDATE runs\b/u,
    }[expected.phase],
  );
  const checkSQL = (span, operation) => {
    sameProcess(span);
    assert.equal(tag(span, "span.kind"), "client");
    assert.equal(tag(span, "db.system.name"), "postgresql");
    assert.equal(tag(span, "db.namespace"), "antnest_agent_acp");
    assert.equal(tag(span, "db.operation.name"), operation);
    assert.equal(span.operationName, operation);
    assert(tree.chain(span).includes(request));
    assert(
      !trace.spans.some((child) => tree.parent(child) === span),
      "unowned work below an admission SQL",
    );
  };
  checkSQL(
    sql,
    { intent: "INSERT", accept: "UPDATE", finish: "WITH" }[expected.phase],
  );
  if (finish)
    assert.equal(
      normalize(tag(sql, "db.query.text")),
      finishQuery,
      "unexpected finish CTE",
    );
  const admissionTransactions = acp("postgresql transaction").filter(
    (span) => tree.parent(span) === application,
  );
  assert.equal(
    admissionTransactions.length,
    expected.phase === "intent" ? 1 : 2,
    "incomplete admission transaction inventory",
  );
  const children = (span) =>
    trace.spans.filter((child) => tree.parent(child) === span);
  let previousCommit;
  for (const [phase, queries] of [
    ["intent", intentQueries],
    ...(expected.phase === "intent" ? [] : [["accept", acceptanceQueries]]),
  ]) {
    const selected = queries[phase === "intent" ? 2 : 5];
    const transaction = one(
      admissionTransactions.filter((span) =>
        children(span).some(
          (child) =>
            typeof tag(child, "db.query.text") === "string" &&
            normalize(tag(child, "db.query.text")) === selected,
        ),
      ),
      `${phase} admission transaction`,
    );
    sameProcess(transaction);
    assert.equal(tag(transaction, "db.system.name"), "postgresql");
    assert.equal(
      tag(transaction, "antnest.transaction.outcome"),
      expected.phase === phase ? "failed" : "committed",
    );
    const actual = children(transaction);
    const required = [
      ...queries,
      ...(expected.phase === phase ? ["ROLLBACK"] : []),
    ];
    if (
      phase === "accept" &&
      actual.some(
        (child) =>
          typeof tag(child, "db.query.text") === "string" &&
          normalize(tag(child, "db.query.text")) === environmentInsert,
      )
    )
      required.splice(4, 0, environmentInsert);
    assert.deepEqual(
      actual
        .map((child) => normalize(tag(child, "db.query.text") ?? ""))
        .sort(),
      required.toSorted(),
      "incomplete admission SQL inventory",
    );
    for (const child of actual)
      checkSQL(child, normalize(tag(child, "db.query.text")).split(" ")[0]);
    const ordered = required.map((query) =>
      actual.find((child) => normalize(tag(child, "db.query.text")) === query),
    );
    if (previousCommit)
      assert(
        ordered[0].startTime >= previousCommit.startTime,
        "acceptance preceded its intent COMMIT",
      );
    previousCommit = ordered.find(
      (child) => normalize(tag(child, "db.query.text")) === "COMMIT",
    );
    for (let index = 1; index < ordered.length; index++)
      assert(
        ordered[index].startTime >= ordered[index - 1].startTime,
        "admission SQL reversed its awaited order",
      );
  }
  const views = new Map(),
    owned = [];
  let origin, failed;
  const claim = (span, view) => {
    assert(hasDiagnosticError(span), "claimed fault has no raw error");
    assert(!views.has(span), "duplicate fault ownership");
    views.set(span, view);
    owned.push(span);
  };
  if (finish) {
    origin = one(acp("agent.run"), "original finish Run");
    sameProcess(origin);
    assert.equal(
      tree.parent(origin),
      application,
      "Run bypassed prompt admission",
    );
    assert(
      !trace.spans.some(
        (span) =>
          tree.chain(span).includes(origin) &&
          ["identity-service", "agent-controller"].includes(tree.service(span)),
      ),
      "Run called management service",
    );
    assert.equal(tag(origin, "antnest.run.id"), fault.held.run_id);
    assert.equal(tag(origin, "antnest.session.id"), expected.sessionId);
    assert.equal(tree.parent(sql), origin, "finish SQL detached from its Run");
    failed = sql;
    claim(sql, databaseErrorView(sql));
    claim(origin, propagatedErrorView(trace, origin, origin, "agent.run"));
  } else {
    origin = tree.parent(sql);
    assert.equal(origin?.operationName, "postgresql transaction");
    sameProcess(origin);
    assert.equal(tag(origin, "db.system.name"), "postgresql");
    assert.equal(tree.parent(origin), application);
    assertSessionSuccess(sql);
    const sibling = (command) =>
      one(
        trace.spans.filter(
          (span) =>
            tree.parent(span) === origin &&
            typeof tag(span, "db.query.text") === "string" &&
            normalize(tag(span, "db.query.text")) === command,
        ),
        command,
      );
    failed = sibling("COMMIT");
    const rollback = sibling("ROLLBACK");
    checkSQL(failed, "COMMIT");
    checkSQL(rollback, "ROLLBACK");
    claim(failed, databaseErrorView(failed));
    if (hasDiagnosticError(rollback))
      claim(rollback, databaseErrorView(rollback));
    claim(
      origin,
      propagatedErrorView(trace, origin, origin, "postgresql transaction"),
    );
    claim(
      application,
      propagatedErrorView(trace, application, origin, "acp.session.prompt"),
    );
  }
  if (expected.outcome === "failed")
    claim(request, propagatedErrorView(trace, request, origin, "acp.dispatch"));
  let information;
  if (finish) {
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((item) => item.stage),
      ["tool", "reply"],
    );
    assert(
      requests.every(
        (item) =>
          item.phase === expected.label && item.trace_id === trace.traceID,
      ),
      "foreign fault Provider request",
    );
    assert.equal(new Set(requests.map((item) => item.model_span_id)).size, 2);
    assert.equal(acp("HTTP POST model").length, 2);
    assert.equal(acp("model.complete").length, 2);
    // The original error chain was checked above. This local view lets the
    // independent successful Runtime refresh prove all of its own diagnostics.
    information = inspectRunInformationReads(
      { ...trace, spans: trace.spans.map((span) => views.get(span) ?? span) },
      { request: views.get(request) ?? request, run: views.get(origin) },
    );
    const models = new Set();
    for (const item of requests) {
      const http = tree.spans.get(item.model_span_id);
      assert.equal(http?.operationName, "HTTP POST model");
      sameProcess(http);
      assert(
        sql.startTime >= http.startTime,
        "finish SQL preceded its Model request",
      );
      assert.equal(tag(http, "span.kind"), "client");
      const model = tree.parent(http);
      assert.equal(model?.operationName, "model.complete");
      sameProcess(model);
      assert(tree.chain(model).includes(origin));
      models.add(model);
      for (const prep of information.prepared)
        assert(
          prep.startTime + prep.duration <= model.startTime,
          "Provider preceded preparation",
        );
    }
    assert.equal(models.size, 2);
    const call = one(acp("mcp.tools.call"), "Bash dispatch");
    assert(tree.chain(call).includes(origin));
    assert.equal(tag(call, "antnest.run.id"), fault.held.run_id);
    assert.equal(tag(call, "tool.name"), "bash");
    assert(
      sql.startTime >= call.startTime,
      "finish SQL preceded its Tool dispatch",
    );
    const tool = one(
      trace.spans.filter(
        (span) =>
          span.operationName === "runtime.mcp.tool" &&
          tree.service(span) === "antnest-runtime",
      ),
      "actual Bash Tool",
    );
    assert(tree.chain(tool).includes(call));
    assert.equal(information.toolLifecycles.length, 2);
  } else {
    assert.equal(
      requests.length,
      0,
      "Provider before persistence acknowledgement",
    );
    for (const span of trace.spans) {
      assert(
        !/^(model\.|mcp\.|HTTP POST model$|agent\.run$)/u.test(
          span.operationName,
        ),
        "execution before persistence acknowledgement",
      );
      assert.notEqual(tree.service(span), "antnest-runtime");
    }
  }
  const neutral = information?.neutralDiagnostics ?? [];
  const runtimeSpans = new Set(
    information
      ? [
          ...information.spans,
          ...information.toolLifecycles.flatMap((proof) => [
            proof.owner,
            ...proof.clients,
            ...proof.servers,
            ...proof.exchanges.map((exchange) => exchange.operation),
          ]),
        ]
      : [],
  );
  for (const span of trace.spans)
    assertSessionSuccess(
      views.get(span) ??
        privateACPDiagnosticView(trace, span, neutral, runtimeSpans),
    );
  return {
    label: expected.label,
    kind: expected.kind,
    trace_id: trace.traceID,
    request_id: expected.requestId,
    session_id: expected.sessionId,
    run_id: fault.held.run_id,
    selected_sql_verified: true,
    provider_requests: requests.length,
    runtime_tool_calls: finish ? 1 : 0,
    runs: finish ? 1 : 0,
    runtime_information_reads: information?.informationReads ?? 0,
    post_prompt_information_reads: information?.postPromptInformationReads ?? 0,
    owned_error_spans: owned.map((span) => ({
      trace_id: trace.traceID,
      span_id: span.spanID,
      reason: "persistence-lost-acknowledgement",
      phase: expected.phase,
      request_id: expected.requestId,
      run_id: fault.held.run_id,
      receipt_id: fault.held.receipt_id,
      failed_sql_span_id: failed.spanID,
      origin_span_id: origin.spanID,
    })),
    neutral_diagnostics: neutral,
    time_observations: information?.timeObservations ?? [],
    ...timingEvidence(trace, tree, request, forwarded),
    strict_trace: "failed",
    strict_reason: "fault_error_spans_retained",
  };
}
