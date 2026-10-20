import assert from "node:assert/strict";
import { tag, traceTopology } from "./trace-tree.mjs";

const one = (items, message) => {
  assert.equal(items.length, 1, message);
  return items[0];
};
const values = (fields = []) => {
  const result = Object.fromEntries(
    fields.map(({ key, value }) => [key, value]),
  );
  assert.equal(
    Object.keys(result).length,
    fields.length,
    "duplicate Runtime read field",
  );
  return result;
};
const end = (span) => {
  assert(
    Number.isFinite(span?.startTime) &&
      Number.isFinite(span?.duration) &&
      span.duration >= 0,
    "unfinished Runtime read span",
  );
  return span.startTime + span.duration;
};
const inside = (child, parent) => {
  assert(
    child.startTime >= parent.startTime && end(child) <= end(parent),
    "Runtime read child outside its owning process span",
  );
};
const expectedTags = (span, expected) => {
  assert(span, "missing Runtime read span");
  for (const [key, value] of Object.entries(expected))
    assert.equal(tag(span, key), value, "wrong Runtime read " + key);
};
const goodOutcomes = ["success", "ok", "completed", "committed", "admitted"];
const diagnosticKey =
  /^(error($|\.)|exception\.|db\.response\.status_code$|antnest\.(error\.|cancellation\.|result$|operation\.phase$|stream\.termination$|http\.request_cancelled$)|otel\.status_|http\.transport\.error\.)/u;
function eventInsideSpan(span, event) {
  assert(
    Number.isFinite(event.timestamp) &&
      event.timestamp >= span.startTime &&
      event.timestamp <= end(span),
    "Runtime read event outside its owning span",
  );
}
function diagnostics(
  span,
  allowed = {},
  eventAllowances = new Map(),
  inspectEvent = eventInsideSpan,
) {
  end(span);
  const groups = [
    { fields: span.tags, allowed },
    ...(span.logs ?? []).map((event) => {
      inspectEvent(span, event);
      return {
        fields: event.fields,
        allowed: eventAllowances.get(event) ?? {},
      };
    }),
  ];
  for (const group of groups)
    for (const [key, value] of Object.entries(values(group.fields))) {
      if (Object.hasOwn(group.allowed, key))
        assert.equal(
          value,
          group.allowed[key],
          "contradictory Runtime read diagnostic",
        );
      else if (["http.response.status_code", "http.status_code"].includes(key))
        assert(
          /^[1-3][0-9]{2}$/u.test(String(value)),
          "failed Runtime read HTTP diagnostic",
        );
      else if (
        [
          "rpc.response.status_code",
          "jsonrpc.error_code",
          "process.exit.code",
        ].includes(key)
      )
        assert.equal(
          value,
          0,
          "failed Runtime read protocol or process status",
        );
      else if (key === "executor.exit.classification")
        assert.equal(
          value,
          "success",
          "failed Runtime read executor classification",
        );
      else if (
        key === "outcome" ||
        key.endsWith(".outcome") ||
        key === "antnest.result"
      )
        assert(goodOutcomes.includes(value), "unrelated Runtime read outcome");
      else if (diagnosticKey.test(key))
        assert(
          (key === "error" && value === false) ||
            (key === "error.type" && value === "") ||
            (key === "antnest.error.class" && value === "none") ||
            (key === "otel.status_code" &&
              ["OK", "UNSET", 0, 1].includes(value)),
          "unrelated Runtime read error diagnostic",
        );
      else if (key === "event")
        assert(
          ![
            "error",
            "exception",
            "antnest.error",
            "antnest.cancelled",
            "antnest.stream.termination",
            "antnest.mcp.discovery.ready",
            "antnest.mcp.resource.read.started",
            "antnest.mcp.resource.validated",
            "antnest.mcp.connection.close.started",
            "antnest.mcp.connection.close.completed",
          ].includes(value),
          "unowned Runtime read lifecycle event",
        );
      else if (key === "level")
        assert(
          !["WARN", "ERROR", "FATAL"].includes(value),
          "unrelated Runtime read warning",
        );
    }
}
const eventValues = (event) => values(event?.fields);
function exactEvent(span, name, expected) {
  const event = one(
    (span.logs ?? []).filter((event) => eventValues(event).event === name),
    "missing or duplicate " + name,
  );
  assert.deepEqual(eventValues(event), { event: name, ...expected });
  return event;
}
function completion(span, name, expected) {
  const event = one(
    (span.logs ?? []).filter((event) => eventValues(event).event === name),
    "missing or duplicate " + name,
  );
  expectedTags({ tags: event.fields }, { event: name, ...expected });
  return event;
}
function sameProcess(trace, span, parent, service) {
  assert.equal(trace.processes?.[span?.processID]?.serviceName, service);
  assert.equal(
    span.processID,
    parent.processID,
    "foreign Runtime read process",
  );
  values(trace.processes[span.processID].tags ?? []);
}
function http200(span) {
  assert(
    [200, "200"].includes(tag(span, "http.response.status_code")),
    "failed Runtime read HTTP",
  );
}
const record = (span, event, reason) => ({
  trace_id: span.traceID,
  span_id: span.spanID,
  event_index: span.logs.indexOf(event),
  event_timestamp_us: event.timestamp,
  reason,
});

