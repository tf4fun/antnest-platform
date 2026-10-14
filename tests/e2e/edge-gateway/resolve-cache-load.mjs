import assert from "node:assert/strict";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { inspectCatalogRuntime } from "../acp-plan/requests.mjs";
import {
  inspectGatewayResolution,
  assertGatewayResolutionAttributes,
} from "../../support/gateway-resolution.mjs";
import { resolveTraceDiagnostics } from "../../support/gateway-resolution-evidence.mjs";
import { inspectOrganizationRefresh } from "../identity-closeout/organization-freshness.mjs";
import { inspectLoadOwnerDrain } from "./resolve-cache-owner-drain.mjs";
import {
  inspectLoadCleanup,
  loadSpanKey,
} from "./resolve-cache-load-close.mjs";

const one = (rows, label) => {
  assert.equal(rows.length, 1, `missing or duplicate ${label}`);
  return rows[0];
};
const key = (trace, span) => `${trace.traceID}:${span.spanID}`;
const runtimeOperationSucceeded = (span) =>
  span.operationName === "runtime.mcp.operation" &&
  tag(span, "error.type") === "" &&
  tag(span, "otel.status_code") === "OK" &&
  tag(span, "mcp.operation.outcome") === "success" &&
  tag(span, "antnest.operation.outcome") === "success";

function runtimeSuccessEvent(span, event, agentID) {
  const value = (name) => tag({ tags: event.fields }, name);
  if (!(
    value("error.type") === "" &&
    value("level") === "INFO" &&
    value("service.name") === "antnest-runtime" &&
    tag(span, "antnest.agent.id") === agentID &&
    value("antnest.agent.id") === tag(span, "antnest.agent.id") &&
    value("trace_id") === span.traceID &&
    value("span_id") === span.spanID
  ))
    return false;
  if (value("event") === "Runtime MCP operation completed")
    return (
      runtimeOperationSucceeded(span) &&
      value("mcp.operation.outcome") === "success" &&
      value("mcp.operation.name") === tag(span, "rpc.method")
    );
  if (value("event") === "Runtime Executor completed")
    return (
      span.operationName === "runtime.executor" &&
      tag(span, "otel.status_code") === "OK" &&
      tag(span, "executor.outcome") === "success" &&
      value("outcome") === "success"
    );
  return (
    value("event") === "Runtime HTTP request completed" &&
    span.operationName === "HTTP POST /mcp" &&
    tag(span, "http.transport.outcome") === "success" &&
    tag(span, "antnest.protocol.outcome") === "success" &&
    [200, "200"].includes(tag(span, "http.response.status_code")) &&
    value("http.transport.outcome") === "success" &&
    [200, "200"].includes(value("http.response.status_code")) &&
    value("http.request.method") === tag(span, "http.request.method") &&
    value("url.path") === tag(span, "http.route")
  );
}

function failedEvent(span, event, runtime, agentID) {
  const names = (event.fields ?? []).map((field) => field.key);
  if (new Set(names).size !== names.length) return true;
  if (["exception", "error", "antnest.error"].includes(event.name)) return true;
  const successful = runtime && runtimeSuccessEvent(span, event, agentID);
  return (event.fields ?? []).some(({ key, value }) => {
    if (/^(?:exception|error)(?:\.|$)|^antnest\.error\./u.test(key))
      return !(key === "error.type" && value === "" && successful);
    return (
      (key === "event" &&
        ["exception", "error", "antnest.error"].includes(value)) ||
      (key === "level" && ["ERROR", "FATAL"].includes(value)) ||
      (key === "otel.status_code" && ["ERROR", 2].includes(value)) ||
      (key.endsWith("outcome") &&
        [
          "error",
          "failure",
          "failed",
          "rejected",
          "canceled",
          "cancelled",
        ].includes(value))
    );
  });
}

