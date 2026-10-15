import assert from "node:assert/strict";
import { inspectBridgeOutageWindow } from "./resolve-cache-bridge-outage.mjs";
import { inspectRuntimeCancellationTiming } from "./resolve-cache-runtime-cancellation-clock.mjs";
import {
  inspectRuntimeCancellationDiagnostics,
  inspectRuntimeMetadataDiagnostics,
} from "./resolve-cache-runtime-cancellation-diagnostics.mjs";
import { chatTraceBoundary } from "../workspace-closeout/chat-trace.mjs";
import { assertWorkspaceResolveReceipt } from "../workspace-closeout/request-trace.mjs";
import {
  inspectGatewayResolution,
  assertGatewayResolutionAttributes,
} from "../../support/gateway-resolution.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";

const one = (rows, label) => {
  assert.equal(rows.length, 1, `missing or duplicate ${label}`);
  return rows[0];
};
const fields = (rows) => {
  assert(Array.isArray(rows));
  const o = Object.fromEntries(rows.map((f) => [f.key, f.value]));
  assert.equal(
    Object.keys(o).length,
    rows.length,
    "duplicate cancellation evidence field",
  );
  return o;
};
const requireTags = (span, expected) => {
  assert(span, "missing actual cancellation span");
  for (const [key, value] of Object.entries(expected))
    assert.equal(tag(span, key), value, `wrong actual cancellation ${key}`);
};
const finish = (span) => {
  assert(
    Number.isSafeInteger(span.startTime) &&
      span.startTime > 0 &&
      Number.isSafeInteger(span.duration) &&
      span.duration >= 0,
    "unfinished cancellation span",
  );
  const n = span.startTime + span.duration;
  assert(Number.isSafeInteger(n));
  return n;
};
function clean(span, service) {
  assert(!hasError(span), "unexpected cancellation error");
  finish(span);
  for (const group of [span.tags, ...(span.logs ?? []).map((e) => e.fields)])
    for (const [key, value] of Object.entries(fields(group))) {
      if (
        key === "outcome" ||
        key.endsWith(".outcome") ||
        key === "antnest.result"
      )
        assert(
          ["ok", "success", "completed", "committed", "admitted"].includes(
            value,
          ),
          "unexpected unsuccessful cancellation outcome",
        );
      else if (
        /^(error($|[._])|exception($|[._])|antnest\.(error([._]|$)|cancellation([._]|$)|http\.request_cancelled$|stream\.termination$)|otel\.status|http\.transport\.error|jsonrpc\.error|rpc\.(error|response\.status_code))/u.test(
          key,
        )
      )
        assert(
          (key === "error" && value === false) ||
            (key === "error.type" && value === "") ||
            (key === "otel.status_code" && ["OK", "UNSET"].includes(value)) ||
            (key === "antnest.error.class" && value === "none"),
          "unclassified cancellation diagnostic",
        );
      else if (key === "event")
        assert(
          ![
            "antnest.error",
            "antnest.cancelled",
            "error",
            "exception",
          ].includes(value),
          "unexpected cancellation event",
        );
      else if (["level", "severity", "severity_text"].includes(key))
        assert(
          ["INFO", "DEBUG", "TRACE"].includes(value),
          "unexpected cancellation diagnostic level",
        );
      else if (key === "process.exit.code")
        assert.equal(value, 0, "unsuccessful metadata executor");
      else if (key.startsWith("executor.exit."))
        assert(
          key === "executor.exit.classification" && value === "success",
          "unexpected executor exit diagnostic",
        );
    }
  const status = tag(span, "http.response.status_code");
  if (status !== undefined)
    assert(
      [200, 201, 202, 204, "200", "201", "202", "204"].includes(status),
      "unsuccessful cancellation HTTP span",
    );
  for (const event of span.logs ?? [])
    assert(
      Number.isSafeInteger(event.timestamp) &&
        event.timestamp >= span.startTime &&
        event.timestamp <
          finish(span) + (service === "antnest-runtime" ? 2 : 1),
      "successful cancellation event outside span",
    );
}

