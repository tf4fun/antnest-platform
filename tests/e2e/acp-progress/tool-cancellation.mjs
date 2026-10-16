import assert from "node:assert/strict";
import { tag } from "../observability/trace-tree.mjs";
import { inspectRuntimeToolInventory } from "../observability/runtime-tool-inventory.mjs";
import {
  one,
  values,
  end,
  expected,
  eventValues,
  namedEvent,
  exactEvent,
  http200,
  diagnostics,
} from "../observability/runtime-tool-evidence.mjs";

const unknown = "Execution ended without a confirmed effect outcome";
function errorStatus(span) {
  const status = tag(span, "otel.status_code");
  assert(
    ["ERROR", 2].includes(status),
    "missing original cancellation ERROR status",
  );
  const allowed = { "otel.status_code": status };
  if (tag(span, "error") !== undefined) {
    assert.equal(tag(span, "error"), true);
    allowed.error = true;
  }
  return allowed;
}
function errorEvent(span, stage, code, message, causes) {
  const event = namedEvent(span, "antnest.error");
  const fields = {
    "antnest.error.stage": stage,
    "antnest.error.type": code,
    "antnest.error.code": code,
    "antnest.error.message": message,
  };
  if (causes) {
    const raw = eventValues(event)["antnest.error.cause_types"];
    assert.deepEqual(typeof raw === "string" ? JSON.parse(raw) : raw, causes);
    fields["antnest.error.cause_types"] = raw;
  }
  exactEvent(span, "antnest.error", fields);
  return event;
}