function exactObject(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function boundedString(value, maximum) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}
function sessionPage(body) {
  return (
    exactObject(body, ["items", "nextCursor"]) &&
    Array.isArray(body.items) &&
    (body.nextCursor === null || boundedString(body.nextCursor, 4096)) &&
    body.items.every(
      (item) =>
        exactObject(item, [
          "sessionId",
          "title",
          "updatedAt",
          "activeOperationId",
        ]) &&
        boundedString(item.sessionId, 200) &&
        typeof item.title === "string" &&
        (item.updatedAt === null || typeof item.updatedAt === "string") &&
        (item.activeOperationId === null ||
          boundedString(item.activeOperationId, 200)),
    )
  );
}

export function inspectLoadResponse(row) {
  assert(
    typeof row.trace_id === "string" &&
      /^(?!0{32})[a-f0-9]{32}$/u.test(row.trace_id),
    "actual HTTP response Trace missing",
  );
  assert(row.status === 200, "load HTTP request failed");
  assert(
    row.body_complete === true &&
      Number.isSafeInteger(row.body_bytes) &&
      row.body_bytes > 0,
    "complete HTTP response body missing",
  );
  assert(sessionPage(row.body), "invalid workspace sessionPage response");
  assert(
    typeof row.content_type === "string" &&
      /^application\/json(?:\s*;|$)/iu.test(row.content_type),
    "load response must be JSON",
  );
  assert(
    typeof row.cache_control === "string" &&
      row.cache_control
        .toLowerCase()
        .split(",")
        .some((v) => v.trim() === "no-store"),
    "load response must be no-store",
  );
  assert(
    row.set_cookie_count === 0,
    "load response changed the measured session",
  );
}

export function inspectLoadWire(wire) {
  assert.equal(wire.policy_revision, 4, "current HTTP load policy required");
  assert.equal(wire.transport, "http");
  assert.equal(wire.profile, "workspace");
  assert(boundedString(wire.agent_id, 200), "load Agent missing");
  assert(
    Array.isArray(wire.requests) && wire.requests.length === 100,
    "exactly 100 real HTTP requests required; initialize is inside the first",
  );
  assert(
    [wire.started_at, wire.completed_at].every(Number.isFinite),
    "load interval missing",
  );
  assert(wire.completed_at >= wire.started_at, "invalid HTTP elapsed interval");
  assert(
    wire.completed_at - wire.started_at <= 8000,
    "100 HTTP responses including initialization and bodies exceeded eight seconds",
  );
  const path = `/api/app/workspace/v1/agents/${encodeURIComponent(wire.agent_id)}/sessions`;
  const ids = new Set();
  let previous = wire.started_at;
  for (const row of wire.requests) {
    assert(
      row.method === "GET" && row.path === path,
      "load scope or HTTP route changed",
    );
    inspectLoadResponse(row);
    assert(!ids.has(row.trace_id), "duplicate HTTP response Trace");
    ids.add(row.trace_id);
    assert(
      [row.started_at, row.headers_at, row.completed_at].every(
        Number.isFinite,
      ) &&
        row.started_at >= previous &&
        row.headers_at >= row.started_at &&
        row.completed_at >= row.headers_at &&
        row.completed_at <= wire.completed_at,
      "HTTP requests must be sequential with complete bodies inside the elapsed window",
    );
    previous = row.completed_at;
  }
  assert(
    wire.requests.at(-1).started_at >= wire.requests[0].completed_at + 5000,
    "final HTTP request must follow half TTL after the initial complete response",
  );
  return wire.requests;
}

const end = (span) => span.startTime + span.duration;
const resolveClient = (tree, span) =>
  tree.service(span) === "edge-gateway" &&
  tag(span, "span.kind") === "client" &&
  tag(span, "http.request.method") === "POST" &&
  span.operationName === "HTTP POST identity-service";
const resolveServer = (tree, span) =>
  tree.service(span) === "identity-service" &&
  tag(span, "span.kind") === "server" &&
  tag(span, "http.route") === "/rpc/identity/resolve-access-token";

