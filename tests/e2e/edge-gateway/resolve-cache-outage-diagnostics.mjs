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
      if (!hasError(span) && span.operationName === "mcp.runtime.info.read")
        recordRead(inspectRuntimeInformationRead(trace, span));
      if (!hasError(span) && tag(span, "http.transport.outcome") === "canceled")
        recordRead(completedInitializeRead(trace, span));
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
              recordRead(completedInitializeRead(trace, span, group.event));
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
    time_observations: [...timeObservations.values()],
  };
}
