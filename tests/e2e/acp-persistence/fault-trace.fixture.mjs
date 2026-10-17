import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture as commandFixture } from "../acp-commands/trace-fixtures.mjs";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";

const fields = (value) =>
  Object.entries(value).map(([key, value]) => ({ key, value }));
const normalize = (text) => text.replace(/\s+/gu, " ").trim();
const actualQuery = (name, prefix) => {
  const source = readFileSync(
    new URL(
      `../../../services/agent-acp-service/src/adapters/postgres/${name}.ts`,
      import.meta.url,
    ),
    "utf8",
  );
  const queries = [...source.matchAll(/`([^`]+)`|"([^"\n]+)"/gu)]
    .map((match) => normalize(match[1] ?? match[2]))
    .filter((text) => text.startsWith(prefix));
  assert.equal(queries.length, 1);
  return queries[0];
};
export const faultAdmissionQueries = {
  intent: [
    "BEGIN",
    actualQuery(
      "run-repository",
      "SELECT state, client_mcp_revision_id, configuration, append_version",
    ),
    actualQuery("run-repository", "INSERT INTO runs("),
    actualQuery("run-repository", "UPDATE acp_sessions SET append_version"),
    "COMMIT",
  ],
  accept: [
    "BEGIN",
    actualQuery("run-repository", "SELECT session_id FROM runs WHERE id"),
    actualQuery(
      "run-repository",
      "SELECT state, last_message_sequence FROM acp_sessions",
    ),
    actualQuery(
      "run-repository",
      "SELECT session_id, client_mcp_revision_id, state, cancel_requested_at",
    ),
    actualQuery(
      "run-repository",
      "INSERT INTO session_messages( id, session_id, run_id, sequence, kind, visible, payload, created_at ) VALUES",
    ),
    actualQuery("run-repository", "UPDATE runs SET state = 'running'"),
    actualQuery(
      "run-repository",
      "UPDATE acp_sessions SET last_execution_revision",
    ),
    "COMMIT",
  ],
};
export function privatePersistenceFaultFixture(
  version = 1,
  phase = "intent",
  { environmentChange = false } = {},
) {
  const finish = phase === "finish";
  const f = finish
    ? commandFixture("ordinary")
    : requestFixture("session/prompt");
  const request = f.trace.spans.find((span) => span.spanID === "request");
  const set = (span, key, value) => {
    span.tags = span.tags.filter((row) => row.key !== key);
    if (value !== undefined) span.tags.push({ key, value });
  };
  const error = (span, origin) => {
    for (const [key, value] of Object.entries({
      "error.type": "Error",
      "otel.status_code": "ERROR",
      "antnest.outcome": "error",
      "antnest.operation.phase":
        span === request ? "acp.dispatch" : span.operationName,
    }))
      set(span, key, value);
    if (origin) {
      set(span, "antnest.error.origin_trace_id", f.trace.traceID);
      set(span, "antnest.error.origin_span_id", origin.spanID);
    } else
      span.logs = [
        {
          timestamp: span.startTime + span.duration,
          fields: fields({
            event: "antnest.error",
            "antnest.error.stage": span.operationName,
            "antnest.operation.phase": span.operationName,
            "antnest.error.type": "Error",
            "antnest.error.message": "Error: unregistered message omitted",
            "antnest.error.cause_types": '["Error"]',
            "antnest.error.causes": JSON.stringify([
              { type: "Error", message: "Error: unregistered message omitted" },
              { type: "Error", message: "Error: unregistered message omitted" },
            ]),
          }),
        },
      ];
  };
  const sqlError = (span) => {
    set(span, "error", true);
    set(span, "otel.status_code", "ERROR");
    set(span, "error.type", "database_error");
  };
  const app = f.add(
    "admit",
    "request",
    "acp.session.prompt",
    undefined,
    finish ? 2001 : 3,
    {
      "span.kind": "internal",
      "agent.id": "agent",
      "session.id": "session",
      "antnest.agent.id": "agent",
      "antnest.session.id": "session",
    },
  );
  let origin, sql, failed, rollback;
  const text = {
    intent: faultAdmissionQueries.intent[2],
    accept: faultAdmissionQueries.accept[5],
    finish: actualQuery(
      "execution-repository",
      "WITH finished AS (UPDATE runs",
    ),
  }[phase];
  const sqlTags = (query) => ({
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.namespace": "antnest_agent_acp",
    "db.query.text": query,
    "db.operation.name": query.split(" ")[0],
  });
  const transaction = (name, queries, start, failed = false) => {
    const tx = f.add(
      name,
      app.spanID,
      "postgresql transaction",
      undefined,
      start,
      {
        "db.system.name": "postgresql",
        "antnest.transaction.outcome": failed ? "failed" : "committed",
      },
    );
    tx.duration = queries.length + 2;
    const items = queries.map((query, index) =>
      f.add(
        `${name}-${index}`,
        tx.spanID,
        query.split(" ")[0],
        undefined,
        start + index + 1,
        sqlTags(query),
      ),
    );
    return { tx, items };
  };
  const admissionTransactions = [];
  const acceptanceQueries = [...faultAdmissionQueries.accept];
  if (environmentChange)
    acceptanceQueries.splice(
      4,
      0,
      actualQuery(
        "run-repository",
        "INSERT INTO session_messages( id, session_id, run_id, sequence, kind, visible, payload, created_at ) SELECT",
      ),
    );
  if (phase !== "intent")
    admissionTransactions.push(
      transaction(
        "successful-intent",
        faultAdmissionQueries.intent,
        finish ? 2010 : 4,
      ),
    );
  if (finish)
    admissionTransactions.push(
      transaction("successful-accept", acceptanceQueries, 2020),
    );
  if (finish) {
    origin = f.trace.spans.find((span) => span.operationName === "agent.run");
    origin.references[0].spanID = app.spanID;
    sql = failed = f.add(
      "finish-sql",
      origin.spanID,
      "WITH",
      undefined,
      23000,
      sqlTags(text),
    );
    origin.duration = 21000;
    set(origin, "antnest.session.id", "session");
    set(origin, "antnest.run.id", "run");
    error(origin);
    if (version === 1) error(request, origin);
    request.duration = version === 1 ? 25000 : 500;
    for (const row of f.requests) row.phase = `v${version}-finish-fault`;
  } else {
    const transactionProof = transaction(
      "tx",
      [
        ...(phase === "intent"
          ? faultAdmissionQueries.intent
          : acceptanceQueries),
        "ROLLBACK",
      ],
      phase === "intent" ? 4 : 40,
      true,
    );
    admissionTransactions.push(transactionProof);
    origin = transactionProof.tx;
    sql = transactionProof.items.find((span) =>
      span.tags.some(
        (item) => item.key === "db.query.text" && item.value === text,
      ),
    );
    failed = transactionProof.items.at(-2);
    rollback = transactionProof.items.at(-1);
    sqlError(rollback);
    app.duration = 80;
    request.duration = 100;
    error(origin);
    error(app, origin);
    error(request, origin);
  }
  sqlError(failed);
  const originalTraceID = f.trace.traceID;
  const bound = privateBoundaryFixture(f, { version });
  for (const span of bound.trace.spans)
    if (
      span.tags.some(
        (row) =>
          row.key === "antnest.error.origin_trace_id" &&
          row.value === originalTraceID,
      )
    )
      set(span, "antnest.error.origin_trace_id", bound.trace.traceID);
  Object.assign(bound.expected, {
    version,
    kind: "fault",
    phase,
    label: `v${version}-${phase}-fault`,
    inputSessionID: "session",
    outcome: finish && version === 2 ? "succeeded" : "failed",
    requestParams: {
      sessionId: "session",
      prompt: [{ type: "text", text: `v${version}-${phase}-fault` }],
    },
    ...(finish && version === 2
      ? { requestResult: { messageId: "message" } }
      : { failure: "original lost response" }),
  });
  const before = {
    run: {
      run_id: "run",
      session_id: "session",
      state: finish
        ? "completed"
        : phase === "intent"
          ? "admitting"
          : "running",
      terminal_class: finish ? "completed" : null,
      executor_state: finish ? "quiescent" : null,
      tool_effect_state: finish ? "settled" : null,
      stop_reason: finish ? "end_turn" : null,
      execution_snapshot: phase === "intent" ? null : { execution: "pinned" },
    },
    events: {
      items:
        phase === "intent"
          ? []
          : [
              {
                kind: "user_message",
                visible: true,
                payload: { messageId: "message" },
              },
              ...(finish
                ? [
                    { kind: "tool_call", payload: { status: "completed" } },
                    { kind: "agent_message", visible: true, payload: {} },
                  ]
                : []),
            ],
    },
  };
  const after = structuredClone(before);
  if (!finish)
    Object.assign(after.run, {
      state: "failed",
      terminal_class: phase === "intent" ? null : "failed",
      executor_state: phase === "intent" ? null : "quiescent",
      tool_effect_state: phase === "intent" ? null : "none",
      error_class:
        phase === "intent"
          ? "service_restarted_before_execution"
          : "service_restarted_during_run",
    });
  const held = {
    receipt_id: "receipt",
    phase,
    session_id: "session",
    run_id: "run",
    query_hash: createHash("sha256").update(text).digest("hex"),
    command_tag: finish ? "SELECT 1" : "COMMIT",
    delivery: "held",
  };
  return {
    ...bound,
    app,
    origin,
    sql,
    failed,
    rollback,
    set,
    error,
    sqlError,
    admissionTransactions,
    fault: {
      held,
      record: { ...held, delivery: "dropped" },
      before,
      after,
      natural_exit: 1,
      replays: 2,
    },
    requests: bound.requests ?? [],
  };
}