function sessionListSQL(trace, tree, request, operation) {
  const ancestry = tree.chain(operation);
  assert(
    ancestry.includes(request),
    "list operation detached from its request",
  );
  for (const span of ancestry.slice(0, ancestry.indexOf(request) + 1))
    assert.equal(
      span.processID,
      request.processID,
      "foreign process list operation",
    );
  const database = trace.spans.filter(
    (span) =>
      (tag(span, "db.system.name") === "postgresql" ||
        tag(span, "db.query.text") !== undefined) &&
      tree.chain(span).includes(operation),
  );
  for (const span of database) {
    const chain = tree.chain(span);
    for (const driver of chain.slice(0, chain.indexOf(operation))) {
      assert.equal(
        driver.processID,
        request.processID,
        "foreign process list SQL",
      );
      assert.equal(
        tag(driver, "db.system.name"),
        "postgresql",
        "non-driver list SQL ancestor",
      );
      assert(
        !["acquire", "pool.acquire"].includes(driver.operationName) &&
          tag(driver, "pgx.prepare_stmt.name") === undefined,
        "prepare/pool acquisition is not list SQL execution",
      );
      for (const field of [
        ...(driver.tags ?? []),
        ...(driver.logs ?? []).flatMap((event) => event.fields ?? []),
      ])
        assert(
          !["pgx.query.parameters", "db.connection_string"].includes(
            field.key,
          ) &&
            !/^db\.(query\.parameters?|query\.results?|statement\.parameters)(\.|$)/u.test(
              field.key,
            ),
          "list SQL parameters/results or connection string captured",
        );
      const query = tag(driver, "db.query.text");
      if (driver.operationName === "postgresql transaction") {
        assert.equal(tag(driver, "span.kind"), "internal");
        assert.equal(
          tree.parent(driver),
          operation,
          "transaction must belong to its list operation",
        );
        assert.equal(
          query,
          undefined,
          "transaction observation is not SQL execution",
        );
      } else {
        assert.equal(
          tag(driver, "span.kind"),
          "client",
          "list DB span must be CLIENT",
        );
        const name = tag(driver, "db.operation.name");
        const execution =
          typeof name === "string" &&
          /^[A-Z]+$/u.test(name) &&
          driver.operationName === name;
        if (execution)
          assert(query !== undefined, "list query execution missing SQL text");
        assert(
          execution ||
            (query === undefined &&
              ["connect", "batch start"].includes(driver.operationName)),
          "list SQL ancestry must contain only low-cardinality driver operations",
        );
      }
      if (query !== undefined)
        assert(
          typeof query === "string" && query.trim(),
          "empty list SQL query",
        );
    }
  }
  // Connections and transaction observations remain in the raw closure, but
  // only actual query executions count as evidence for the list operation.
  return database.filter((span) => tag(span, "db.query.text") !== undefined);
}

