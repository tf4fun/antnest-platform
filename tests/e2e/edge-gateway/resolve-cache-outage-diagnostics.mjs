import assert from "node:assert/strict";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { clockSkewWarning } from "../../support/strict-findings.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { inspectRuntimeInformationRead } from "../observability/runtime-information-read.mjs";

import { outageGateNames } from "../../support/resolve-cache-admission.mjs";
export { outageGateNames };
const claimNames = outageGateNames.filter(
  (n) => !["authority", "recovery_authority"].includes(n),
);
const key = (row) => `${row.trace_id}:${row.span_id}`;
const eventTag = (event, name) => tag({ tags: event.fields }, name);
export function completedInitializeRead(trace, server, completion) {
  const tree = traceTopology(trace);
  const client = tree.parent(server);
  const proof = inspectRuntimeInformationRead(trace, tree.parent(client));
  assert.equal(
    proof.resource.server,
    server,
    "foreign Runtime resource receipt",
  );
  assert.equal(proof.resource.client, client);
  if (completion !== undefined)
    assert.equal(
      completion,
      proof.resource.completion,
      "foreign MCP completion",
    );
  const initialize = proof.request;
  assert.equal(tag(initialize, "span.kind"), "server");
  assert.equal(tag(initialize, "rpc.method"), "initialize");
  assert.equal(tag(initialize, "antnest.agent.id"), proof.agentId);
  if (initialize.operationName === "HTTP POST /v1/acp") {
    assert.equal(tag(initialize, "http.request.method"), "POST");
    assert.equal(tag(initialize, "http.route"), "/v1/acp");
    assert.equal(tag(initialize, "http.response.status_code"), 200);
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
  return {
    ...proof,
    initialize,
    client,
    server,
    operation: proof.resource.operation,
  };
}
// Session metadata is admitted only with the original UI request and its
// owning login scope. Keep initialize's separate contract unchanged.
export function completedSessionLoadRead(trace, server, scope, completion) {
  return completedSessionRead(trace, server, scope, completion, "session/load");
}
export function completedSessionNewRead(trace, server, scope, completion) {
  return completedSessionRead(trace, server, scope, completion, "session/new");
}
function completedSessionRead(trace, server, scope, completion, method) {
  const tree = traceTopology(trace),
    client = tree.parent(server),
    proof = inspectRuntimeInformationRead(trace, tree.parent(client));
  assert.equal(
    proof.resource.server,
    server,
    "foreign Runtime resource receipt",
  );
  assert.equal(proof.resource.client, client);
  if (completion !== undefined)
    assert.equal(
      completion,
      proof.resource.completion,
      "foreign MCP completion",
    );
  for (const value of [
    scope?.agent_id,
    scope?.session_id,
    scope?.ui_span_id,
    scope?.credential_scope,
    ...["user_id", "membership_id", "organization_id"].map(
      (key) => scope?.principal?.[key],
    ),
  ])
    assert(
      typeof value === "string" && value.length > 0,
      "missing original view scope",
    );
  const request = proof.request,
    ui = tree.spans.get(scope.ui_span_id);
  assert.equal(tree.service(ui), "agent-ui");
  assert.equal(tag(ui, "span.kind"), "server");
  assert.equal(
    tag(ui, "http.request.method"),
    method === "session/new" ? "POST" : "GET",
  );
  assert.equal(
    tag(ui, "http.response.status_code"),
    method === "session/new" ? 201 : 200,
  );
  assert.equal(proof.agentId, scope.agent_id);
  for (const [key, value] of Object.entries({
    "span.kind": "server",
    "rpc.method": method,
    "rpc.system.name": "jsonrpc",
    "rpc.service": "acp",
    "antnest.protocol.version": "v1",
    "antnest.agent.id": scope.agent_id,
    "antnest.session.id": scope.session_id,
  }))
    assert.equal(tag(request, key), value, "wrong original load " + key);
  assert(
    typeof tag(request, "antnest.request.id") === "string" &&
      tag(request, "antnest.request.id").length > 0,
    "missing original ACP request identity",
  );
  let receiver = request;
  if (request.operationName !== "HTTP POST /v1/acp") {
    assert.equal(request.operationName, `acp ${method}`);
    for (const name of [
      "http.request.method",
      "http.route",
      "http.response.status_code",
      "antnest.listener",
    ])
      assert.equal(
        tag(request, name),
        undefined,
        "HTTP attributes on queued RPC",
      );
    receiver = tree.parent(request);
    assert.equal(
      receiver?.processID,
      request.processID,
      "foreign ACP receiver process",
    );
    assert(
      receiver.startTime <= request.startTime,
      "queued RPC starts before its HTTP receiver",
    );
  }
  assert.equal(tree.service(receiver), "agent-acp-service");
  assert.equal(receiver.operationName, "HTTP POST /v1/acp");
  for (const [key, value] of Object.entries({
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/v1/acp",
    "antnest.listener": "workspace",
    "http.response.status_code": receiver === request ? 200 : 202,
  }))
    assert.equal(
      tag(receiver, key),
      value,
      "wrong original load receiver " + key,
    );
  assert.equal(
    tree.parent(receiver),
    ui,
    "Runtime read outside original UI request",
  );
  return { ...proof, client, server, receiver, ui };
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
  const timeObservations = new Map();
  const recordRead = (proof) => {
    for (const observation of proof.timeObservations)
      timeObservations.set(
        JSON.stringify([
          observation.trace_id,
          observation.read_span_id,
          observation.span_id,
          observation.boundary,
          observation.event_index,
        ]),
        observation,
      );
  };
  const completedRead = (trace, server, completion) => {
    const tree = traceTopology(trace),
      proof = inspectRuntimeInformationRead(
        trace,
        tree.parent(tree.parent(server)),
      );
    const method = tag(proof.request, "rpc.method");
    if (!["session/load", "session/new"].includes(method))
      return completedInitializeRead(trace, server, completion);
    assert.equal(
      gates.stream?.status,
      "passed",
      "owning stream gate incomplete",
    );
    const receipts = (gates.stream.metadata_read_receipts ?? []).filter(
      (row) =>
        row.trace_id === trace.traceID &&
        row.read_span_id === proof.read.spanID &&
        row.server_span_id === server.spanID,
    );
    assert.equal(receipts.length, 1, "one original view load receipt required");
    const receipt = receipts[0];
    const origins = (gates.stream.owner_inventory?.http_origins ?? []).filter(
      (row) =>
        row.trace_id === trace.traceID &&
        row.ui_span_id === receipt.ui_span_id &&
        row.kind === (method === "session/new" ? "session-create" : "view"),
    );
    assert.equal(origins.length, 1, "one original view owner required");
    const bound = (
      method === "session/new"
        ? completedSessionNewRead
        : completedSessionLoadRead
    )(trace, server, receipt, completion);
    assert.equal(
      receipt.request_span_id,
      bound.request.spanID,
      "foreign load request receipt",
    );
    assert.equal(
      receipt.receiver_span_id,
      bound.receiver.spanID,
      "foreign load receiver receipt",
    );
    return bound;
  };
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
      if (!hasError(span) && span.operationName === "mcp.runtime.info.read") {
        const proof = inspectRuntimeInformationRead(trace, span);
        recordRead(
          tag(proof.request, "rpc.method") === "session/load"
            ? completedRead(trace, proof.resource.server)
            : proof,
        );
      }
      if (!hasError(span) && tag(span, "http.transport.outcome") === "canceled")
        recordRead(completedRead(trace, span));
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
              const proof = completedRead(trace, span, group.event);
              recordRead(proof);
              neutral.push({
                trace_id: trace.traceID,
                span_id: span.spanID,
                event_index: span.logs.indexOf(group.event),
                event_timestamp_us: group.event.timestamp,
                reason:
                  tag(proof.request, "rpc.method") === "session/load"
                    ? "completed-session-load-mcp-read-disconnect"
                    : tag(proof.request, "rpc.method") === "session/new"
                      ? "completed-session-new-mcp-read-disconnect"
                      : "completed-initialize-mcp-read-disconnect",
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
    time_observations: [...timeObservations.values()],
  };
}
