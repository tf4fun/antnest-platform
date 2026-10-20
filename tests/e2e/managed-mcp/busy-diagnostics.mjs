import assert from "node:assert/strict";
import { tag } from "../observability/trace-tree.mjs";
import { assertPrivateACPApplicationJoined } from "../observability/private-acp-diagnostics.mjs";

function withoutCommandFields(fields, allowed) {
  assert.equal(
    new Set(fields.map((field) => field.key)).size,
    fields.length,
    "duplicate command diagnostic field",
  );
  for (const [key, value] of Object.entries(allowed))
    assert.deepEqual(
      fields.find((field) => field.key === key)?.value,
      value,
      "contradictory command diagnostic field",
    );
  return fields.filter((field) => !Object.hasOwn(allowed, field.key));
}

export function managedBusyRejection(
  trace,
  tree,
  request,
  expected,
  timeObservations,
) {
  assert.equal(expected.rejection, "agent_busy");
  assert.equal(expected.method, "session/prompt");
  assert.deepEqual(
    expected.rejectionReceipt,
    {
      rpcCode: -32020,
      code: expected.rejection,
      retryable: false,
    },
    "actual command rejection receipt required",
  );
  const method = expected.method.split("/")[1];
  assert(
    ["new", "load", "resume", "fork", "prompt", "close", "delete"].includes(
      method,
    ),
  );
  const operation = `acp.session.${method === "load" ? "resume" : method}`;
  const applications = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      span.operationName === operation,
  );
  assert.equal(
    applications.length,
    1,
    "one application rejection cause required",
  );
  const application = applications[0];
  assert.equal(
    tree.parent(application),
    request,
    "rejection cause belongs to another request",
  );
  assertPrivateACPApplicationJoined(
    trace,
    request,
    application,
    timeObservations,
    "rejection-cause-joined-by-rpc",
  );
  assert.equal(tag(application, "span.kind"), "internal");
  assert.equal(tag(application, "antnest.agent.id"), expected.agentId);
  assert.equal(
    tag(application, "antnest.session.id"),
    expected.inputSessionID ?? undefined,
  );
  assert.equal(
    request.logs?.length ?? 0,
    0,
    "duplicate or unrelated RPC error event",
  );
  assert.equal(
    application.logs?.length,
    1,
    "one original application error event required",
  );
  const event = application.logs[0];
  assert(
    Number.isFinite(event.timestamp) &&
      event.timestamp >= application.startTime &&
      event.timestamp <= application.startTime + application.duration,
    "application error event outside its owning span",
  );
  const fields = Object.fromEntries(
    event.fields.map(({ key, value }) => [key, value]),
  );
  const types = fields["antnest.error.cause_types"];
  assert.deepEqual(typeof types === "string" ? JSON.parse(types) : types, []);
  const causes = fields["antnest.error.causes"];
  assert.equal(typeof causes, "string");
  const code = "agent_busy";
  const message = "Operation reported agent_busy";
  assert.deepEqual(JSON.parse(causes), [
    { type: "DomainError", ...(code ? { code } : {}), message },
  ]);
  const applicationTags = withoutCommandFields(application.tags, {
    "error.type": "DomainError",
    "antnest.outcome": "rejected",
    "antnest.operation.phase": operation,
    ...(code ? { "error.code": code, "antnest.error.code": code } : {}),
  });
  const eventFields = withoutCommandFields(event.fields, {
    event: "antnest.error",
    "antnest.error.stage": operation,
    "antnest.operation.phase": operation,
    "antnest.error.type": "DomainError",
    ...(code ? { "antnest.error.code": code } : {}),
    "antnest.error.message": message,
    "antnest.error.cause_types": types,
    "antnest.error.causes": causes,
  });
  const rpcTags = withoutCommandFields(request.tags, {
    "error.type": "RequestError",
    "antnest.outcome": "rejected",
    "antnest.operation.phase": "acp.dispatch",
    "error.code": "-32020",
    "antnest.error.code": "-32020",
    "rpc.response.status_code": -32020,
    "antnest.error.origin_trace_id": trace.traceID,
    "antnest.error.origin_span_id": application.spanID,
  });
  return {
    views: new Map([
      [
        application,
        {
          ...application,
          tags: applicationTags,
          logs: [{ ...event, fields: eventFields }],
        },
      ],
      [request, { ...request, tags: rpcTags }],
    ]),
    records: [application, request].map((span) => ({
      trace_id: trace.traceID,
      span_id: span.spanID,
      reason: "managed-busy-rejection",
      rejection: expected.rejection,
      request_id: expected.requestId,
      origin_span_id: application.spanID,
    })),
  };
}
