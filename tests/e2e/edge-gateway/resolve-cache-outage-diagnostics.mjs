import assert from "node:assert/strict";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { clockSkewWarning } from "../../support/strict-findings.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";

import { outageGateNames } from "../../support/resolve-cache-admission.mjs";
export { outageGateNames };
const claimNames = outageGateNames.filter(
  (n) => !["authority", "recovery_authority"].includes(n),
);
const key = (row) => `${row.trace_id}:${row.span_id}`;
const eventTag = (event, name) => tag({ tags: event.fields }, name);
export function completedInitializeRead(trace, server, completion) {
  const tree = traceTopology(trace),
    client = tree.parent(server),
    initialize = tree.parent(client);
  const completions = (server.logs ?? []).filter(
    (event) => eventTag(event, "event") === "Runtime HTTP request completed",
  );
  assert.equal(completions.length, 1, "missing or duplicate MCP completion");
  completion ??= completions[0];
  assert.equal(completion, completions[0], "foreign MCP completion");
  const requireTags = (span, expected) => {
    assert(span, "missing initialize MCP parent");
    for (const fields of [
      span.tags ?? [],
      ...(span.logs ?? []).map((event) => event.fields ?? []),
    ])
      assert.equal(
        new Set(fields.map((field) => field.key)).size,
        fields.length,
        "duplicate initialize MCP diagnostic field",
      );
    for (const [name, value] of Object.entries(expected))
      assert.equal(tag(span, name), value, `wrong initialize MCP ${name}`);
    assert(!hasError(span), "failed initialize MCP span");
  };
  assert.equal(tree.service(server), "antnest-runtime");
  assert.equal(server.operationName, "HTTP POST /mcp");
  requireTags(server, {
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/mcp",
    "rpc.method": "resources/read",
    "antnest.protocol.outcome": "success",
    "http.transport.outcome": "canceled",
    "http.transport.error.type": "client_disconnected",
  });
  assert([200, "200"].includes(tag(server, "http.response.status_code")));
  const agent = tag(server, "antnest.agent.id");
  assert(typeof agent === "string" && agent.length > 0);
  assert.equal(tree.service(client), "agent-acp-service");
  assert.equal(client.operationName, "HTTP POST antnest-runtime");
  requireTags(client, {
    "span.kind": "client",
    "http.request.method": "POST",
    "http.response.status_code": 200,
    "peer.service": "antnest-runtime",
    "antnest.operation.phase": "http.send_or_read",
    "antnest.outcome": "cancelled",
    "antnest.cancellation.type": "AbortError",
  });
  assert.equal(client.logs?.length, 1);
  assert.equal(eventTag(client.logs[0], "event"), "antnest.cancelled");
  assert.equal(
    eventTag(client.logs[0], "antnest.cancellation.type"),
    "AbortError",
  );
  assert.equal(
    eventTag(client.logs[0], "antnest.cancellation.phase"),
    "http.send_or_read",
  );
  assert.equal(tree.service(initialize), "agent-acp-service");
  if (initialize.operationName === "HTTP POST /v1/acp") {
    requireTags(initialize, {
      "http.request.method": "POST",
      "http.route": "/v1/acp",
      "http.response.status_code": 200,
    });
  } else {
    assert.equal(initialize.operationName, "acp initialize");
    for (const name of [
      "http.request.method",
      "http.route",
      "http.response.status_code",
    ])
      assert.equal(
        tag(initialize, name),
        undefined,
        "HTTP initialize mislabeled as WS",
      );
  }
  requireTags(initialize, {
    "span.kind": "server",
    "rpc.method": "initialize",
    "antnest.agent.id": agent,
  });
  const operations = trace.spans.filter((span) => tree.parent(span) === server);
  assert.equal(operations.length, 1);
  const operation = operations[0];
  assert.equal(tree.service(operation), "antnest-runtime");
  assert.equal(operation.operationName, "runtime.mcp.operation");
  requireTags(operation, {
    "rpc.method": "resources/read",
    "antnest.agent.id": agent,
    "otel.status_code": "OK",
    "mcp.operation.outcome": "success",
    "antnest.operation.outcome": "success",
  });
  for (const name of [
    "antnest.runtime.execution.id",
    "antnest.runtime.generation",
  ]) {
    const value = tag(server, name);
    assert(typeof value === "string" && value.length > 0);
    assert.equal(tag(operation, name), value, `wrong initialize MCP ${name}`);
  }
  assert(
    operation.startTime >= server.startTime &&
      operation.startTime + operation.duration <=
        server.startTime + server.duration,
  );
  assert.equal(server.logs?.length, 2);
  const cancelled = server.logs.find(
    (event) => eventTag(event, "event") === "antnest.cancelled",
  );
  assert(cancelled && cancelled !== completion);
  for (const [name, value] of Object.entries({
    event: "antnest.cancelled",
    "antnest.phase": "http",
    "antnest.cancellation.type": "client_disconnected",
    "antnest.protocol.outcome": "success",
  }))
    assert.equal(eventTag(cancelled, name), value);
  for (const [name, value] of Object.entries({
    event: "Runtime HTTP request completed",
    level: "WARN",
    "service.name": "antnest-runtime",
    "http.request.method": "POST",
    "url.path": "/mcp",
    "antnest.agent.id": agent,
    trace_id: server.traceID,
    span_id: server.spanID,
    "error.type": "client_disconnected",
    "http.transport.outcome": "canceled",
  }))
    assert.equal(eventTag(completion, name), value);
  assert(
    [200, "200"].includes(eventTag(completion, "http.response.status_code")),
  );
  for (const event of [completion, cancelled])
    assert(
      Number.isFinite(event.timestamp) &&
        event.timestamp >= operation.startTime + operation.duration &&
        event.timestamp <= server.startTime + server.duration,
    );
  // This is a completed handler followed by transport cancellation, not proof
  // of client receipt. Only its exact diagnostics are neutral; unrelated errors
  // and failed outcomes still fail both the stream and archive inspectors.
  for (const span of [server, client, initialize, operation]) {
    const groups = [
      {
        fields: span.tags ?? [],
        allowed:
          span === server
            ? {
                "http.transport.outcome": "canceled",
                "http.transport.error.type": "client_disconnected",
              }
            : span === client
              ? {
                  "antnest.outcome": "cancelled",
                  "antnest.cancellation.type": "AbortError",
                }
              : {},
      },
      ...(span.logs ?? []).map((event) => ({
        fields: event.fields ?? [],
        allowed:
          event === completion
            ? {
                "error.type": "client_disconnected",
                "http.transport.outcome": "canceled",
              }
            : event === cancelled
              ? { "antnest.cancellation.type": "client_disconnected" }
              : span === client
                ? {
                    "antnest.cancellation.type": "AbortError",
                    "antnest.cancellation.phase": "http.send_or_read",
                  }
                : {},
      })),
    ];
    for (const { fields, allowed } of groups)
      for (const { key, value } of fields) {
        if (Object.hasOwn(allowed, key)) {
          assert.equal(
            value,
            allowed[key],
            "contradictory MCP disconnect diagnostic",
          );
        } else if (key === "outcome" || key.endsWith(".outcome")) {
          assert(
            ["success", "ok", "completed", "committed", "admitted"].includes(
              value,
            ),
            "unrelated MCP disconnect outcome",
          );
        } else if (
          /^(error($|\.)|exception\.|db\.response\.status_code$|antnest\.(error\.|cancellation\.|result$|stream\.termination$|http\.request_cancelled$)|otel\.status_|http\.transport\.error\.)/u.test(
            key,
          )
        ) {
          assert(
            (key === "error.type" && value === "") ||
              (key === "error" && value === false) ||
              (key === "otel.status_code" && ["OK", "UNSET"].includes(value)) ||
              (key === "antnest.error.class" && value === "none"),
            "unrelated MCP disconnect error diagnostic",
          );
        } else if (key === "event") {
          assert(
            !["antnest.error", "error", "exception"].includes(value),
            "unrelated MCP disconnect error event",
          );
        }
      }
  }
}
export function inspectOutageDiagnostics(collection, gates, secrets = []) {
  assert(
    collection.traces instanceof Map &&
      collection.archivedTraceIDs instanceof Set,
  );
  assert.deepEqual(
    [...collection.traces.keys()].sort(),
    [...collection.archivedTraceIDs].sort(),
    "raw archive inventory mismatch",
  );
  const first = collection.traces.values().next().value;
  assert(first, "raw outage archive missing");
  const all = resolveTraceSources(first, secrets, collection),
    errors = new Map(),
    neutral = [];
  for (const trace of all) {
    const warning = (items) => {
      assert(Array.isArray(items), "malformed warning inventory");
      for (const value of items)
        assert(
          typeof value === "string" && clockSkewWarning.test(value),
          "unreviewed raw warning",
        );
    };
    warning(trace.warnings ?? []);
    for (const span of trace.spans) {
      assert(
        Number.isFinite(span.startTime) &&
          Number.isFinite(span.duration) &&
          span.duration >= 0,
        "unfinished raw span",
      );
      warning(span.warnings ?? []);
      if (!hasError(span) && tag(span, "http.transport.outcome") === "canceled")
        completedInitializeRead(trace, span);
      if (hasError(span))
        errors.set(
          key({ trace_id: trace.traceID, span_id: span.spanID }),
          span,
        );
      else
        for (const group of [
          { fields: span.tags ?? [] },
          ...(span.logs ?? []).map((event) => ({
            event,
            fields: event.fields ?? [],
          })),
        ])
          for (const field of group.fields) {
            const explicitError =
              (/^(error\.(type|code)|exception\.|antnest\.error\.)/u.test(
                field.key,
              ) &&
                field.value !== "" &&
                field.value !== undefined &&
                !(
                  field.key === "antnest.error.class" && field.value === "none"
                )) ||
              (field.key === "event" &&
                ["exception", "error"].includes(field.value)) ||
              (field.key === "otel.status_code" && field.value === 2) ||
              ((field.key === "outcome" || field.key.endsWith(".outcome")) &&
                [
                  "error",
                  "failed",
                  "failure",
                  "rejected",
                  "unavailable",
                ].includes(field.value));
            if (
              explicitError &&
              group.event &&
              field.key === "error.type" &&
              field.value === "client_disconnected"
            ) {
              completedInitializeRead(trace, span, group.event);
              neutral.push({
                trace_id: trace.traceID,
                span_id: span.spanID,
                event_index: span.logs.indexOf(group.event),
                event_timestamp_us: group.event.timestamp,
                reason: "completed-initialize-mcp-read-disconnect",
              });
            } else
              assert(
                !explicitError,
                "unclassified raw diagnostic outside error inventory",
              );
          }
    }
  }
  for (const name of outageGateNames)
    assert.equal(
      gates[name]?.status,
      "passed",
      `owning gate ${name} incomplete`,
    );
  const owned = new Map();
  for (const name of claimNames) {
    const claims = gates[name].owned_error_spans;
    assert(Array.isArray(claims), `owning gate ${name} claims missing`);
    for (const claim of claims) {
      assert(
        claim &&
          typeof claim.trace_id === "string" &&
          typeof claim.span_id === "string" &&
          typeof claim.reason === "string" &&
          claim.reason.length > 0,
        "malformed exact error claim",
      );
      const id = key(claim);
      assert(errors.has(id), "claim is not an actual archived error");
      const prior = owned.get(id);
      if (prior) {
        assert.equal(prior.reason, claim.reason, "conflicting error ownership");
        prior.owners.add(name);
      } else
        owned.set(id, {
          trace_id: claim.trace_id,
          span_id: claim.span_id,
          reason: claim.reason,
          owners: new Set([name]),
        });
    }
  }
  assert.deepEqual(
    [...owned.keys()].sort(),
    [...errors.keys()].sort(),
    "unowned raw outage error",
  );
  return {
    status: "passed",
    trace_count: all.length,
    owning_gate_names: [...outageGateNames],
    owned_error_count: owned.size,
    owned_error_spans: [...owned.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => ({ ...v, owners: [...v.owners].sort() })),
    unowned_error_spans: [],
    non_error_diagnostics: neutral,
    raw_trace_diagnostics: all.map((trace) => {
      const { source_trace_ids, ...diagnostics } = resolveTraceDiagnostics(
        trace,
        [trace],
      );
      return {
        trace_id: trace.traceID,
        raw_span_count: trace.spans.length,
        ...diagnostics,
      };
    }),
    ...resolveTraceDiagnostics(first, all),
  };
}