function bridgeRequest(trace, tree, root, agentID, first, collection, ttl) {
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.request.method"), "GET");
  assert.equal(tag(root, "http.route"), "/api/app/workspace/v1/{path...}");
  assert.equal(tag(root, "http.response.status_code"), 200);
  const node = one(
    trace.spans.filter(
      (s) => tree.service(s) === "agent-ui" && tag(s, "span.kind") === "server",
    ),
    "actual Bridge receiver",
  );
  assert.equal(node.operationName, "agent_ui.http.request");
  assert.equal(tag(node, "http.request.method"), "GET");
  assert.equal(tag(node, "http.route"), "/api/app/workspace/v1/*");
  assert.equal(tag(node, "http.response.status_code"), 200);
  const upstream = tree.parent(node);
  assert.equal(tree.parent(upstream), root);
  assert.equal(tree.service(upstream), "edge-gateway");
  assert.equal(tag(upstream, "span.kind"), "client");
  assert.equal(upstream.operationName, "HTTP GET agent-ui");
  assert.equal(tag(upstream, "http.request.method"), "GET");
  assert.equal(tag(upstream, "server.address"), "agent-ui");
  assert.equal(tag(upstream, "http.response.status_code"), 200);
  const decision = one(
    trace.spans.filter((s) => s.operationName === "gateway.identity.resolve"),
    "HTTP workspace Resolve decision",
  );
  const resolution = inspectGatewayResolution(
    trace,
    {
      rootSpanID: root.spanID,
      decisionSpanID: decision.spanID,
      profile: "workspace",
      ttlMs: ttl,
      upstreamSpanID: upstream.spanID,
    },
    collection,
  );
  if (first)
    assert.equal(resolution.source, "rpc", "first measured scope must be cold");
  const methods = trace.spans.filter(
    (s) =>
      tree.service(s) === "agent-acp-service" &&
      tag(s, "rpc.service") === "acp",
  );
  assert.equal(
    methods.length,
    first ? 2 : 1,
    "unexpected ACP load work or owner reinitialization",
  );
  const request = (method) => {
    const rpc = one(
      methods.filter((s) => tag(s, "rpc.method") === method),
      `actual ACP ${method} receipt`,
    );
    assert.equal(tag(rpc, "span.kind"), "server");
    assert.equal(tag(rpc, "rpc.system.name"), "jsonrpc");
    assert.equal(tag(rpc, "antnest.protocol.version"), "v1");
    assert.equal(tag(rpc, "antnest.agent.id"), agentID);
    assert(
      boundedString(tag(rpc, "antnest.request.id"), 200),
      "actual ACP request ID missing",
    );
    const http = tree
      .chain(rpc)
      .find(
        (s) =>
          tree.service(s) === "agent-acp-service" &&
          tag(s, "span.kind") === "server" &&
          tag(s, "http.route") === "/v1/acp" &&
          tag(s, "http.request.method") === "POST",
      );
    assert(http, "ACP request detached from actual private HTTP receipt");
    assert.equal(tag(http, "antnest.listener"), "workspace");
    // Initialize creates the connection synchronously; subsequent requests are
    // accepted with 202 and their results arrive on the existing GET stream.
    assert.equal(
      tag(http, "http.response.status_code"),
      method === "initialize" ? 200 : 202,
      `ACP ${method} HTTP receipt has the wrong delivery mode`,
    );
    // Agent UI injects its active SERVER context directly; there is no invented
    // outbound CLIENT span or WebSocket connection link in this HTTP chain.
    assert.equal(tree.parent(http), node);
    return rpc;
  };
  const list = request("session/list");
  let initialize;
  if (first) {
    initialize = request("initialize");
    assert(
      end(initialize) <= list.startTime,
      "list preceded completed cold initialization",
    );
    inspectCatalogRuntime(trace, tree, initialize, { method: "initialize" });
  } else {
    assert(
      !trace.spans.some((s) => tree.service(s) === "antnest-runtime"),
      "warm list unexpectedly executed Runtime work",
    );
  }
  const operation = one(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" &&
        s.operationName === "acp.session.list",
    ),
    "actual session-list business operation",
  );
  assert.equal(tag(operation, "antnest.agent.id"), agentID);
  const sql = sessionListSQL(trace, tree, list, operation);
  assert(
    sql.some(
      (s) =>
        s.operationName === "SELECT" &&
        tag(s, "span.kind") === "client" &&
        tag(s, "db.operation.name") === "SELECT" &&
        /\bFROM\s+acp_sessions\b/iu.test(tag(s, "db.query.text") ?? ""),
    ),
    "session list lacks its actual PostgreSQL SELECT",
  );
  for (const span of trace.spans) {
    assert(
      !/^(agent\.run$|model\.|mcp\.tools\.call$|HTTP POST model$)/u.test(
        span.operationName,
      ),
      "load executed unrelated model or Runtime work",
    );
    if (tag(span, "db.query.text") !== undefined) {
      assert(
        tag(span, "span.kind") === "client" &&
          tag(span, "db.system.name") === "postgresql" &&
          typeof tag(span, "db.query.text") === "string" &&
          tag(span, "db.query.text").trim(),
        "invalid load SQL execution evidence",
      );
    }
  }
  return {
    trace_id: trace.traceID,
    ui_span_id: node.spanID,
    decision_id: decision.spanID,
    list_request_id: tag(list, "antnest.request.id"),
    list_span_id: list.spanID,
    list_sql: sql.length,
    ...(initialize ? { initialize_span_id: initialize.spanID } : {}),
  };
}