// Only the dispatched Progress cancellation path uses this proof. A closed
// connection never changes the unknown business result into parsed success.
export function inspectProgressCancellation(
  trace,
  owner,
  identity,
  { kind, toolName },
) {
  assert(["bash", "managed"].includes(kind));
  assert.equal(toolName, kind === "bash" ? "bash" : "mcp__fixture__progress");
  const proof = inspectRuntimeToolInventory(trace, owner, identity);
  const {
    tree,
    children,
    discovery,
    invocation,
    eventsInside,
    nodeBefore,
    ownedCancellations,
  } = proof;
  const { agentId, executionId } = identity;
  const checkedSpans = new Set(),
    workTimeObservations = [];
  const check = (span, allowed, events) => {
    assert.equal(
      span.logs?.length ?? 0,
      events.size,
      "extra cancellation diagnostic event",
    );
    diagnostics(span, allowed, events);
    checkedSpans.add(span);
  };
  const completionAllowed = new Map();
  const completion = (span, name, fields) => {
    const event = namedEvent(span, name);
    const required = { event: name, ...fields };
    expected({ tags: event.fields }, required);
    completionAllowed.set(event, required);
    return event;
  };
  const eventMap = (events) =>
    new Map(
      events.map((event) => [
        event,
        completionAllowed.get(event) ?? eventValues(event),
      ]),
    );
  expected(owner, {
    "tool.name": toolName,
    "antnest.runtime.execution_id": executionId,
    "antnest.mcp.method": "tools/call",
    "antnest.mcp.tool_result.outcome": "not_received",
    "antnest.mcp.connection.close.outcome": "closed",
    "antnest.mcp.caller_cancelled": true,
    "antnest.outcome": "error",
    "antnest.operation.phase": "mcp.tools.call",
    "error.type": "McpToolCallError",
  });
  const ready = exactEvent(owner, "antnest.mcp.discovery.ready");
  const dispatch = exactEvent(owner, "antnest.mcp.tool.dispatch.started");
  const closeStarted = exactEvent(
    owner,
    "antnest.mcp.connection.close.started",
    { "antnest.mcp.caller_cancelled": true },
  );
  const closeCompleted = exactEvent(
    owner,
    "antnest.mcp.connection.close.completed",
    { outcome: "closed" },
  );
  const failure = namedEvent(owner, "antnest.error"),
    fields = eventValues(failure);
  const causeTypes = fields["antnest.error.cause_types"],
    causes = fields["antnest.error.causes"];
  assert.deepEqual(
    typeof causeTypes === "string" ? JSON.parse(causeTypes) : causeTypes,
    ["Error"],
  );
  assert.equal(typeof causes, "string");
  assert.deepEqual(JSON.parse(causes), [
    {
      type: "McpToolCallError",
      message: "McpToolCallError: unregistered message omitted",
    },
    { type: "Error", message: "Error: unregistered message omitted" },
  ]);
  exactEvent(owner, "antnest.error", {
    "antnest.error.stage": "mcp.tools.call",
    "antnest.operation.phase": "mcp.tools.call",
    "antnest.error.type": "McpToolCallError",
    "antnest.error.message": "McpToolCallError: unregistered message omitted",
    "antnest.error.cause_types": causeTypes,
    "antnest.error.causes": causes,
  });
  const lifecycle = [ready, dispatch, closeStarted, closeCompleted, failure];
  assert(
    lifecycle.every(
      (event, index) =>
        !index || lifecycle[index - 1].timestamp <= event.timestamp,
    ),
    "wrong cancellation lifecycle order",
  );
  eventsInside(owner);
  check(
    owner,
    {
      ...errorStatus(owner),
      "error.type": "McpToolCallError",
      "antnest.outcome": "error",
      "antnest.operation.phase": "mcp.tools.call",
      "antnest.mcp.tool_result.outcome": "not_received",
      "antnest.mcp.connection.close.outcome": "closed",
    },
    eventMap(lifecycle),
  );

  for (const pair of proof.exchanges) {
    const { client } = pair;
    http200(client);
    eventsInside(client);
    assert(client.startTime >= owner.startTime);
    assert(
      Number.isSafeInteger(tag(client, "http.response.body.size")) &&
        tag(client, "http.response.body.size") >= 0,
      "missing actual received byte count",
    );
    nodeBefore(
      client,
      owner,
      end(client),
      closeCompleted.timestamp,
      "cancel-client-joined-at-close",
    );
    nodeBefore(
      client,
      owner,
      end(client),
      end(owner),
      "cancel-client-joined-by-tool",
    );
    const cancelled = tag(client, "antnest.outcome") === "cancelled";
    if (pair === invocation)
      assert(cancelled, "invocation lacks original caller abort");
    if (cancelled) {
      const allowed = {
        "antnest.outcome": "cancelled",
        "antnest.operation.phase": "http.send_or_read",
        "antnest.cancellation.type": "AbortError",
      };
      expected(client, allowed);
      const event = exactEvent(client, "antnest.cancelled", {
        "antnest.cancellation.type": "AbortError",
        "antnest.cancellation.phase": "http.send_or_read",
      });
      nodeBefore(
        client,
        owner,
        pair === discovery ? closeStarted.timestamp : dispatch.timestamp,
        event.timestamp,
        "cancel-client-after-owned-trigger",
      );
      nodeBefore(
        client,
        owner,
        event.timestamp,
        closeCompleted.timestamp,
        "cancel-client-before-joined-close",
      );
      check(client, allowed, eventMap([event]));
      ownedCancellations.add(client);
    } else check(client, {}, new Map());
  }
  nodeBefore(
    discovery.client,
    owner,
    discovery.client.startTime,
    ready.timestamp,
    "cancel-discovery-before-ready",
  );
  nodeBefore(
    invocation.client,
    owner,
    dispatch.timestamp,
    invocation.client.startTime,
    "cancel-dispatch-before-invocation",
  );
  assert(invocation.client.startTime <= closeStarted.timestamp);

  const logIdentity = (span) => ({
    "service.name": "antnest-runtime",
    "antnest.agent.id": agentId,
    "antnest.runtime.generation": invocation.generation,
    trace_id: trace.traceID,
    span_id: span.spanID,
  });
  const operationCode =
    kind === "bash" ? "outcome_unknown" : "managed_tool_error";
  for (const pair of proof.exchanges) {
    const { client, server, operation } = pair,
      cancelled = pair === invocation;
    const outcome = cancelled ? "error" : "success",
      code = cancelled ? operationCode : "";
    http200(server);
    eventsInside(server, true);
    eventsInside(operation, true);
    expected(server, { "antnest.protocol.outcome": outcome });
    const bytes = tag(server, "http.response.body.size");
    assert(Number.isSafeInteger(bytes) && bytes > 0);
    if (!cancelled)
      assert.equal(
        bytes,
        tag(client, "http.response.body.size"),
        "discovery response was not fully received",
      );
    expected(operation, {
      "mcp.operation.name": pair.method,
      "mcp.operation.outcome": outcome,
      "antnest.operation.outcome": outcome,
    });
    const completed = completion(operation, "Runtime MCP operation completed", {
      ...logIdentity(operation),
      event: "Runtime MCP operation completed",
      level: "INFO",
      "mcp.operation.name": pair.method,
      "mcp.operation.outcome": outcome,
      "error.type": code,
    });
    if (cancelled) {
      expected(operation, { "mcp.tool.name": toolName, "error.type": code });
      const error = errorEvent(
        operation,
        "mcp.dispatch",
        code,
        "Tool returned an unsuccessful protocol result",
      );
      assert(error.timestamp <= completed.timestamp);
      check(
        operation,
        {
          ...errorStatus(operation),
          "error.type": code,
          "mcp.operation.outcome": outcome,
          "antnest.operation.outcome": outcome,
        },
        eventMap([error, completed]),
      );
    } else {
      expected(operation, { "otel.status_code": "OK" });
      assert.equal(
        children(operation).length,
        0,
        "discovery executed extra work",
      );
      check(operation, {}, eventMap([completed]));
    }
    // Client disconnect and dispatch completion are independently scheduled.
    // The HTTP completion event does not prove the Runtime operation joined.
    const transport = tag(server, "http.transport.outcome"),
      disconnected = transport === "canceled";
    assert(["success", "canceled"].includes(transport));
    if (cancelled) assert(disconnected);
    const httpCompleted = completion(server, "Runtime HTTP request completed", {
      ...logIdentity(server),
      event: "Runtime HTTP request completed",
      level: disconnected ? "WARN" : "INFO",
      "http.request.method": "POST",
      "url.path": "/mcp",
      "http.transport.outcome": transport,
      "error.type": disconnected ? "client_disconnected" : "",
    });
    http200({ tags: httpCompleted.fields });
    const serverAllowed = {},
      events = [httpCompleted];
    if (disconnected) {
      assert(ownedCancellations.has(client));
      expected(server, { "http.transport.error.type": "client_disconnected" });
      Object.assign(serverAllowed, {
        "http.transport.outcome": "canceled",
        "http.transport.error.type": "client_disconnected",
      });
      ownedCancellations.add(server);
    }
    if (cancelled) {
      serverAllowed["antnest.protocol.outcome"] = "error";
      const type = tag(server, "error.type"),
        status = tag(server, "otel.status_code");
      if (["ERROR", 2].includes(status)) {
        assert.equal(type, code);
        assert(
          namedEvent(operation, "antnest.error").timestamp <=
            httpCompleted.timestamp,
          "HTTP observed protocol failure before its original dispatch error",
        );
        Object.assign(serverAllowed, errorStatus(server));
      } else {
        assert(
          [undefined, "UNSET", 0].includes(status),
          "invalid disconnected HTTP status",
        );
        assert([code, "client_disconnected"].includes(type));
        const error = errorEvent(
          server,
          "http",
          "client_disconnected",
          "HTTP response closed before EOF",
        );
        assert(error.timestamp <= httpCompleted.timestamp);
        events.push(error);
      }
      serverAllowed["error.type"] = type;
    } else {
      assert(
        operation.startTime >= server.startTime &&
          end(operation) <= end(server),
      );
      assert(completed.timestamp <= httpCompleted.timestamp);
      if (disconnected) {
        const event = exactEvent(server, "antnest.cancelled", {
          "antnest.phase": "http",
          "antnest.cancellation.type": "client_disconnected",
          "antnest.protocol.outcome": "success",
        });
        assert(
          event.timestamp >= completed.timestamp &&
            event.timestamp <= httpCompleted.timestamp,
        );
        events.push(event);
      }
    }
    check(server, serverAllowed, eventMap(events));
  }

  const tool = one(children(invocation.operation), "cancelled Runtime tool"),
    work = one(children(tool), "cancelled Runtime work");
  const runtimeKind = kind === "bash" ? "bash" : "managed";
  expected(tool, {
    "span.kind": "internal",
    "antnest.agent.id": agentId,
    "antnest.runtime.generation": invocation.generation,
    "mcp.tool.name": runtimeKind,
    "mcp.tool.outcome": "error",
    "error.type": "outcome_unknown",
  });
  assert.equal(tool.operationName, "runtime.mcp.tool");
  assert.equal(
    work.operationName,
    kind === "bash" ? "runtime.executor" : "runtime.mcp.stdio",
  );
  assert.equal(
    children(work).length,
    0,
    "extra work under cancellation endpoint",
  );
  for (const span of [tool, work]) {
    assert.equal(span.processID, invocation.server.processID);
    for (const [key, value] of Object.entries({
      "antnest.agent.id": agentId,
      "antnest.runtime.generation": invocation.generation,
    }))
      if (tag(span, key) !== undefined) assert.equal(tag(span, key), value);
    const parent = tree.parent(span);
    assert(
      span.startTime >= parent.startTime && end(span) <= end(parent),
      "cancelled Runtime work outside original parent",
    );
    for (const [index, event] of (span.logs ?? []).entries()) {
      assert(
        Number.isFinite(event.timestamp) && event.timestamp >= span.startTime,
      );
      if (event.timestamp > end(span)) {
        const resource = values(trace.processes[span.processID].tags);
        assert(
          [span.startTime, span.duration, event.timestamp].every(
            Number.isSafeInteger,
          ) &&
            event.timestamp === end(span) + 1 &&
            resource["telemetry.sdk.language"] === "rust" &&
            resource["telemetry.sdk.name"] === "opentelemetry",
          "cancelled Runtime event outside own span",
        );
        workTimeObservations.push({
          trace_id: trace.traceID,
          span_id: span.spanID,
          process_id: span.processID,
          event_index: index,
          raw_left_us: event.timestamp,
          raw_right_us: end(span),
          raw_difference_us: 1,
          reason: "jaeger-integer-microsecond-representation",
        });
      }
    }
  }
  const toolError = errorEvent(tool, "mcp.tool", "outcome_unknown", unknown);
  const toolCompleted = completion(tool, "Runtime MCP tool failed", {
    ...logIdentity(tool),
    event: "Runtime MCP tool failed",
    level: "WARN",
    tool: runtimeKind,
    "error.type": "outcome_unknown",
    reason: unknown,
  });
  assert(toolError.timestamp <= toolCompleted.timestamp);
  check(
    tool,
    {
      ...errorStatus(tool),
      "error.type": "outcome_unknown",
      "mcp.tool.outcome": "error",
    },
    eventMap([toolError, toolCompleted]),
  );
  const workError = errorEvent(
    work,
    kind === "bash" ? "executor" : "mcp.stdio",
    "outcome_unknown",
    unknown,
    ["canceled"],
  );
  const workAllowed = { ...errorStatus(work), "error.type": "outcome_unknown" },
    workEvents = [workError];
  if (kind === "bash") {
    expected(work, {
      "span.kind": "internal",
      "antnest.agent.id": agentId,
      "antnest.runtime.generation": invocation.generation,
      "executor.tool.name": "bash",
      "executor.exit.classification": "canceled",
      "executor.outcome": "error",
    });
    const rawPID = tag(work, "executor.child.pid");
    const pid =
      typeof rawPID === "number"
        ? rawPID
        : typeof rawPID === "string" && /^[1-9][0-9]*$/u.test(rawPID)
          ? Number(rawPID)
          : NaN;
    assert(
      Number.isSafeInteger(pid) && pid > 0,
      "invalid original executor PID",
    );
    for (const key of [
      "process.exit.code",
      "process.exit.signal",
      "executor.exit.signal",
    ])
      assert(
        ![...work.tags, ...work.logs.flatMap((event) => event.fields)].some(
          (field) => field.key === key,
        ),
        "cancelled executor fabricated a natural exit",
      );
    const completed = completion(work, "Runtime Executor completed", {
      ...logIdentity(work),
      event: "Runtime Executor completed",
      level: "WARN",
      outcome: "error",
      "error.type": "outcome_unknown",
    });
    assert(workError.timestamp <= completed.timestamp);
    workEvents.push(completed);
    Object.assign(workAllowed, {
      "executor.exit.classification": "canceled",
      "executor.outcome": "error",
    });
  } else {
    expected(work, {
      "span.kind": "client",
      "mcp.tool.name": toolName,
      "rpc.method": "tools/call",
      "antnest.protocol.outcome": "error",
    });
    workAllowed["antnest.protocol.outcome"] = "error";
  }
  check(work, workAllowed, eventMap(workEvents));
  const operationError = namedEvent(invocation.operation, "antnest.error");
  assert(
    end(work) <= toolError.timestamp &&
      workEvents.every((event) => event.timestamp <= toolError.timestamp) &&
      end(tool) <= operationError.timestamp &&
      toolCompleted.timestamp <= operationError.timestamp,
    "cancellation classified before its actual Runtime child completed",
  );
  for (const span of trace.spans)
    if (tree.chain(span).includes(owner))
      assert(
        checkedSpans.has(span),
        "unaccounted work below cancellation owner",
      );
  assert.equal(proof.neutralDiagnostics.length, 0);
  return {
    ...proof,
    parsedOutcome: "not_received",
    events: { ready, dispatch, closeStarted, closeCompleted, failure },
    tool,
    work,
    checkedSpans,
    workTimeObservations,
  };
}
