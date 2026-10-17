import assert from "node:assert/strict";
import { tag } from "./trace-tree.mjs";

export function privateACPProcessIdentity(trace, span) {
  const resource = trace.processes[span.processID];
  assert.equal(resource?.serviceName, "agent-acp-service");
  const fields = new Map();
  for (const { key, value } of resource.tags ?? []) {
    assert(!fields.has(key), "duplicate private ACP resource attribute");
    fields.set(key, value);
  }
  for (const key of ["host.name", "service.instance.id"])
    assert(
      typeof fields.get(key) === "string" && fields.get(key).length > 0,
      "HTTP receiver process identity missing",
    );
  assert(
    Number.isSafeInteger(fields.get("process.pid")) &&
      fields.get("process.pid") > 0,
  );
  return [
    fields.get("host.name"),
    fields.get("process.pid"),
    fields.get("service.instance.id"),
  ];
}

// These records are produced by the complete Runtime read/tool proofs above
// this check, never accepted from the caller. Build a validation-only view:
// retain the original trace and inspect every field outside the exact cleanup.
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

export function privateACPDiagnosticView(
  trace,
  span,
  neutralDiagnostics,
  runtimeSpans,
) {
  for (const fields of [
    span.tags ?? [],
    ...(span.logs ?? []).map((event) => event.fields ?? []),
  ])
    assert.equal(
      new Set(fields.map((field) => field.key)).size,
      fields.length,
      "duplicate command diagnostic field",
    );
  const remove = withoutCommandFields;
  let tags = span.tags;
  const events = new Map();
  if (
    runtimeSpans.has(span) &&
    tag(span, "antnest.mcp.connection.close.outcome") !== undefined
  ) {
    tags = remove(tags, { "antnest.mcp.connection.close.outcome": "closed" });
    const completed = span.logs.filter(
      (item) =>
        tag({ tags: item.fields }, "event") ===
        "antnest.mcp.connection.close.completed",
    );
    assert.equal(completed.length, 1);
    events.set(completed[0], { outcome: "closed" });
  }
  const claims = neutralDiagnostics.filter(
    (claim) => claim.span_id === span.spanID,
  );
  assert(claims.length <= 1, "duplicate command cleanup claim");
  const claim = claims[0];
  const event = claim ? span.logs[claim.event_index] : undefined;
  if (claim) {
    assert(runtimeSpans.has(span), "cleanup outside complete Runtime proof");
    assert.equal(claim.trace_id, trace.traceID);
    assert.equal(event?.timestamp, claim.event_timestamp_us);
  }
  if (
    claim &&
    [
      "completed-runtime-information-read-cleanup",
      "parsed-runtime-tool-connection-cleanup",
    ].includes(claim.reason)
  ) {
    tags = remove(span.tags, {
      "antnest.operation.phase": "http.send_or_read",
      "antnest.outcome": "cancelled",
      "antnest.cancellation.type": "AbortError",
    });
    events.set(event, {
      event: "antnest.cancelled",
      "antnest.cancellation.type": "AbortError",
      "antnest.cancellation.phase": "http.send_or_read",
    });
  } else if (claim) {
    assert(
      [
        "completed-initialize-mcp-read-disconnect",
        "completed-runtime-tool-http-disconnect",
      ].includes(claim.reason),
      "unrecognized command cleanup proof",
    );
    tags = remove(span.tags, {
      "http.transport.outcome": "canceled",
      "http.transport.error.type": "client_disconnected",
    });
    assert.equal(
      tag({ tags: event.fields }, "event"),
      "Runtime HTTP request completed",
    );
    events.set(event, {
      level: "WARN",
      "error.type": "client_disconnected",
      "http.transport.outcome": "canceled",
    });
    const cancellations = span.logs.filter(
      (item) => tag({ tags: item.fields }, "event") === "antnest.cancelled",
    );
    assert.equal(cancellations.length, 1);
    events.set(cancellations[0], {
      event: "antnest.cancelled",
      "antnest.phase": "http",
      "antnest.cancellation.type": "client_disconnected",
      "antnest.protocol.outcome": "success",
    });
  }
  return {
    ...span,
    tags,
    logs: (span.logs ?? []).map((item) => ({
      ...item,
      fields: events.has(item)
        ? remove(item.fields, events.get(item))
        : item.fields,
    })),
  };
}

export function assertPrivateACPApplicationJoined(
  trace,
  request,
  application,
  timeObservations,
  boundary,
) {
  assert.deepEqual(
    privateACPProcessIdentity(trace, application),
    privateACPProcessIdentity(trace, request),
  );
  for (const span of [application, request])
    assert(
      Number.isFinite(span.startTime) &&
        Number.isFinite(span.duration) &&
        span.duration >= 0 &&
        Number.isFinite(span.startTime + span.duration),
      "unfinished command rejection span",
    );
  assert(
    application.startTime >= request.startTime,
    "application rejection precedes RPC",
  );
  const applicationEnd = application.startTime + application.duration;
  const requestEnd = request.startTime + request.duration;
  if (applicationEnd > requestEnd) {
    assert(
      [application, request].every(
        (span) =>
          Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
      ) && applicationEnd - requestEnd < 1000,
      "application rejection was not joined by its RPC",
    );
    const [host, pid, instance] = privateACPProcessIdentity(trace, application);
    timeObservations.push({
      trace_id: trace.traceID,
      span_id: application.spanID,
      parent_span_id: request.spanID,
      process_id: application.processID,
      host_name: host,
      process_pid: pid,
      service_instance_id: instance,
      boundary,
      raw_left_us: applicationEnd,
      raw_right_us: requestEnd,
      raw_difference_us: applicationEnd - requestEnd,
      raw_child_start_us: application.startTime,
      raw_parent_start_us: request.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  }
}

export function privateACPRejection(
  trace,
  tree,
  request,
  expected,
  timeObservations,
) {
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
  assert(["new", "load", "resume", "fork", "prompt"].includes(method));
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
  const code =
    expected.rejection === "access_denied" ? "access_denied" : undefined;
  const message = code
    ? "Agent access was denied"
    : "DomainError: unregistered message omitted";
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
      reason: "command-rejection",
      rejection: expected.rejection,
      request_id: expected.requestId,
      origin_span_id: application.spanID,
    })),
  };
}