function requestDiagnostics(request, read, outcome, nodeBefore) {
  if (outcome === "success") return diagnostics(request);
  if (outcome === "failed-v1-run-response")
    return failedRunResponseDiagnostics(request, read, nodeBefore);
  assert.equal(
    outcome,
    "closed-v1-response",
    "unknown Runtime read parent outcome",
  );
  assert.equal(request.operationName, "acp session/prompt");
  expectedTags(request, {
    "span.kind": "server",
    "rpc.method": "session/prompt",
    "antnest.protocol.version": "v1",
    error: true,
    "error.type": "Error",
    "antnest.outcome": "error",
    "antnest.operation.phase": "acp.dispatch",
  });
  const status = tag(request, "otel.status_code");
  assert(["ERROR", 2].includes(status), "missing closed response error status");
  for (const key of [
    "error.code",
    "antnest.error.code",
    "rpc.response.status_code",
    "antnest.error.origin_trace_id",
    "antnest.error.origin_span_id",
  ])
    assert.equal(
      tag(request, key),
      undefined,
      "unproved closed response error origin or code",
    );
  assert.equal(
    request.logs?.length,
    1,
    "closed response requires its original error event",
  );
  const event = request.logs[0],
    attributes = eventValues(event);
  const types = attributes["antnest.error.cause_types"];
  assert(
    types === "[]" || (Array.isArray(types) && types.length === 0),
    "unknown closed response cause types",
  );
  const causes = attributes["antnest.error.causes"];
  assert.equal(typeof causes, "string");
  assert.deepEqual(
    JSON.parse(causes),
    [{ type: "Error", message: "Error: unregistered message omitted" }],
    "unknown closed response cause",
  );
  exactEvent(request, "antnest.error", {
    "antnest.error.stage": "acp.dispatch",
    "antnest.error.type": "Error",
    "antnest.error.message": "Error: unregistered message omitted",
    "antnest.error.cause_types": types,
    "antnest.error.causes": causes,
    "antnest.operation.phase": "acp.dispatch",
  });
  nodeBefore(
    read,
    request,
    end(read),
    event.timestamp,
    "read-before-response-error",
  );
  diagnostics(
    request,
    {
      error: true,
      "error.type": "Error",
      "otel.status_code": status,
      "antnest.outcome": "error",
      "antnest.operation.phase": "acp.dispatch",
    },
    new Map([[event, attributes]]),
  );
}

