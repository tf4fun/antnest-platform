import assert from "node:assert/strict";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
} from "../observability/trace-tree.mjs";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { assertSessionSuccess as successful } from "./session-diagnostics.mjs";
import { tokenRead } from "../edge-gateway/resolve-cache-outage-stream.mjs";
import { assertPrivateACPApplicationJoined } from "../observability/private-acp-diagnostics.mjs";

const one = (rows, label) => {
  assert.equal(rows.length, 1, label);
  return rows[0];
};
const fields = (rows) => {
  const result = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  assert.equal(Object.keys(result).length, rows.length);
  return result;
};
const requireTags = (span, expected) => {
  fields(span.tags ?? []);
  for (const [key, value] of Object.entries(expected))
    assert.equal(tag(span, key), value, `wrong denial ${key}`);
};
const end = (span) => {
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
  );
  return span.startTime + span.duration;
};
// Validate the observed 403 before removing only those fields from a read-only
// diagnostic view. Every other error/event still goes through the shared gate.
function deniedHTTP(span, allowed = {}, event) {
  requireTags(span, { "http.response.status_code": 403, ...allowed });
  if (tag(span, "http.status_code") !== undefined)
    assert.equal(Number(tag(span, "http.status_code")), 403);
  successful(
    {
      ...span,
      tags: span.tags.filter(
        ({ key }) =>
          !["http.response.status_code", "http.status_code"].includes(key),
      ),
      logs: (span.logs ?? []).filter((row) => row !== event),
    },
    { error: false, ...allowed },
  );
}

