import assert from "node:assert/strict";
import { progressTraceFixture } from "../acp-progress/trace.fixture.mjs";
import { tag } from "../observability/trace-tree.mjs";

const end = (span) => span.startTime + span.duration;
const sessionAliases = new Set([
  "antnest.session.id",
  "antnest.session_id",
  "session.id",
  "session_id",
  "sessionId",
  "sessionID",
  "inputSessionID",
]);
const agentAliases = new Set([
  "antnest.agent.id",
  "antnest.agent_id",
  "agent.id",
  "agent_id",
  "agentId",
  "agentID",
]);

// Controlled fixture composition only; never applied to archived raw evidence.
// The caller retains the original receipt for the owning WeakMap inspection.
export function workspaceDisconnectTraceFixture(
  receipt,
  {
    protocolFailed = true,
    refresh = true,
    invocationBeforeHeaders = false,
  } = {},
) {
  assert(["c4-cancel", "c4-offline"].includes(receipt.phase));
  const cancelled = receipt.phase === "c4-cancel";
  const f = progressTraceFixture(
    cancelled ? "v1-bash-cancel" : "v1-bash-success",
    { protocolFailed, refresh },
  );
  const { trace, expected, request, run, connectionTrace } = f;
  const oldConnectionTraceID = connectionTrace.traceID;
  const oldClientSpanID = expected.clientSpanID;
  connectionTrace.traceID = receipt.connectionTraceID;
  for (const source of [trace, connectionTrace]) {
    const bindIdentity = (fields = []) => {
      for (const field of fields) {
        if (sessionAliases.has(field.key)) field.value = receipt.sessionId;
        if (agentAliases.has(field.key)) field.value = receipt.agentId;
        if (field.key === "trace_id" && field.value === oldConnectionTraceID)
          field.value = receipt.connectionTraceID;
        if (field.key === "span_id" && field.value === oldClientSpanID)
          field.value = receipt.clientSpanID;
      }
    };
    for (const process of Object.values(source.processes))
      bindIdentity(process.tags);
    for (const span of source.spans) {
      if (span.traceID === oldConnectionTraceID)
        span.traceID = receipt.connectionTraceID;
      if (source === connectionTrace && span.spanID === oldClientSpanID)
        span.spanID = receipt.clientSpanID;
      for (const reference of span.references ?? []) {
        if (reference.traceID !== oldConnectionTraceID) continue;
        reference.traceID = receipt.connectionTraceID;
        if (reference.spanID === oldClientSpanID)
          reference.spanID = receipt.clientSpanID;
      }
      bindIdentity(span.tags);
      for (const event of span.logs ?? []) bindIdentity(event.fields);
    }
  }
  Object.assign(expected, {
    agentId: receipt.agentId,
    sessionId: receipt.sessionId,
    inputSessionID: receipt.inputSessionID,
    requestId: receipt.requestId,
    connectionTraceID: receipt.connectionTraceID,
    clientSpanID: receipt.clientSpanID,
    phase: receipt.phase,
    kind: cancelled ? "cancelled" : "ordinary",
    outcome: "failed",
    runId: tag(run, "antnest.run.id"),
    connectionTrace,
  });
  delete expected.closedBeforeResponse;
  // Admission gives the Run its own request_<32hex>; only the RPC ID changes.
  f.set(request, "antnest.request.id", receipt.requestId);
  f.requests.forEach((row, index) =>
    Object.assign(row, {
      phase: receipt.phase,
      stage: index ? "reply" : "tool",
    }),
  );
  if (cancelled) {
    trace.spans.push({
      traceID: trace.traceID,
      spanID: "finish",
      operationName: "SELECT",
      processID: run.processID,
      startTime: end(run) - 1,
      duration: 1,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: run.spanID },
      ],
      tags: [
        { key: "span.kind", value: "client" },
        { key: "db.system.name", value: "postgresql" },
        {
          key: "db.query.text",
          value:
            "WITH finished AS (UPDATE runs SET state = $1) SELECT * FROM finished",
        },
      ],
      logs: [],
    });
    for (const [key, value] of Object.entries({
      error: true,
      "error.type": "Error",
      "otel.status_code": "ERROR",
      "antnest.outcome": "error",
      "antnest.operation.phase": "acp.dispatch",
    }))
      f.set(request, key, value);
    request.logs = [
      f.event(end(request) - 1, "antnest.error", {
        "antnest.error.stage": "acp.dispatch",
        "antnest.error.type": "Error",
        "antnest.error.message": "Error: unregistered message omitted",
        "antnest.error.cause_types": "[]",
        "antnest.error.causes": JSON.stringify([
          { type: "Error", message: "Error: unregistered message omitted" },
        ]),
        "antnest.operation.phase": "acp.dispatch",
      }),
    ];
  }
  const invocationClient = trace.spans.find((span) =>
    f.server.references.some(
      (reference) =>
        reference.refType === "CHILD_OF" && reference.spanID === span.spanID,
    ),
  );
  if (invocationBeforeHeaders) {
    assert(cancelled);
    const responseFields = new Set([
      "http.response.status_code",
      "http.status_code",
      "http.response.body.size",
      "http.transport.outcome",
      "http.transport.error.type",
      "otel.status_code",
      "error",
    ]);
    for (const span of [invocationClient, f.server])
      span.tags = span.tags.filter((field) => !responseFields.has(field.key));
    f.set(f.server, "error.type", "outcome_unknown");
    f.server.logs = [];
  }
  return { ...f, connectionTrace, invocationClient };
}