// This proves only that the independent refresh finished before dispatch
// reported its v1 Run failure. Its caller still owns the RPC/Run/model errors
// and must bind the actual wire result and durable Run outcome separately.
function failedRunResponseDiagnostics(request, read, nodeBefore) {
  assert(
    ["acp session/prompt", "HTTP POST /v1/acp"].includes(request.operationName),
  );
  if (request.operationName === "HTTP POST /v1/acp") {
    expectedTags(request, {
      "http.request.method": "POST",
      "http.route": "/v1/acp",
      "http.response.status_code": 202,
    });
  }
  expectedTags(request, {
    "span.kind": "server",
    "rpc.method": "session/prompt",
    "antnest.protocol.version": "v1",
    "error.type": "RequestError",
    "error.code": "-32022",
    "antnest.error.code": "-32022",
    "rpc.response.status_code": -32022,
    "antnest.outcome": "error",
    "antnest.operation.phase": "acp.dispatch",
  });
  const status = tag(request, "otel.status_code");
  assert(["ERROR", 2].includes(status));
  const legacy = tag(request, "error");
  assert(legacy === undefined || legacy === true);
  for (const key of [
    "antnest.error.origin_trace_id",
    "antnest.error.origin_span_id",
  ])
    assert.equal(
      tag(request, key),
      undefined,
      "unproved failed Run response origin",
    );
  assert.equal(
    request.logs?.length,
    1,
    "one original Run response error event required",
  );
  const event = request.logs[0],
    attributes = eventValues(event);
  const types = attributes["antnest.error.cause_types"];
  assert(types === "[]" || (Array.isArray(types) && types.length === 0));
  const causes = attributes["antnest.error.causes"];
  assert.equal(typeof causes, "string");
  assert.deepEqual(JSON.parse(causes), [
    {
      type: "RequestError",
      code: -32022,
      message: "Operation reported -32022",
    },
  ]);
  exactEvent(request, "antnest.error", {
    "antnest.error.stage": "acp.dispatch",
    "antnest.error.type": "RequestError",
    "antnest.error.code": "-32022",
    "antnest.error.message": "Operation reported -32022",
    "antnest.error.cause_types": types,
    "antnest.error.causes": causes,
    "antnest.operation.phase": "acp.dispatch",
  });
  nodeBefore(
    read,
    request,
    end(read),
    event.timestamp,
    "read-before-response-error",
  );
  diagnostics(
    request,
    {
      "error.type": "RequestError",
      "error.code": "-32022",
      "antnest.error.code": "-32022",
      "rpc.response.status_code": -32022,
      "otel.status_code": status,
      "antnest.outcome": "error",
      "antnest.operation.phase": "acp.dispatch",
      ...(legacy === undefined ? {} : { error: true }),
    },
    new Map([[event, attributes]]),
  );
}