// Successful metadata can be SDK-closed after receipt. It is independent of
// held Tool cancellation and is never a complete-EOF clock calibration sample.
function metadataReceipt(trace, tree, client, expected, prompt, runtimeServer) {
  const parent = tree.parent(client);
  assert.equal(tree.service(client), "agent-acp-service");
  assert.equal(client.operationName, "HTTP POST antnest-runtime");
  assert.equal(client.processID, prompt.processID);
  assert.equal(parent?.processID, prompt.processID);
  assert(
    tree.chain(parent).includes(prompt),
    "metadata detached from actual prompt",
  );
  const server = one(
    trace.spans.filter((s) => tree.parent(s) === client),
    "metadata SERVER",
  );
  assert.equal(server.operationName, "HTTP POST /mcp");
  assert.equal(server.processID, runtimeServer.processID);
  const method = tag(server, "rpc.method");
  const allowed = {
    "mcp.runtime.info": ["resources/read"],
    "mcp.tools.list": ["discover", "tools/list"],
    "acp session/prompt": ["resources/read"],
  };
  assert(
    allowed[parent.operationName]?.includes(method),
    "unexpected SDK-closed Runtime request",
  );
  requireTags(server, {
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/mcp",
    "antnest.protocol.outcome": "success",
    "http.transport.outcome": "success",
    "antnest.agent.id": expected.agentID,
    "antnest.runtime.execution.id": expected.runtimeExecutionID,
    "antnest.runtime.generation": expected.runtimeGeneration,
  });
  assert([200, "200"].includes(tag(server, "http.response.status_code")));
  requireTags(client, {
    "span.kind": "client",
    "peer.service": "antnest-runtime",
    "http.request.method": "POST",
    "http.response.status_code": 200,
    "antnest.outcome": "cancelled",
    "antnest.operation.phase": "http.send_or_read",
    "antnest.cancellation.type": "AbortError",
  });
  const bytes = tag(client, "http.response.body.size");
  assert(Number.isSafeInteger(bytes) && bytes > 0);
  assert.equal(tag(server, "http.response.body.size"), bytes);
  assert(
    client.startTime >= parent.startTime,
    "metadata CLIENT began before parent",
  );
  const excess = finish(client) - finish(parent);
  assert(
    excess <= 0 ||
      (excess < 1000 &&
        client.startTime % 1000 === 0 &&
        parent.startTime % 1000 === 0),
    "metadata CLIENT outlived parent",
  );
  const operation = one(
    trace.spans.filter((s) => tree.parent(s) === server),
    "metadata Runtime operation",
  );
  assert.equal(operation.operationName, "runtime.mcp.operation");
  requireTags(operation, {
    "rpc.method": method,
    "mcp.operation.outcome": "success",
    "antnest.operation.outcome": "success",
    "antnest.agent.id": expected.agentID,
    "antnest.runtime.execution.id": expected.runtimeExecutionID,
    "antnest.runtime.generation": expected.runtimeGeneration,
  });
  for (const span of trace.spans.filter((s) =>
    tree.chain(s).includes(server),
  )) {
    assert.equal(span.processID, runtimeServer.processID);
    clean(span, "antnest-runtime");
    const owner = tree.parent(span);
    if (span !== server)
      assert(
        span.startTime >= owner.startTime && finish(span) < finish(owner) + 2,
        "metadata child outside Runtime parent",
      );
  }
  return {
    trace_id: trace.traceID,
    span_id: client.spanID,
    server_span_id: server.spanID,
    rpc_method: method,
    response_bytes: bytes,
    reason: "successful-metadata-sdk-close",
    clock_sample: false,
  };
}