// Scope is established by the caller's original browser receipt and mutation;
// the normalized UI/ACP HTTP spans do not independently expose these IDs.
export function inspectMembershipAccessDenial(
  trace,
  expected,
  secrets,
  collection,
) {
  assert.equal(expected.status, 403);
  assert.equal(expected.code, "access_denied");
  assert(
    typeof expected.body?.requestId === "string" && expected.body.requestId,
  );
  assert.deepEqual(expected.body, {
    code: "access_denied",
    message: "Agent access denied",
    requestId: expected.body.requestId,
    retryable: false,
    recovery: "none",
  });
  assert.equal(trace.traceID, expected.traceID);
  assert(collection.archivedTraceIDs.has(trace.traceID));
  const sources = resolveTraceSources(trace, secrets, collection),
    tree = traceTopology(trace);
  const by = (service) =>
    trace.spans.filter((span) => tree.service(span) === service);
  const root = one(
    trace.spans.filter((span) => !tree.parent(span)),
    "one denial Gateway root required",
  );
  assert.equal(tree.service(root), "edge-gateway");
  requireTags(root, {
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/api/app/workspace/v1/{path...}",
  });
  const ui = one(
    by("agent-ui"),
    "one denial UI receiver, with no execution, required",
  );
  assert.equal(ui.operationName, "agent_ui.http.request");
  requireTags(ui, {
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/api/app/workspace/v1/*",
  });
  const upstream = tree.parent(ui);
  assert.equal(tree.service(upstream), "edge-gateway");
  assert.equal(tree.parent(upstream), root);
  assert.equal(upstream.processID, root.processID);
  assert.equal(upstream.operationName, "HTTP POST agent-ui");
  requireTags(upstream, {
    "span.kind": "client",
    "http.request.method": "POST",
    "server.address": "agent-ui",
  });
  assert(upstream.startTime >= root.startTime && end(upstream) <= end(root));
  deniedHTTP(root);
  deniedHTTP(ui);
  assert.equal(upstream.logs?.length ?? 0, 0);
  deniedHTTP(upstream, {
    error: true,
    "error.type": "403",
    "otel.status_code": "ERROR",
    "otel.status_description": "HTTP status 403",
  });
  const acp = by("agent-acp-service");
  assert.equal(
    acp.length,
    3,
    "denial must contain only ACP observation and its readiness query",
  );
  const server = one(
    acp.filter((span) => tag(span, "span.kind") === "server"),
    "one ACP observation required",
  );
  assert.equal(tree.parent(server), ui);
  assert.equal(server.operationName, "HTTP GET unmatched");
  requireTags(server, {
    "http.request.method": "GET",
    "http.route": "unmatched",
    "antnest.listener": "workspace",
    "rpc.system.name": "json-over-http",
    "rpc.service": "agent-acp",
    "rpc.method": "read_workspace_execution",
  });
  const event = one(
    server.logs ?? [],
    "one original ACP access-denied event required",
  );
  assert.deepEqual(fields(event.fields), {
    event: "antnest.error",
    "antnest.error.stage": "workspace.bridge_observation",
    "antnest.error.type": "DomainError",
    "antnest.error.code": "access_denied",
    "antnest.error.message": "Agent access was denied",
    "antnest.error.cause_types": "[]",
    "antnest.error.causes": JSON.stringify([
      {
        type: "DomainError",
        code: "access_denied",
        message: "Agent access was denied",
      },
    ]),
    "antnest.operation.phase": "workspace.bridge_observation",
  });
  deniedHTTP(
    server,
    {
      "error.type": "DomainError",
      "antnest.operation.phase": "workspace.bridge_observation",
      "antnest.outcome": "rejected",
      "antnest.error.code": "access_denied",
      "error.code": "access_denied",
    },
    event,
  );
  const observations = [];
  assertPrivateACPApplicationJoined(
    trace,
    server,
    { ...server, startTime: event.timestamp, duration: 0 },
    observations,
    "observation-denial-event",
  );
  const ready = one(
    acp.filter((span) => span.operationName === "postgres.ready"),
    "one readiness owner required",
  );
  assert.equal(tree.parent(ready), server);
  requireTags(ready, {
    "span.kind": "internal",
    "db.system.name": "postgresql",
  });
  const sql = one(
    acp.filter((span) => tag(span, "span.kind") === "client"),
    "one readiness SQL required",
  );
  assert.equal(tree.parent(sql), ready);
  requireTags(sql, {
    "db.system.name": "postgresql",
    "db.namespace": "antnest_agent_acp",
    "db.operation.name": "SELECT",
    "db.query.text": "SELECT 1",
  });
  for (const [child, parent] of [
    [ready, server],
    [sql, ready],
  ]) {
    assert.equal(child.processID, parent.processID);
    assertPrivateACPApplicationJoined(
      trace,
      parent,
      child,
      observations,
      "observation-readiness",
    );
    successful(child);
  }
  assertPrivateACPApplicationJoined(
    trace,
    { ...server, duration: event.timestamp - server.startTime },
    ready,
    observations,
    "readiness-before-access-denied",
  );
  const decision = one(
    trace.spans.filter(
      (span) => span.operationName === "gateway.identity.resolve",
    ),
    "one original admitted Resolve required",
  );
  const resolution = inspectGatewayResolution(
    trace,
    {
      rootSpanID: root.spanID,
      decisionSpanID: decision.spanID,
      upstreamSpanID: upstream.spanID,
      profile: "workspace",
      ttlMs: 10000,
    },
    collection,
  );
  assert.equal(resolution.outcome, "admitted");
  const owned = new Set([root, upstream, ui, server, ready, sql, decision]);
  if (resolution.rpc_client_span_id) {
    const source = collection.traces.get(resolution.source_trace_id),
      sourceTree = traceTopology(source);
    const client = sourceTree.spans.get(resolution.rpc_client_span_id),
      identity = sourceTree.spans.get(resolution.identity_server_span_id);
    const read = one(
      databaseChildrenTopology(source, identity),
      "one admitted browser token read required",
    );
    requireTags(read, {
      "db.operation.name": "SELECT",
      "pgx.rows_affected": 1,
    });
    assert.equal(
      tag(read, "db.query.text")?.replace(/\s+/gu, " ").trim(),
      tokenRead,
    );
    for (const span of [client, identity, read]) {
      successful(span);
      if (source === trace) owned.add(span);
    }
  }
  successful(decision);
  for (const span of trace.spans) {
    end(span);
    assert(
      owned.has(span) && tree.chain(span).includes(root),
      "unowned denial execution or detached span",
    );
  }
  return {
    trace_id: trace.traceID,
    root_span_id: root.spanID,
    status: 403,
    code: "access_denied",
    acp_server_span_id: server.spanID,
    scope_source: "original-browser-receipt",
    gateway_resolution: resolution,
    time_observations: observations,
    ...resolveTraceDiagnostics(trace, sources),
  };
}