/** Original read/parse/owned-close receipt, with every HTTP exchange accounted for. */
export function inspectRuntimeInformationRead(
  trace,
  read,
  { requestOutcome = "success" } = {},
) {
  const tree = traceTopology(trace);
  const timeObservations = [];
  const runtimeEvent = (span, event) => {
    const finishAt = end(span);
    assert.equal(tree.service(span), "antnest-runtime");
    assert(
      [
        span.startTime,
        span.duration,
        finishAt,
        finishAt + 2,
        event.timestamp,
      ].every(Number.isSafeInteger) &&
        event.timestamp >= span.startTime &&
        event.timestamp < finishAt + 2,
      "Runtime read event outside microsecond representation interval",
    );
    if (event.timestamp <= finishAt) return;
    const resource = values(trace.processes[span.processID].tags ?? []);
    assert.equal(resource["telemetry.sdk.language"], "rust");
    assert.equal(resource["telemetry.sdk.name"], "opentelemetry");
    // Jaeger represents start, duration and event independently in integer
    // microseconds. Record the overlap, never invent nanosecond ordering.
    timeObservations.push({
      trace_id: trace.traceID,
      read_span_id: read.spanID,
      span_id: span.spanID,
      process_id: span.processID,
      boundary: "runtime-event-within-span",
      event_index: span.logs.indexOf(event),
      raw_left_us: event.timestamp,
      raw_right_us: finishAt,
      raw_difference_us: event.timestamp - finishAt,
      raw_span_start_us: span.startTime,
      raw_span_duration_us: span.duration,
      representation_us: 1,
      reason: "jaeger-integer-microsecond-representation",
    });
  };
  // Node spans use millisecond wall-clock start anchors and high-resolution
  // durations. Preserve each original cross-span discrepancy independently;
  // never adjust timestamps or reuse an allowance at a second boundary.
  const nodeBefore = (child, parent, left, right, boundary) => {
    assert(
      Number.isFinite(left) && Number.isFinite(right),
      "invalid Runtime read endpoint",
    );
    if (left <= right) return;
    sameProcess(trace, child, parent, "agent-acp-service");
    assert.equal(tree.parent(child), parent, "unowned Runtime read endpoint");
    const resource = values(trace.processes[child.processID].tags ?? []);
    assert(
      typeof resource["host.name"] === "string" &&
        resource["host.name"].length > 0 &&
        Number.isSafeInteger(resource["process.pid"]) &&
        resource["process.pid"] > 0 &&
        typeof resource["service.instance.id"] === "string" &&
        resource["service.instance.id"].length > 0,
      "missing actual Runtime read process identity",
    );
    assert(
      [child, parent].every(
        (span) =>
          Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
      ) && left - right < 1000,
      "Runtime read endpoint outside deferred same-Node sub-ms boundary: " +
        boundary,
    );
    timeObservations.push({
      trace_id: trace.traceID,
      read_span_id: read.spanID,
      span_id: child.spanID,
      parent_span_id: parent.spanID,
      process_id: child.processID,
      host_name: resource["host.name"],
      process_pid: resource["process.pid"],
      service_instance_id: resource["service.instance.id"],
      boundary,
      raw_left_us: left,
      raw_right_us: right,
      raw_difference_us: left - right,
      raw_child_start_us: child.startTime,
      raw_parent_start_us: parent.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  };
  const nodeInside = (child, parent, boundary) => {
    assert(
      child.startTime >= parent.startTime,
      "Runtime read child precedes its owner",
    );
    nodeBefore(child, parent, end(child), end(parent), boundary);
  };
  assert.equal(
    tree.spans.get(read?.spanID),
    read,
    "foreign Runtime read receipt",
  );
  assert.equal(read.operationName, "mcp.runtime.info.read");
  assert.equal(tree.service(read), "agent-acp-service");
  expectedTags(read, {
    "span.kind": "internal",
    "antnest.mcp.resource_read.outcome": "success",
    "antnest.mcp.connection.close.outcome": "closed",
    "antnest.mcp.caller_cancelled": false,
  });
  const execution = tag(read, "antnest.runtime.execution.id");
  assert(
    typeof execution === "string" && execution.length > 0,
    "missing Runtime read execution",
  );
  const request = tree.parent(read);
  assert(request, "unparented Runtime information read");
  sameProcess(trace, read, request, "agent-acp-service");
  nodeInside(read, request, "read-joined-by-request");
  requestDiagnostics(request, read, requestOutcome, nodeBefore);
  const discoveryReady = exactEvent(read, "antnest.mcp.discovery.ready", {});
  const readStarted = exactEvent(read, "antnest.mcp.resource.read.started", {});
  const validated = exactEvent(read, "antnest.mcp.resource.validated", {});
  const closeStarted = exactEvent(
    read,
    "antnest.mcp.connection.close.started",
    {
      "antnest.mcp.caller_cancelled": false,
    },
  );
  const closeCompleted = exactEvent(
    read,
    "antnest.mcp.connection.close.completed",
    { outcome: "closed" },
  );
  const lifecycle = [
    discoveryReady,
    readStarted,
    validated,
    closeStarted,
    closeCompleted,
  ];
  // Jaeger may return events in name order. Verify the original timestamps
  // without sorting or rewriting the backend's inventory.
  assert.equal(
    read.logs.length,
    lifecycle.length,
    "missing or extra Runtime read lifecycle event",
  );
  assert(
    lifecycle.every(
      (event, index) =>
        index === 0 || lifecycle[index - 1].timestamp <= event.timestamp,
    ),
    "wrong Runtime read lifecycle order",
  );
  diagnostics(
    read,
    { "antnest.mcp.connection.close.outcome": "closed" },
    new Map(lifecycle.map((event) => [event, eventValues(event)])),
  );
  const children = (parent) =>
    trace.spans.filter((span) => tree.parent(span) === parent);
  const clients = children(read);
  assert.equal(
    clients.length,
    2,
    "Runtime read requires exact discovery and resource clients",
  );
  const spans = [read],
    exchanges = [],
    neutralDiagnostics = [];
  for (const client of clients) {
    sameProcess(trace, client, read, "agent-acp-service");
    assert.equal(client.operationName, "HTTP POST antnest-runtime");
    expectedTags(client, {
      "span.kind": "client",
      "http.request.method": "POST",
      "peer.service": "antnest-runtime",
    });
    http200(client);
    nodeInside(client, read, "client-joined-by-read");
    nodeBefore(
      client,
      read,
      end(client),
      closeCompleted.timestamp,
      "client-joined-at-close",
    );
    const server = one(
      children(client),
      "missing or extra Runtime HTTP server",
    );
    assert.equal(tree.service(server), "antnest-runtime");
    assert.equal(server.operationName, "HTTP POST /mcp");
    const method = tag(server, "rpc.method");
    assert(
      ["discover", "resources/read"].includes(method),
      "Runtime read executed a tool",
    );
    expectedTags(server, {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/mcp",
      "antnest.protocol.outcome": "success",
      "antnest.runtime.execution.id": execution,
    });
    http200(server);
    const agent = tag(server, "antnest.agent.id"),
      generation = tag(server, "antnest.runtime.generation");
    assert(typeof agent === "string" && agent.length > 0);
    assert(typeof generation === "string" && generation.length > 0);
    const bytes = tag(server, "http.response.body.size");
    assert(
      Number.isSafeInteger(bytes) && bytes > 0,
      "missing Runtime response byte count",
    );
    assert.equal(
      tag(client, "http.response.body.size"),
      bytes,
      "Runtime read byte count mismatch",
    );
    const cancelledClient = tag(client, "antnest.outcome") === "cancelled";
    const clientAllowed = cancelledClient
      ? {
          "antnest.operation.phase": "http.send_or_read",
          "antnest.outcome": "cancelled",
          "antnest.cancellation.type": "AbortError",
        }
      : {};
    expectedTags(client, clientAllowed);
    if (cancelledClient) {
      // Closing this validated read's SDK connection also aborts a discovery
      // response that was parsed successfully but has not reached HTTP EOF.
      // Both exact CLIENT children require the same original owned-close proof.
      assert.equal(client.logs?.length, 1);
      const cancelled = exactEvent(client, "antnest.cancelled", {
        "antnest.cancellation.type": "AbortError",
        "antnest.cancellation.phase": "http.send_or_read",
      });
      nodeBefore(
        client,
        read,
        closeStarted.timestamp,
        cancelled.timestamp,
        "client-cancel-after-close-start",
      );
      nodeBefore(
        client,
        read,
        cancelled.timestamp,
        closeCompleted.timestamp,
        "client-cancel-before-close-complete",
      );
      diagnostics(
        client,
        clientAllowed,
        new Map([[cancelled, eventValues(cancelled)]]),
      );
      neutralDiagnostics.push(
        record(client, cancelled, "completed-runtime-information-read-cleanup"),
      );
    } else {
      assert.equal(
        client.logs?.length ?? 0,
        0,
        "extra successful Runtime client event",
      );
      diagnostics(client);
    }
    const transport = tag(server, "http.transport.outcome");
    assert(
      ["success", "canceled"].includes(transport),
      "failed Runtime read transport",
    );
    if (transport === "canceled") {
      assert(
        cancelledClient && method === "resources/read",
        "Runtime cancellation lacks owning client close",
      );
      expectedTags(server, {
        "http.transport.error.type": "client_disconnected",
      });
    }
    const operation = one(
      children(server),
      "missing or extra Runtime MCP operation",
    );
    sameProcess(trace, operation, server, "antnest-runtime");
    assert.equal(operation.operationName, "runtime.mcp.operation");
    expectedTags(operation, {
      "span.kind": "internal",
      "rpc.method": method,
      "antnest.agent.id": agent,
      "antnest.runtime.execution.id": execution,
      "antnest.runtime.generation": generation,
      "otel.status_code": "OK",
      "mcp.operation.outcome": "success",
      "antnest.operation.outcome": "success",
    });
    inside(operation, server);
    const operationCompleted = completion(
      operation,
      "Runtime MCP operation completed",
      {
        level: "INFO",
        "service.name": "antnest-runtime",
        trace_id: trace.traceID,
        span_id: operation.spanID,
        "antnest.agent.id": agent,
        "antnest.runtime.generation": generation,
        "mcp.operation.name": method,
        "mcp.operation.outcome": "success",
        "error.type": "",
      },
    );
    assert.equal(operation.logs.length, 1);
    diagnostics(operation, {}, new Map(), runtimeEvent);
    const completed = completion(server, "Runtime HTTP request completed", {
      level: transport === "canceled" ? "WARN" : "INFO",
      "service.name": "antnest-runtime",
      "http.request.method": "POST",
      "url.path": "/mcp",
      "antnest.agent.id": agent,
      "antnest.runtime.generation": generation,
      trace_id: trace.traceID,
      span_id: server.spanID,
      "error.type": transport === "canceled" ? "client_disconnected" : "",
      "http.transport.outcome": transport,
    });
    http200({ tags: completed.fields });
    assert(
      completed.timestamp >= end(operation) &&
        completed.timestamp >= operationCompleted.timestamp,
      "Runtime completion precedes operation",
    );
    const serverAllowed =
      transport === "canceled"
        ? {
            "http.transport.outcome": "canceled",
            "http.transport.error.type": "client_disconnected",
          }
        : {};
    const eventAllowances = new Map([[completed, eventValues(completed)]]);
    if (transport === "canceled") {
      assert.equal(server.logs.length, 2);
      const cancelled = exactEvent(server, "antnest.cancelled", {
        "antnest.phase": "http",
        "antnest.cancellation.type": "client_disconnected",
        "antnest.protocol.outcome": "success",
      });
      assert(
        cancelled.timestamp >= end(operation) &&
          cancelled.timestamp >= operationCompleted.timestamp &&
          cancelled.timestamp <= completed.timestamp,
        "Runtime cancellation outside operation and HTTP completion order",
      );
      eventAllowances.set(cancelled, eventValues(cancelled));
      neutralDiagnostics.push(
        record(server, completed, "completed-initialize-mcp-read-disconnect"),
      );
    } else assert.equal(server.logs.length, 1);
    // Only the known cancellation keys are exceptions. Successful completion
    // events still pass the same diagnostic allowlist as every other event.
    eventAllowances.set(completed, {
      ...(transport === "canceled"
        ? {
            level: "WARN",
            "error.type": "client_disconnected",
            "http.transport.outcome": "canceled",
          }
        : {}),
    });
    diagnostics(server, serverAllowed, eventAllowances, runtimeEvent);
    spans.push(client, server, operation);
    const descendants = children(operation);
    if (method === "resources/read") {
      const executor = one(
        descendants,
        "missing or extra Runtime information executor",
      );
      sameProcess(trace, executor, operation, "antnest-runtime");
      assert.equal(executor.operationName, "runtime.executor");
      expectedTags(executor, {
        "span.kind": "internal",
        "antnest.agent.id": agent,
        "antnest.runtime.generation": generation,
      });
      inside(executor, operation);
      assert.equal(
        children(executor).length,
        0,
        "unexpected Runtime executor child",
      );
      assert.equal(
        executor.logs?.length,
        1,
        "missing Runtime executor completion",
      );
      const executorCompleted = completion(
        executor,
        "Runtime Executor completed",
        {
          outcome: "success",
          "error.type": "",
          level: "INFO",
          "service.name": "antnest-runtime",
          "antnest.agent.id": agent,
          "antnest.runtime.generation": generation,
          trace_id: trace.traceID,
          span_id: executor.spanID,
        },
      );
      assert(
        operationCompleted.timestamp >= end(executor) &&
          operationCompleted.timestamp >= executorCompleted.timestamp,
        "MCP completion precedes executor join",
      );
      diagnostics(executor, {}, new Map(), runtimeEvent);
      spans.push(executor);
    } else
      assert.equal(descendants.length, 0, "discovery executed Runtime work");
    exchanges.push({
      client,
      server,
      operation,
      completion: completed,
      operationCompleted,
      method,
      agent,
      generation,
    });
  }
  const discovery = one(
    exchanges.filter((e) => e.method === "discover"),
    "missing or duplicate discovery",
  );
  const resource = one(
    exchanges.filter((e) => e.method === "resources/read"),
    "missing or duplicate resource read",
  );
  assert.equal(discovery.agent, resource.agent, "different Runtime read Agent");
  assert.equal(
    discovery.generation,
    resource.generation,
    "different Runtime read generation",
  );
  sameProcess(trace, discovery.server, resource.server, "antnest-runtime");
  assert(
    resource.client.startTime <= validated.timestamp,
    "Runtime request started after parsed receipt",
  );
  nodeBefore(
    discovery.client,
    read,
    discovery.client.startTime,
    discoveryReady.timestamp,
    "discovery-client-before-ready",
  );
  nodeBefore(
    resource.client,
    read,
    readStarted.timestamp,
    resource.client.startTime,
    "dispatch-before-resource-client",
  );
  return {
    read,
    request,
    clients,
    servers: exchanges.map((e) => e.server),
    spans,
    resource,
    discovery,
    agentId: resource.agent,
    executionId: execution,
    events: {
      discoveryReady,
      readStarted,
      validated,
      closeStarted,
      closeCompleted,
    },
    neutralDiagnostics,
    timeObservations,
  };
}