// ACP's readiness SELECT is an optional sibling of the scoped business read.
// Keep this exact owning topology separate from the shared SQL driver oracle.
function auditDatabase(trace, tree, receiver) {
  const timing = [];
  const database = trace.spans.filter(
    (s) =>
      tag(s, "db.system.name") !== undefined &&
      (tree.service(s) === "agent-acp-service" ||
        tree.chain(s).includes(receiver)),
  );
  const ready = database.filter((s) => s.operationName === "postgres.ready");
  assert(ready.length <= 1, "duplicate audit readiness");
  const queries = database.filter((s) => s !== ready[0]);
  const business = one(
    queries.filter((s) => tree.parent(s) === receiver),
    "actual audit business SQL",
  );
  const sql = tag(business, "db.query.text");
  assert(typeof sql === "string");
  const normalized = sql.replace(/\s+/gu, " ").trim();
  assert(
    /^SELECT r\.id AS run_id,/iu.test(normalized) &&
      / FROM runs r JOIN acp_sessions s ON s\.id = r\.session_id WHERE s\.organization_id = \$1 AND r\.id = \$2$/iu.test(
        normalized,
      ),
    "audit query lacks actual organization and Run predicates",
  );
  if (ready.length) {
    requireTags(ready[0], {
      "span.kind": "internal",
      "db.system.name": "postgresql",
    });
    assert.equal(tree.parent(ready[0]), receiver);
    const probe = one(
      queries.filter((s) => tree.parent(s) === ready[0]),
      "audit readiness SELECT",
    );
    assert.equal(tag(probe, "db.query.text"), "SELECT 1");
    assert.equal(queries.length, 2, "unexpected audit database work");
  } else assert.equal(queries.length, 1, "unexpected audit database work");
  for (const span of database) {
    assert.equal(tree.service(span), "agent-acp-service");
    assert.equal(span.processID, receiver.processID);
    const parent = tree.parent(span);
    assert(
      span.startTime >= parent.startTime,
      "audit SQL began before its owner",
    );
    const excess = finish(span) - finish(parent);
    if (excess > 0) {
      assert(
        excess < 1000 &&
          span.startTime % 1000 === 0 &&
          parent.startTime % 1000 === 0,
        "audit SQL outlived its owning operation",
      );
      timing.push({
        trace_id: trace.traceID,
        span_id: span.spanID,
        parent_span_id: parent.spanID,
        raw_end_difference_us: excess,
        reason: "same-node-sdk-sub-ms-joined-end",
      });
    }
    if (span !== ready[0]) {
      assert.equal(span.operationName, "SELECT");
      requireTags(span, {
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.operation.name": "SELECT",
      });
    }
    for (const field of [
      ...span.tags,
      ...(span.logs ?? []).flatMap((e) => e.fields),
    ])
      assert(
        ![
          "pgx.query.parameters",
          "db.connection_string",
          "pgx.prepare_stmt.name",
        ].includes(field.key) &&
          !/^db\.(query\.parameters?|query\.results?|statement\.parameters)(\.|$)/u.test(
            field.key,
          ),
        "audit SQL captured parameters/results or connection data",
      );
  }
  return timing;
}