// Independent inventories count actual CLIENT attempts (including failures with
// no receiver) and actual SERVER calls before any pairing or business gate.
// Failed load work still fails admission; an absent receipt cannot reduce either
// inventory or manufacture a successful business/SQL result.
export function inspectResolveLoad(
  wire,
  agentID,
  settings,
  collection,
  secrets = [],
) {
  assert.equal(settings.resolveTTLMS, 10000, "load must use default TTL");
  assert.equal(settings.captureRpcContent, false);
  const requests = inspectLoadWire(wire);
  assert.equal(wire.agent_id, agentID);
  inspectLoadOwnerDrain(wire, collection.ownerLifecycle);
  const { traces, archivedTraceIDs } = collection;
  const measured = new Set(requests.map((row) => row.trace_id));
  const clients = [],
    servers = [],
    refreshes = [],
    roots = new Map(),
    trees = new Map();
  for (const [id, trace] of traces) {
    assert.equal(trace.traceID, id);
    assert(archivedTraceIDs.has(id), "raw load source not archived");
    const tree = traceTopology(trace);
    assertCaptureDisabled(trace);
    assertGatewayResolutionAttributes(trace);
    assertSecretFree(JSON.stringify(trace), secrets);
    const root = one(
      trace.spans.filter((span) => !tree.parent(span)),
      "complete load root",
    );
    roots.set(id, root);
    trees.set(id, tree);
    for (const span of trace.spans) {
      const names = (span.tags ?? []).map((field) => field.key);
      assert.equal(
        new Set(names).size,
        names.length,
        "duplicate load span attribute",
      );
      assert(
        Number.isFinite(span.startTime) &&
          Number.isFinite(span.duration) &&
          span.duration >= 0,
        "unfinished load span",
      );
      if (resolveClient(tree, span)) clients.push({ trace, span, tree });
      if (resolveServer(tree, span)) servers.push({ trace, span, tree });
    }
    if (!measured.has(id)) {
      if (
        (tree.service(root) === "agent-ui" &&
          root.operationName === "agent_ui.acp.close") ||
        (tree.service(root) === "agent-acp-service" &&
          root.operationName === "HTTP GET /status")
      )
        continue;
      assert.equal(tree.service(root), "edge-gateway");
      assert.equal(
        root.operationName,
        "gateway.identity.resolve.refresh",
        "unmeasured request in load source scope",
      );
      refreshes.push({ trace, root, tree });
    }
  }
  assert(
    clients.length >= 1 && clients.length <= 3,
    "Gateway actual Resolve attempts exceed budget",
  );
  assert(
    servers.length >= 1 && servers.length <= 3,
    "Identity actual Resolve receipts exceed budget",
  );
  const receipts = requests.map((row, index) => {
    const trace = traces.get(row.trace_id);
    assert(trace, "actual HTTP request Trace missing");
    return bridgeRequest(
      trace,
      trees.get(row.trace_id),
      roots.get(row.trace_id),
      agentID,
      index === 0,
      collection,
      settings.resolveTTLMS,
    );
  });
  const final = receipts.at(-1);
  let finalRefresh = 0;
  for (const { trace, root } of refreshes) {
    const link = one(
      root.references.filter((ref) => ref.refType === "FOLLOWS_FROM"),
      "refresh trigger link",
    );
    assert(measured.has(link.traceID), "foreign background trigger");
    inspectOrganizationRefresh(
      trace,
      {
        traceID: trace.traceID,
        triggerTraceID: link.traceID,
        triggerDecisionID: link.spanID,
        profile: "workspace",
        ttlMS: settings.resolveTTLMS,
      },
      secrets,
      {
        ...collection,
        // The display inspector covers this refresh and its exact warm
        // trigger. Initial-owner streams remain raw in the enclosing load,
        // whose errors are all checked individually below.
        traces: new Map([
          [trace.traceID, trace],
          [link.traceID, traces.get(link.traceID)],
        ]),
      },
    );
    if (link.traceID === final.trace_id && link.spanID === final.decision_id)
      finalRefresh++;
  }
  assert.equal(
    finalRefresh,
    1,
    "100th HTTP request must trigger one completed half-TTL refresh",
  );
  for (const client of clients) {
    assert.equal(
      tag(client.span, "http.response.status_code"),
      200,
      "failed load Resolve CLIENT",
    );
    const receipt = one(
      servers.filter(
        (row) =>
          row.trace === client.trace &&
          row.tree.parent(row.span) === client.span,
      ),
      "Identity receipt for actual CLIENT",
    );
    assert.equal(tag(receipt.span, "rpc.method"), "resolve_access_token");
    assert.equal(tag(receipt.span, "http.request.method"), "POST");
    assert.equal(tag(receipt.span, "http.response.status_code"), 200);
    databaseChildrenTopology(receipt.trace, receipt.span);
  }
  for (const receipt of servers)
    assert(
      clients.some(
        (row) =>
          row.trace === receipt.trace &&
          row.span === receipt.tree.parent(receipt.span),
      ),
      "unpaired Identity receipt",
    );
  const cleanup = inspectLoadCleanup(wire, agentID, collection, receipts);
  const ownedErrors = new Set(
    cleanup.classified_errors.map((row) => `${row.trace_id}:${row.span_id}`),
  );
  for (const trace of traces.values())
    for (const span of trace.spans) {
      const successfulRuntimePlaceholder =
        trace.processes[span.processID]?.serviceName === "antnest-runtime" &&
        runtimeOperationSucceeded(span);
      const failed =
        hasError(span) ||
        tag(span, "otel.status_code") === 2 ||
        tag(span, "http.response.status_code") >= 400 ||
        (tag(span, "error.type") !== undefined &&
          !successfulRuntimePlaceholder) ||
        (span.tags ?? []).some((field) =>
          /^exception(?:\.|$)|^error\.(?!type$)|^antnest\.error\./u.test(
            field.key,
          ),
        ) ||
        [...(span.logs ?? []), ...(span.events ?? [])].some((event) =>
          failedEvent(
            span,
            event,
            trace.processes[span.processID]?.serviceName === "antnest-runtime",
            agentID,
          ),
        );
      assert(
        !failed || ownedErrors.has(loadSpanKey(trace, span)),
        "unexpected load error",
      );
    }
  return {
    policy_revision: 4,
    transport: "http",
    profile: "workspace",
    measurement: {
      policy_revision: wire.policy_revision,
      transport: wire.transport,
      profile: wire.profile,
      agent_id: wire.agent_id,
      started_at: wire.started_at,
      completed_at: wire.completed_at,
      requests: wire.requests.map((row) =>
        Object.fromEntries(
          [
            "method",
            "path",
            "trace_id",
            "status",
            "started_at",
            "headers_at",
            "completed_at",
            "body_complete",
            "body_bytes",
            "content_type",
            "cache_control",
            "set_cookie_count",
          ].map((name) => [
            name,
            name === "content_type"
              ? "application/json"
              : name === "cache_control"
                ? "no-store"
                : row[name],
          ]),
        ),
      ),
    },
    raw_error_spans: [...traces.values()].flatMap((trace) =>
      trace.spans
        .filter(hasError)
        .map((span) => ({ trace_id: trace.traceID, span_id: span.spanID })),
    ),
    archived_trace_ids: [...collection.archivedTraceIDs].sort(),
    refreshes: refreshes.map(({ trace, root }) => {
      const link = root.references.find(
        (ref) => ref.refType === "FOLLOWS_FROM",
      );
      return {
        trace_id: trace.traceID,
        span_id: root.spanID,
        trigger_trace_id: link.traceID,
        trigger_decision_id: link.spanID,
      };
    }),
    exchanges: 100,
    elapsed_ms: wire.completed_at - wire.started_at,
    http_traces: receipts.length,
    cold_initialize_trace_id: receipts[0].trace_id,
    final_refresh_trigger_trace_id: final.trace_id,
    gateway_rpc_attempts: clients.length,
    identity_rpc_receipts: servers.length,
    background_refreshes: refreshes.length,
    requests: receipts,
    owner_cleanup: cleanup,
    gateway_clients: clients.map(({ trace, span }) => key(trace, span)),
    identity_servers: servers.map(({ trace, span }) => key(trace, span)),
    ...resolveTraceDiagnostics(traces.get(receipts[0].trace_id), [
      ...traces.values(),
    ]),
  };
}
