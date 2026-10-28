import assert from "node:assert/strict";
import {
  requestTraceBoundary,
  inspectPrivateCommandTrace,
} from "../acp-commands/trace.mjs";
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
    "SELECT last_message_sequence FROM acp_sessions WHERE id = $1 FOR UPDATE",
    "SELECT session_id, state FROM runs WHERE id = $1 FOR UPDATE",
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
              stop_reason = $6, error_class = $7, updated_at = $8, budget_reason = $9::jsonb
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
const one = (spans, name) => {
  assert.equal(spans.length, 1, "missing or duplicate native " + name);
  return spans[0];
};
const end = (span) => {
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
  );
  assert(Number.isFinite(span.startTime + span.duration));
  return span.startTime + span.duration;
};
const values = (fields = []) => {
  const result = Object.fromEntries(
    fields.map(({ key, value }) => [key, value]),
  );
  assert.equal(
    Object.keys(result).length,
    fields.length,
    "duplicate native diagnostic field",
  );
  return result;
};
const remove = (fields, allowed) => {
  const actual = values(fields);
  for (const [key, value] of Object.entries(allowed))
    assert.deepEqual(actual[key], value, "wrong native " + key);
  return fields.filter(({ key }) => !Object.hasOwn(allowed, key));
};
const errorTags = (span) => {
  const status = tag(span, "otel.status_code"),
    legacy = tag(span, "error");
  assert(["ERROR", 2].includes(status));
  assert(legacy === undefined || legacy === true);
  return {
    "otel.status_code": status,
    ...(legacy === undefined ? {} : { error: true }),
  };
};
function boundaryFailure(span, type, code, phase) {
  const tags = remove(span.tags, {
    ...errorTags(span),
    "error.type": type,
    "error.code": String(code),
    "antnest.error.code": String(code),
    "antnest.operation.phase": phase,
    "antnest.outcome": "error",
    ...(typeof code === "number" ? { "rpc.response.status_code": code } : {}),
  });
  const event = one(span.logs ?? [], "original error event");
  assert(
    event.timestamp >= span.startTime && event.timestamp <= end(span),
    "error event outside owner",
  );
  const actual = values(event.fields),
    types = actual["antnest.error.cause_types"],
    causes = actual["antnest.error.causes"];
  assert(types === "[]" || (Array.isArray(types) && types.length === 0));
  assert.equal(typeof causes, "string");
  const message = `Operation reported ${code}`;
  assert.deepEqual(JSON.parse(causes), [{ type, code, message }]);
  const expected = {
    event: "antnest.error",
    "antnest.error.stage": phase,
    "antnest.operation.phase": phase,
    "antnest.error.type": type,
    "antnest.error.code": String(code),
    "antnest.error.message": message,
    "antnest.error.cause_types": types,
    "antnest.error.causes": causes,
  };
  assert.deepEqual(actual, expected, "unexpected native failure event fields");
  return { ...span, tags, logs: [{ ...event, fields: [] }] };
}

function promptReceipt(expected, failed) {
  const receipt = expected.promptReceipt;
  assert(
    receipt && typeof receipt === "object",
    "actual SDK prompt receipt required",
  );
  assert.equal(receipt.requestId, expected.requestId);
  assert.equal(receipt.sessionId, expected.sessionId);
  if (expected.protocolVersion === 1) {
    assert.deepEqual(receipt, {
      requestId: expected.requestId,
      sessionId: expected.sessionId,
      result: failed ? null : { stopReason: "end_turn" },
      error: failed
        ? {
            rpcCode: -32022,
            code: "model_unsupported_content",
            retryable: false,
          }
        : null,
      terminals: [],
    });
  } else {
    assert.equal(receipt.error, null);
    assert.deepEqual(Object.keys(receipt.result ?? {}), ["messageId"]);
    assert(
      typeof receipt.result.messageId === "string" &&
        receipt.result.messageId.length > 0,
    );
    assert.deepEqual(receipt.terminals, [
      {
        sessionId: expected.sessionId,
        update: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: failed ? "_failed" : "end_turn",
        },
      },
    ]);
  }
}