export function inspectOutageRuntimeCancellation(
  evidence,
  collection,
  secrets = [],
) {
  const business = inspectBridgeOutageWindow(evidence);
  assert.equal(
    evidence.wire,
    undefined,
    "retired WSS evidence in Runtime cancellation",
  );
  const { traces, archivedTraceIDs } = collection;
  assert(traces instanceof Map && archivedTraceIDs instanceof Set);
  assert.deepEqual(
    [...traces.keys()].sort(),
    [...archivedTraceIDs].sort(),
    "cancellation raw archive differs",
  );
  const get = (id) => {
    assert(archivedTraceIDs.has(id), "unarchived cancellation trace");
    const t = traces.get(id);
    assert(t, "missing cancellation raw trace");
    return t;
  };
  const trace = get(evidence.prompt.trace_id),
    cancelTrace = get(evidence.cancel.trace_id);
  const all = resolveTraceSources(trace, secrets, collection);
  for (const t of all) assertGatewayResolutionAttributes(t);
  assert.equal(evidence.settings.resolveTTLMS, 10000);
  assert.equal(evidence.settings.captureRpcContent, false);
  const principal = evidence.session_deadlines.owner.principal;
  const login = (row) => {
    const l = one(
      evidence.http.filter(
        (r) =>
          r.path === "/api/session/login" &&
          r.issued_credential_scope === row.credential_scope,
      ),
      "actual dispatched credential login",
    );
    assert.equal(l.method, "POST");
    assert.equal(l.status, 200);
    assert(l.at < row.started_at);
    assert.equal(l.body.principal.organization_id, principal.organization_id);
    return l;
  };
  assert.deepEqual(
    login(evidence.prompt).body.principal,
    principal,
    "actual owner Principal differs",
  );
  assert.equal(
    evidence.cancel.credential_scope,
    evidence.prompt.credential_scope,
  );
  const request = (row, profile) => {
    assert.deepEqual(
      one(
        evidence.http.filter((r) => r.trace_id === row.trace_id),
        "actual HTTP observation",
      ),
      row,
      "changed actual HTTP observation",
    );
    login(row);
    const raw = get(row.trace_id),
      tree = traceTopology(raw),
      root = one(
        raw.spans.filter((s) => !tree.parent(s)),
        "actual HTTP root",
      );
    const route =
        profile === "workspace"
          ? "/api/app/workspace/v1/{path...}"
          : "/api/admin/{path...}",
      service = profile === "workspace" ? "agent-ui" : "admin-console";
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(root.operationName, `HTTP ${row.method} ${route}`);
    requireTags(root, {
      "span.kind": "server",
      "http.request.method": row.method,
      "http.route": route,
      "http.response.status_code": row.status,
    });
    const upstream = one(
      raw.spans.filter(
        (s) =>
          tree.parent(s) === root &&
          s.operationName === `HTTP ${row.method} ${service}`,
      ),
      "actual Gateway forwarding",
    );
    assert.equal(tree.service(upstream), "edge-gateway");
    requireTags(upstream, {
      "span.kind": "client",
      "http.request.method": row.method,
      "http.response.status_code": row.status,
    });
    const receiver = one(
      raw.spans.filter(
        (s) => tree.parent(s) === upstream && tree.service(s) === service,
      ),
      "actual HTTP receiver",
    );
    requireTags(receiver, {
      "span.kind": "server",
      "http.request.method": row.method,
      "http.response.status_code": row.status,
      "http.route":
        profile === "workspace"
          ? "/api/app/workspace/v1/*"
          : "/api/admin/execution-audits/{run_id}",
    });
    const decision = one(
      raw.spans.filter((s) => s.operationName === "gateway.identity.resolve"),
      "actual Resolve decision",
    );
    const resolution = inspectGatewayResolution(
      raw,
      {
        rootSpanID: root.spanID,
        upstreamSpanID: upstream.spanID,
        decisionSpanID: decision.spanID,
        profile,
        ttlMs: 10000,
      },
      collection,
    );
    assertWorkspaceResolveReceipt(raw, resolution, collection);
    return { trace: raw, tree, root, upstream, receiver, resolution };
  };
  const promptHTTP = request(evidence.prompt, "workspace"),
    cancelHTTP = request(evidence.cancel, "workspace");
  const { tree, prompt, run, calls } = chatTraceBoundary(trace, {
    sessionId: evidence.session_id,
    bridge: true,
    requireTools: true,
  });
  const promptACK = tree.parent(prompt);
  assert.equal(promptACK.processID, prompt.processID);
  assert.equal(tree.service(promptACK), "agent-acp-service");
  assert.equal(tree.parent(promptACK), promptHTTP.receiver);
  requireTags(promptACK, {
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/v1/acp",
    "http.response.status_code": 202,
  });
  requireTags(prompt, { "antnest.agent.id": evidence.agent_id });
  requireTags(run, {
    "antnest.run.id": evidence.run_id,
    "antnest.session.id": evidence.session_id,
  });
  assert.equal(calls.length, 1, "held bash executed extra Runtime tools");
  const acp = (name) =>
    trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" && s.operationName === name,
    );
  const model = one(acp("model.complete"), "single successful model"),
    modelHTTP = one(acp("HTTP POST model"), "single Provider request"),
    tool = one(acp("mcp.tools.call"), "single ACP Tool");
  assert.equal(tree.parent(modelHTTP), model);
  assert.equal(tree.parent(model), run);
  const modelRequest = one(
    evidence.model_cancelled.state.requests.filter(
      (r) => r.phase === "c4-cache-runtime-outage",
    ),
    "actual held Runtime model dispatch",
  );
  assert.equal(modelRequest.trace_id, trace.traceID);
  assert.equal(modelRequest.model_span_id, modelHTTP.spanID);
  requireTags(model, {
    "antnest.outcome": "ok",
    "antnest.model.result.kind": "tool_calls",
    "antnest.organization.id": principal.organization_id,
    "antnest.execution.revision": evidence.runtime.execution_revision,
    "antnest.runtime.execution_id": evidence.runtime.runtime_execution_id,
    "antnest.runtime.revision": evidence.runtime.runtime_revision,
  });
  requireTags(modelHTTP, {
    "span.kind": "client",
    "http.request.method": "POST",
    "http.response.status_code": 200,
  });
  assert(
    Number.isSafeInteger(tag(modelHTTP, "http.response.body.size")) &&
      tag(modelHTTP, "http.response.body.size") > 0,
  );
  const finishSQL = one(
    acp("SELECT").filter((s) =>
      /^WITH finished AS \(UPDATE runs\b/iu.test(
        (tag(s, "db.query.text") ?? "").replace(/\s+/gu, " "),
      ),
    ),
    "actual terminal SQL",
  );
  const cancel = one(
    cancelTrace.spans.filter(
      (s) =>
        s.operationName === "acp session/cancel" &&
        cancelHTTP.tree.service(s) === "agent-acp-service",
    ),
    "actual internal cancel",
  );
  const acpHTTP = cancelHTTP.tree.parent(cancel);
  assert.equal(cancelHTTP.tree.service(acpHTTP), "agent-acp-service");
  assert.equal(acpHTTP.processID, cancel.processID);
  assert.equal(acpHTTP.operationName, "HTTP POST /v1/acp");
  assert.equal(cancelHTTP.tree.parent(acpHTTP), cancelHTTP.receiver);
  requireTags(acpHTTP, {
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/v1/acp",
    "http.response.status_code": 202,
  });
  const application = one(
    cancelTrace.spans.filter(
      (s) =>
        cancelHTTP.tree.parent(s) === cancel &&
        s.operationName === "acp.session.cancel",
    ),
    "actual cancel execution",
  );
  requireTags(application, {
    "antnest.agent.id": evidence.agent_id,
    "antnest.session.id": evidence.session_id,
    "antnest.outcome": "ok",
  });
  assert.equal(application.processID, cancel.processID);
  assert(
    application.startTime >= cancel.startTime,
    "cancel application predates its dispatch",
  );
  // The dispatch awaits this exact child. Preserve the same Node SDK
  // integer-ms anchor observation already used for joined SQL/HTTP endings.
  const cancelTiming = [],
    cancelExcess = finish(application) - finish(cancel);
  if (cancelExcess > 0) {
    assert(
      cancelExcess < 1000 &&
        application.startTime % 1000 === 0 &&
        cancel.startTime % 1000 === 0,
      "cancel application outlived its dispatch",
    );
    cancelTiming.push({
      trace_id: cancelTrace.traceID,
      span_id: application.spanID,
      parent_span_id: cancel.spanID,
      raw_end_difference_us: cancelExcess,
      reason: "same-node-sdk-sub-ms-joined-end",
    });
  }
  const auditTiming = [];
  for (const row of [evidence.audit_before, evidence.audit]) {
    const a = request(row, "console");
    const receiver = one(
      a.trace.spans.filter(
        (s) =>
          a.tree.service(s) === "agent-acp-service" &&
          tag(s, "rpc.method") === "get_execution_audit",
      ),
      "actual audit RPC",
    );
    requireTags(receiver, {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/rpc/agent-acp/get-execution-audit",
      "http.response.status_code": 200,
      "antnest.organization.id": principal.organization_id,
    });
    const client = a.tree.parent(receiver);
    assert.equal(a.tree.parent(client), a.receiver);
    assert.equal(client.operationName, "HTTP POST agent-acp-service");
    assert.equal(a.tree.service(client), "admin-console");
    assert.equal(client.processID, a.receiver.processID);
    requireTags(client, {
      "span.kind": "client",
      "http.request.method": "POST",
      "http.response.status_code": 200,
    });
    auditTiming.push(...auditDatabase(a.trace, a.tree, receiver));
    for (const span of a.trace.spans) clean(span, a.tree.service(span));
  }
  const runtime = evidence.runtime,
    generation = runtime.started.status.generation;
  assert(
    Number.isSafeInteger(generation) && generation > 0,
    "actual Runtime generation missing",
  );
  assert.equal(runtime.container.generation, generation);
  for (const row of [
    runtime.started,
    runtime.before_cancel,
    runtime.quiescent,
  ]) {
    assert.equal(row.status.agent_id, evidence.agent_id);
    assert.equal(row.status.generation, generation);
  }
  const server = calls[0],
    resource = trace.processes[server.processID];
  fields(resource.tags);
  requireTags(resource, {
    "antnest.agent.id": evidence.agent_id,
    "antnest.runtime.generation": String(generation),
    "antnest.runtime.image.id": runtime.container.image,
  });
  const expected = {
    cancelTrace,
    cancelSpanID: cancel.spanID,
    promptSpanID: prompt.spanID,
    runSpanID: run.spanID,
    modelSpanID: model.spanID,
    toolSpanID: tool.spanID,
    finishSpanID: finishSQL.spanID,
    runtimeSpanID: server.spanID,
    runtimeExecutionID: runtime.runtime_execution_id,
    runtimeGeneration: String(generation),
    agentID: evidence.agent_id,
    runID: evidence.run_id,
    organizationID: principal.organization_id,
    executionRevision: runtime.execution_revision,
    runtimeRevision: runtime.runtime_revision,
    processGroupID: runtime.started.work.pgid,
  };
  const timing = inspectRuntimeCancellationTiming(trace, expected),
    diagnostics = inspectRuntimeCancellationDiagnostics(trace, expected);
  for (const metadataServer of trace.spans.filter(
    (s) =>
      tree.service(s) === "antnest-runtime" &&
      tag(s, "span.kind") === "server" &&
      s !== server,
  ))
    inspectRuntimeMetadataDiagnostics(trace, metadataServer, expected);
  const claimed = new Set(
    [...diagnostics.owned_error_spans, ...diagnostics.transport_receipts].map(
      (c) => c.span_id,
    ),
  );
  const metadata = [];
  for (const span of trace.spans)
    if (
      !claimed.has(span.spanID) &&
      tag(span, "antnest.outcome") === "cancelled"
    ) {
      metadata.push(
        metadataReceipt(trace, tree, span, expected, prompt, server),
      );
      claimed.add(span.spanID);
    }
  for (const span of trace.spans)
    if (!claimed.has(span.spanID)) clean(span, tree.service(span));
  for (const span of cancelTrace.spans)
    clean(span, cancelHTTP.tree.service(span));
  return {
    ...diagnostics,
    status: "passed",
    trace_id: trace.traceID,
    cancel_trace_id: cancelTrace.traceID,
    run_id: evidence.run_id,
    runtime_calls: 1,
    provider_requests: 1,
    business,
    timing,
    audit_time_observations: auditTiming,
    cancel_time_observations: cancelTiming,
    metadata_receipts: metadata,
    gateway_resolution: {
      prompt: promptHTTP.resolution,
      cancel: cancelHTTP.resolution,
    },
    ...resolveTraceDiagnostics(trace, [trace, cancelTrace]),
  };
}
