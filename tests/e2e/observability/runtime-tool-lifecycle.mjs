import assert from "node:assert/strict";
import { tag } from "./trace-tree.mjs";
import {
  one,
  end,
  expected,
  eventValues,
  namedEvent,
  exactEvent,
  http200,
  record,
  diagnostics,
  runtimeToolEvidence,
} from "./runtime-tool-evidence.mjs";

/** Connection proof only. Parsed tool_error remains an error for the caller's scenario. */
export function inspectRuntimeToolLifecycle(
  trace,
  owner,
  { agentId, executionId },
) {
  const {
    tree,
    children,
    timeObservations,
    neutralDiagnostics,
    ownedCancellations,
    process,
    sameProcess,
    nodeBefore,
    eventsInside,
  } = runtimeToolEvidence(trace, owner, { agentId });
  assert.equal(tree.spans.get(owner?.spanID), owner, "foreign tool owner");
  assert(["mcp.tools.list", "mcp.tools.call"].includes(owner.operationName));
  process(owner, "agent-acp-service");
  const method =
    owner.operationName === "mcp.tools.list" ? "tools/list" : "tools/call";
  const parsedOutcome = tag(owner, "antnest.mcp.tool_result.outcome");
  assert(
    parsedOutcome === "success" ||
      (method === "tools/call" && parsedOutcome === "tool_error"),
    "tool result was not parsed",
  );
  expected(owner, {
    "span.kind": "internal",
    "antnest.runtime.execution.id": executionId,
    "antnest.mcp.method": method,
    "antnest.mcp.connection.close.outcome": "closed",
    "antnest.mcp.caller_cancelled": false,
  });
  const ready = exactEvent(owner, "antnest.mcp.discovery.ready");
  const dispatch = exactEvent(owner, "antnest.mcp.tool.dispatch.started");
  const parsed = exactEvent(owner, "antnest.mcp.tool.result.parsed", {
    outcome: parsedOutcome,
  });
  const closeStarted = exactEvent(
    owner,
    "antnest.mcp.connection.close.started",
    { "antnest.mcp.caller_cancelled": false },
  );
  const closeCompleted = exactEvent(
    owner,
    "antnest.mcp.connection.close.completed",
    { outcome: "closed" },
  );
  const lifecycle = [ready, dispatch, parsed, closeStarted, closeCompleted];
  assert.equal(
    owner.logs.length,
    lifecycle.length,
    "extra tool lifecycle event",
  );
  eventsInside(owner);
  assert(
    lifecycle.every(
      (event, index) =>
        index === 0 || lifecycle[index - 1].timestamp <= event.timestamp,
    ),
    "wrong tool lifecycle order",
  );
  const ownerAllowed = { "antnest.mcp.connection.close.outcome": "closed" };
  if (parsedOutcome === "tool_error") {
    const status = tag(owner, "otel.status_code");
    assert(
      ["ERROR", 2].includes(status),
      "tool_error must retain ERROR status",
    );
    expected(owner, {
      "antnest.outcome": "tool_error",
      "error.type": "mcp_tool_error",
    });
    Object.assign(ownerAllowed, {
      "antnest.mcp.tool_result.outcome": "tool_error",
      "antnest.outcome": "tool_error",
      "error.type": "mcp_tool_error",
      "otel.status_code": status,
    });
    if (tag(owner, "error") !== undefined) {
      assert.equal(tag(owner, "error"), true);
      ownerAllowed.error = true;
    }
  }
  diagnostics(
    owner,
    ownerAllowed,
    new Map(lifecycle.map((event) => [event, eventValues(event)])),
  );
  const clients = children(owner).filter(
    (span) =>
      span.operationName === "HTTP POST antnest-runtime" ||
      tag(span, "peer.service") === "antnest-runtime",
  );
  assert.equal(
    clients.length,
    2,
    "tool connection needs exactly discovery and invocation HTTP",
  );
  const exchanges = [];
  for (const client of clients) {
    sameProcess(client, owner, "agent-acp-service");
    assert.equal(client.operationName, "HTTP POST antnest-runtime");
    expected(client, {
      "span.kind": "client",
      "http.request.method": "POST",
      "peer.service": "antnest-runtime",
    });
    http200(client);
    eventsInside(client);
    assert(client.startTime >= owner.startTime, "tool CLIENT precedes owner");
    nodeBefore(client, owner, end(client), end(owner), "client-joined-by-tool");
    nodeBefore(
      client,
      owner,
      end(client),
      closeCompleted.timestamp,
      "client-joined-at-tool-close",
    );
    const cancelledClient = tag(client, "antnest.outcome") === "cancelled";
    const clientAllowed = cancelledClient
      ? {
          "antnest.outcome": "cancelled",
          "antnest.operation.phase": "http.send_or_read",
          "antnest.cancellation.type": "AbortError",
        }
      : {};
    expected(client, clientAllowed);
    const clientEvents = new Map();
    if (cancelledClient) {
      assert.equal(
        client.logs.length,
        1,
        "extra tool CLIENT cancellation event",
      );
      const cancelled = exactEvent(client, "antnest.cancelled", {
        "antnest.cancellation.type": "AbortError",
        "antnest.cancellation.phase": "http.send_or_read",
      });
      nodeBefore(
        client,
        owner,
        closeStarted.timestamp,
        cancelled.timestamp,
        "tool-client-cancel-after-close-start",
      );
      nodeBefore(
        client,
        owner,
        cancelled.timestamp,
        closeCompleted.timestamp,
        "tool-client-cancel-before-close-complete",
      );
      clientEvents.set(cancelled, eventValues(cancelled));
      neutralDiagnostics.push(
        record(client, cancelled, "parsed-runtime-tool-connection-cleanup"),
      );
      ownedCancellations.add(client);
    } else
      assert.equal(
        client.logs?.length ?? 0,
        0,
        "extra successful tool CLIENT event",
      );
    diagnostics(client, clientAllowed, clientEvents);
    const server = one(children(client), "Runtime HTTP SERVER");
    process(server, "antnest-runtime");
    assert.equal(server.operationName, "HTTP POST /mcp");
    const rpc = tag(server, "rpc.method");
    assert(["discover", method].includes(rpc), "wrong actual tool HTTP method");
    expected(server, {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/mcp",
      "antnest.agent.id": agentId,
      "antnest.runtime.execution.id": executionId,
    });
    http200(server);
    eventsInside(server, true);
    const generation = tag(server, "antnest.runtime.generation");
    assert(
      typeof generation === "string" && generation.length > 0,
      "tool Runtime generation missing",
    );
    const bytes = tag(server, "http.response.body.size");
    assert(
      Number.isSafeInteger(bytes) && bytes > 0,
      "tool response body size missing",
    );
    assert.equal(
      tag(client, "http.response.body.size"),
      bytes,
      "tool response was not fully received",
    );
    const failedResult = rpc === "tools/call" && parsedOutcome === "tool_error";
    expected(server, {
      "antnest.protocol.outcome": failedResult ? "error" : "success",
    });
    const transport = tag(server, "http.transport.outcome");
    assert(
      ["success", "canceled"].includes(transport),
      "failed tool HTTP transport",
    );
    const serverAllowed = {},
      serverEvents = new Map();
    if (transport === "canceled") {
      assert(
        cancelledClient,
        "tool SERVER disconnect has no owned CLIENT close",
      );
      expected(server, { "http.transport.error.type": "client_disconnected" });
      Object.assign(serverAllowed, {
        "http.transport.outcome": "canceled",
        "http.transport.error.type": "client_disconnected",
      });
      ownedCancellations.add(server);
    }
    const operation = one(children(server), "Runtime MCP operation");
    sameProcess(operation, server, "antnest-runtime");
    assert.equal(operation.operationName, "runtime.mcp.operation");
    expected(operation, {
      "span.kind": "internal",
      "rpc.method": rpc,
      "antnest.agent.id": agentId,
      "antnest.runtime.execution.id": executionId,
      "antnest.runtime.generation": generation,
      "mcp.operation.outcome": failedResult ? "error" : "success",
    });
    assert(
      operation.startTime >= server.startTime && end(operation) <= end(server),
      "tool MCP operation outside owning SERVER",
    );
    eventsInside(operation, true);
    const operationCompleted = namedEvent(
      operation,
      "Runtime MCP operation completed",
    );
    const errorType = failedResult ? tag(operation, "error.type") : "";
    assert(
      typeof errorType === "string" && (!failedResult || errorType.length > 0),
      "tool protocol error type missing",
    );
    expected(
      { tags: operationCompleted.fields },
      {
        event: "Runtime MCP operation completed",
        level: "INFO",
        "service.name": "antnest-runtime",
        trace_id: trace.traceID,
        span_id: operation.spanID,
        "antnest.agent.id": agentId,
        "antnest.runtime.generation": generation,
        "mcp.operation.name": rpc,
        "mcp.operation.outcome": failedResult ? "error" : "success",
        "error.type": errorType,
      },
    );
    const operationAllowed = {},
      operationEvents = new Map();
    if (failedResult) {
      // Keep these original business errors visible. The outer scenario must
      // explicitly expect failure; this receipt never makes them neutral.
      for (const span of [server, operation]) {
        const status = tag(span, "otel.status_code");
        assert(
          ["ERROR", 2].includes(status),
          "missing actual failed-tool status",
        );
        expected(span, { "error.type": errorType });
        const allowed = span === server ? serverAllowed : operationAllowed;
        Object.assign(allowed, {
          "error.type": errorType,
          "otel.status_code": status,
        });
        if (tag(span, "error") !== undefined) {
          assert.equal(tag(span, "error"), true);
          allowed.error = true;
        }
      }
      serverAllowed["antnest.protocol.outcome"] = "error";
      const outcome = tag(operation, "antnest.operation.outcome");
      assert(["error", "rejected"].includes(outcome));
      Object.assign(operationAllowed, {
        "mcp.operation.outcome": "error",
        "antnest.operation.outcome": outcome,
      });
      const error = exactEvent(operation, "antnest.error", {
        "antnest.error.stage": "mcp.dispatch",
        "antnest.error.type": errorType,
        "antnest.error.code": errorType,
        "antnest.error.message":
          "Tool returned an unsuccessful protocol result",
      });
      operationEvents.set(error, eventValues(error));
      operationEvents.set(operationCompleted, {
        "mcp.operation.outcome": "error",
        "error.type": errorType,
      });
      assert.equal(operation.logs.length, 2);
    } else {
      expected(operation, {
        "otel.status_code": "OK",
        "antnest.operation.outcome": "success",
      });
      assert.equal(operation.logs.length, 1);
    }
    diagnostics(operation, operationAllowed, operationEvents);
    if (rpc === "discover" || rpc === "tools/list")
      assert.equal(
        children(operation).length,
        0,
        "catalog operation executed extra Runtime work",
      );
    const completed = namedEvent(server, "Runtime HTTP request completed");
    expected(
      { tags: completed.fields },
      {
        event: "Runtime HTTP request completed",
        level: transport === "canceled" ? "WARN" : "INFO",
        "service.name": "antnest-runtime",
        "http.request.method": "POST",
        "url.path": "/mcp",
        "antnest.agent.id": agentId,
        "antnest.runtime.generation": generation,
        trace_id: trace.traceID,
        span_id: server.spanID,
        "error.type": transport === "canceled" ? "client_disconnected" : "",
        "http.transport.outcome": transport,
      },
    );
    http200({ tags: completed.fields });
    assert(
      completed.timestamp >= end(operation) &&
        completed.timestamp >= operationCompleted.timestamp,
      "tool HTTP completed before operation joined",
    );
    if (transport === "canceled" && !failedResult) {
      const cancelled = exactEvent(server, "antnest.cancelled", {
        "antnest.phase": "http",
        "antnest.cancellation.type": "client_disconnected",
        "antnest.protocol.outcome": "success",
      });
      assert(
        cancelled.timestamp >= end(operation) &&
          cancelled.timestamp >= operationCompleted.timestamp &&
          cancelled.timestamp <= completed.timestamp,
        "tool SERVER cancellation precedes completion",
      );
      serverEvents.set(cancelled, eventValues(cancelled));
      neutralDiagnostics.push(
        record(server, completed, "completed-runtime-tool-http-disconnect"),
      );
      assert.equal(server.logs.length, 2);
    } else assert.equal(server.logs.length, 1);
    serverEvents.set(
      completed,
      transport === "canceled"
        ? {
            level: "WARN",
            "error.type": "client_disconnected",
            "http.transport.outcome": "canceled",
          }
        : {},
    );
    diagnostics(server, serverAllowed, serverEvents);
    exchanges.push({ client, server, operation, method: rpc, generation });
  }
  const discovery = one(
    exchanges.filter((pair) => pair.method === "discover"),
    "discovery",
  );
  const invocation = one(
    exchanges.filter((pair) => pair.method === method),
    "invocation",
  );
  sameProcess(discovery.server, invocation.server, "antnest-runtime");
  assert.equal(
    discovery.generation,
    invocation.generation,
    "tool Runtime generation changed",
  );
  nodeBefore(
    discovery.client,
    owner,
    discovery.client.startTime,
    ready.timestamp,
    "tool-discovery-start-before-ready",
  );
  nodeBefore(
    invocation.client,
    owner,
    dispatch.timestamp,
    invocation.client.startTime,
    "tool-dispatch-before-HTTP",
  );
  assert(
    invocation.client.startTime <= parsed.timestamp,
    "tool parsed before actual invocation",
  );
  return {
    owner,
    method,
    parsedOutcome,
    clients,
    servers: exchanges.map((pair) => pair.server),
    exchanges,
    discovery,
    invocation,
    events: { ready, dispatch, parsed, closeStarted, closeCompleted },
    neutralDiagnostics,
    ownedCancellations,
    timeObservations,
  };
}
