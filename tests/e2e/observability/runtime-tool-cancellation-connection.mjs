import assert from "node:assert/strict";
import { tag } from "./trace-tree.mjs";
import { inspectRuntimeToolInventory } from "./runtime-tool-inventory.mjs";
import {
  end,
  expected,
  eventValues,
  namedEvent,
  exactEvent,
  http200,
  diagnostics,
} from "./runtime-tool-evidence.mjs";

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

export function inspectRuntimeToolCancellationConnection(
  trace,
  owner,
  identity,
  { toolName },
) {
  const proof = inspectRuntimeToolInventory(trace, owner, identity);
  const {
    discovery,
    invocation,
    eventsInside,
    nodeBefore,
    ownedCancellations,
  } = proof;
  const { executionId } = identity;
  const checkedSpans = new Set();
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
  return {
    ...proof,
    checkedSpans,
    events: { ready, dispatch, closeStarted, closeCompleted, failure },
  };
}