export function nativeBefore(
  trace,
  timeObservations,
  leftSpan,
  rightSpan,
  left,
  right,
  boundary,
) {
  assert(Number.isFinite(left) && Number.isFinite(right));
  if (left <= right) return;
  assert.deepEqual(
    privateACPProcessIdentity(trace, leftSpan),
    privateACPProcessIdentity(trace, rightSpan),
    "foreign native process",
  );
  const resource = values(trace.processes[leftSpan.processID].tags);
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
    "native order outside deferred same-Node sub-ms boundary",
  );
  const [host, pid, instance] = privateACPProcessIdentity(trace, leftSpan);
  timeObservations.push({
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
}

export function inspectPrivateNativeTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assert.equal(expected.boundary, "private-acp");
  assert(Array.isArray(requests));
  for (const source of [trace, expected.connectionTrace])
    for (const span of source?.spans ?? []) {
      assert(
        !span.tags?.some(({ key }) => key === "antnest.payload.json"),
        "native trace captured content in span tags",
      );
      for (const event of span.logs ?? [])
        assert(
          !event.fields?.some(({ key }) => key === "antnest.payload.json"),
          "native trace captured content in event fields",
        );
    }
  if (expected.kind === "request") {
    assert.equal(
      requests.length,
      0,
      "nonexecution native request reached Provider",
    );
    const result = inspectPrivateCommandTrace(
      trace,
      expected,
      secrets,
      requests,
    );
    return {
      ...result,
      no_execution: result.runs === 0,
      input_session_id: expected.inputSessionID,
      owned_error_spans: (result.owned_error_spans ?? []).map((record) => ({
        ...record,
        reason:
          record.reason === "command-rejection"
            ? "multimodal-rejection"
            : record.reason,
      })),
    };
  }
  assert(["native", "local-failure"].includes(expected.kind));
  assert.equal(expected.method, "session/prompt");
  assert([1, 2].includes(expected.protocolVersion));
  assert.equal(expected.version, expected.protocolVersion);
  assert.notEqual(expected.closedBeforeResponse, true);
  const failed = expected.kind === "local-failure";
  promptReceipt(expected, failed);
  const { tree, request, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  const acp = (name) =>
    trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        span.operationName === name,
    );
  const run = one(acp("agent.run"), "Run"),
    runID = tag(run, "antnest.run.id"),
    runRequestID = tag(run, "antnest.request.id");
  assert(typeof runID === "string" && runID.length > 0);
  assert(tree.chain(run).includes(request), "Run detached from actual prompt");
  // The coordinator allocates this ID when persisting the Run intent;
  // the wire JSON-RPC ID is independently bound by requestTraceBoundary.
  assert(typeof runRequestID === "string" && runRequestID.length > 0);
  assert.equal(tag(run, "antnest.session.id"), expected.sessionId);
  assert.equal(tag(run, "run.terminal_class"), failed ? "failed" : "completed");
  assert.equal(tag(run, "run.executor_state"), "quiescent");
  assert.equal(tag(run, "run.tool_effect_state"), "none");
  assert.equal(tag(run, "run.unknown_effect_source"), undefined);
  const inside = (span) => tree.chain(span).includes(run);
  for (const span of trace.spans) {
    assert(
      !["mcp.tools.call", "runtime.mcp.tool"].includes(span.operationName) &&
        tag(span, "rpc.method") !== "tools/call",
      "native prompt executed a Tool",
    );
    assert(
      !(
        inside(span) &&
        ["agent-controller", "identity-service"].includes(tree.service(span))
      ),
      "Run called management service",
    );
  }
  const information = inspectRunInformationReads(trace, {
    request,
    run,
    postPromptRequestOutcome:
      failed && expected.protocolVersion === 1
        ? "failed-v1-run-response"
        : "success",
  });
  const timeObservations = [...information.timeObservations];
  const model = one(acp("model.complete"), "model attempt");
  assert.equal(tree.parent(model), run, "model is not directly owned by Run");
  assert.equal(tag(model, "model.purpose"), "response");
  const modelName =
    expected.modelName === undefined
      ? failed
        ? "text-model"
        : "native-model"
      : expected.modelName;
  assert(
    typeof modelName === "string" && modelName.trim().length > 0,
    "original expected model name required",
  );
  assert.equal(tag(model, "model.name"), modelName);
  const finish = one(
    trace.spans.filter((span) =>
      /WITH finished AS \(UPDATE runs\b/u.test(
        normalize(tag(span, "db.query.text") ?? ""),
      ),
    ),
    "durable Run finish",
  );
  assert.equal(tree.parent(finish), run, "finish is not directly owned by Run");
  assert.equal(
    normalize(tag(finish, "db.query.text")),
    finishQuery,
    "not the actual atomic finish CTE",
  );
  for (const [key, value] of Object.entries({
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.namespace": "antnest_agent_acp",
    "db.operation.name": "SELECT",
  }))
    assert.equal(tag(finish, key), value);
  const same = (span, parent) =>
    assert.deepEqual(
      privateACPProcessIdentity(trace, span),
      privateACPProcessIdentity(trace, parent),
      "foreign native process",
    );
  const before = (leftSpan, rightSpan, left, right, boundary) =>
    nativeBefore(
      trace,
      timeObservations,
      leftSpan,
      rightSpan,
      left,
      right,
      boundary,
    );
  for (const span of [model, finish]) {
    same(span, run);
    assert(span.startTime >= run.startTime);
    before(span, run, end(span), end(run), "native-work-joined-by-run");
  }
  for (const prep of information.prepared)
    before(
      prep,
      model,
      end(prep),
      model.startTime,
      "runtime-preparation-before-model",
    );
  before(
    model,
    finish,
    end(model),
    finish.startTime,
    "model-before-durable-finish",
  );
  if (expected.protocolVersion === 1)
    assertPrivateACPApplicationJoined(
      trace,
      request,
      run,
      timeObservations,
      "native-run-joined-by-v1-rpc",
    );
  const http = acp("HTTP POST model");
  assert.equal(http.length, failed ? 0 : 1);
  assert.equal(requests.length, failed ? 0 : 1);
  const modelClients = trace.spans.filter(
    (span) =>
      tree.chain(span).includes(model) && tag(span, "span.kind") === "client",
  );
  // Streaming callbacks persist and publish the reply inside model.complete.
  // Those owning database calls are separate from the Provider transport.
  const persistenceClients = modelClients.filter(
    (span) => tag(span, "db.system.name") === "postgresql",
  );
  for (const span of persistenceClients) {
    end(span);
    assert.equal(failed, false, "locally failed model persisted a reply");
    assert.equal(tree.service(span), "agent-acp-service");
    same(span, model);
    assert.equal(tag(span, "db.namespace"), "antnest_agent_acp");
    assert.equal(span.operationName, tag(span, "db.operation.name"));
    assert(
      ["BEGIN", "COMMIT", "SELECT", "INSERT", "UPDATE"].includes(
        tag(span, "db.operation.name"),
      ),
      "unexpected streamed reply SQL operation",
    );
    assert(
      typeof tag(span, "db.query.text") === "string" &&
        tag(span, "db.query.text").trim().length > 0,
    );
    assert(
      !span.tags.some(({ key }) => /^(?:http|rpc)\./u.test(key)),
      "database-tagged model transport",
    );
    const owner = tree.parent(span);
    assert(owner && tree.parent(owner) === model);
    end(owner);
    assert.equal(tree.service(owner), "agent-acp-service");
    same(owner, model);
    assert.equal(tag(owner, "span.kind"), "internal");
    if (owner.operationName === "postgresql transaction") {
      assert.equal(tag(owner, "db.system.name"), "postgresql");
      assert.equal(tag(owner, "antnest.transaction.outcome"), "committed");
      assert.equal(
        appendQueries.get(normalize(tag(span, "db.query.text"))),
        span.operationName,
      );
    } else {
      assert.equal(owner.operationName, "acp.session.output");
      assert.equal(tag(span, "db.operation.name"), "SELECT");
      assert.equal(tag(owner, "antnest.agent.id"), expected.agentId);
      assert.equal(tag(owner, "antnest.session.id"), expected.sessionId);
      assert.equal(tag(owner, "antnest.operation.phase"), "read");
      assert.equal(
        outputQueries.get(normalize(tag(span, "db.query.text"))),
        span.operationName,
      );
    }
  }
  assert.deepEqual(
    new Set(modelClients),
    new Set([...http, ...persistenceClients]),
    "unexpected model transport work",
  );
  if (!failed) {
    const observed = requests[0];
    assert.equal(observed.phase, expected.phase);
    assert.equal(observed.trace_id, trace.traceID);
    assert.equal(observed.model_span_id, http[0].spanID);
    assert.equal(tree.parent(http[0]), model);
    same(http[0], model);
    assert(
      http[0].startTime >= model.startTime,
      "Provider starts before model",
    );
    before(
      http[0],
      model,
      end(http[0]),
      end(model),
      "provider-joined-by-model",
    );
    assert.equal(tag(http[0], "span.kind"), "client");
    assert.equal(tag(http[0], "http.request.method"), "POST");
    assert.equal(tag(http[0], "http.response.status_code"), 200);
    assert(
      acp("postgresql transaction").some(
        (tx) =>
          inside(tx) &&
          tag(tx, "db.system.name") === "postgresql" &&
          tag(tx, "antnest.transaction.outcome") === "committed" &&
          trace.spans.some(
            (span) =>
              tree.chain(span).includes(tx) &&
              tree.service(span) === "agent-acp-service" &&
              tag(span, "span.kind") === "client" &&
              tag(span, "db.system.name") === "postgresql" &&
              ["INSERT", "UPDATE"].includes(tag(span, "db.operation.name")),
          ),
      ),
      "missing committed reply persistence",
    );
  }
  const views = new Map(),
    errors = [];
  if (failed) {
    views.set(
      model,
      boundaryFailure(
        model,
        "ModelError",
        "model_unsupported_content",
        "model.complete",
      ),
    );
    assert.equal(tag(run, "antnest.operation.phase"), "execute");
    views.set(run, {
      ...run,
      tags: remove(run.tags, {
        ...errorTags(run),
        "antnest.outcome": "failed",
        "error.type": "run_failed",
      }),
    });
    errors.push(model, run);
    if (expected.protocolVersion === 1) {
      views.set(
        request,
        boundaryFailure(request, "RequestError", -32022, "acp.dispatch"),
      );
      errors.push(request);
    }
  }
  const runtimeSpans = new Set([
    ...information.spans,
    ...information.toolLifecycles.flatMap((p) => [
      p.owner,
      ...p.clients,
      ...p.servers,
      ...p.exchanges.map((e) => e.operation),
    ]),
  ]);
  for (const span of expected.connectionTrace?.spans ?? [])
    assertSessionSuccess(span);
  for (const span of trace.spans) {
    const view =
      views.get(span) ??
      privateACPDiagnosticView(
        trace,
        span,
        information.neutralDiagnostics,
        runtimeSpans,
      );
    assertSessionSuccess(
      view,
      expected.transport === "http" && span.spanID === expected.clientSpanID
        ? {
            "antnest.outcome": tag(span, "antnest.outcome"),
            "antnest.http.body.outcome": tag(span, "antnest.http.body.outcome"),
          }
        : {},
    );
  }
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
    provider_requests: requests.length,
    local_failures: failed ? 1 : 0,
    no_tool_execution: true,
    persistence: true,
    information_reads: 1,
    catalog_reads: 1,
    runtime_information_reads: information.informationReads,
    post_prompt_information_reads: information.postPromptInformationReads,
    neutral_diagnostics: information.neutralDiagnostics,
    time_observations: timeObservations,
    owned_error_spans: errors.map((span) => ({
      trace_id: trace.traceID,
      span_id: span.spanID,
      service: tree.service(span),
      operation: span.operationName,
      reason: "multimodal-model-unsupported-content",
    })),
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
    strict_trace: errors.length || timing.warning_count ? "failed" : "passed",
  };
}

export {
  finishQuery as nativeFinishQuery,
  boundaryFailure as nativeBoundaryFailure,
};
