import assert from "node:assert/strict";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { inspectOutageCloseInventory } from "./resolve-cache-outage-close-capture.mjs";
import { loadSpanKey } from "./resolve-cache-load-close.mjs";

const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const fields = (rows = []) => {
  const result = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  assert.equal(
    Object.keys(result).length,
    rows.length,
    "duplicate owner field",
  );
  return result;
};
const end = (span) => {
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
    "unfinished owner span",
  );
  return span.startTime + span.duration;
};
function attributes(span, expected) {
  fields(span.tags);
  for (const [key, value] of Object.entries(expected))
    assert.equal(tag(span, key), value, `owner ${key} differs`);
  end(span);
}
function processIdentity(trace, span, service) {
  const process = trace.processes[span.processID];
  assert.equal(process.serviceName, service);
  const resource = fields(process.tags);
  assert(
    typeof resource["host.name"] === "string" && resource["host.name"],
    "owner host missing",
  );
  assert(
    Number.isSafeInteger(resource["process.pid"]) &&
      resource["process.pid"] > 0,
    "owner PID missing",
  );
  if (service === "agent-acp-service")
    assert(
      typeof resource["service.instance.id"] === "string" &&
        resource["service.instance.id"],
      "owner ACP instance missing",
    );
  return Object.fromEntries(
    ["host.name", "process.pid", "service.instance.id"]
      .filter((key) => resource[key] !== undefined)
      .map((key) => [key, resource[key]]),
  );
}
const parentReference = (trace, span, parent) =>
  assert.deepEqual(
    span.references,
    [
      {
        refType: "CHILD_OF",
        traceID: trace.traceID,
        spanID: parent.spanID,
      },
    ],
    "private receipt must retain its actual HTTP parent",
  );
const scopeKey = (scope) =>
  JSON.stringify([scope.organization_id, scope.user_id, scope.agent_id]);

// This is a required structural inventory, not error or shutdown admission.
// Its caller must still validate Resolve, denied-origin semantics, precise
// stream/close diagnostics and each service's observed lifecycle/clock.
export function inspectOutageOwnerInventory(evidence, collection) {
  const { traces, archivedTraceIDs, cleanupSearches } = collection;
  assert(
    traces instanceof Map && traces.size > 0 && archivedTraceIDs instanceof Set,
  );
  assert(cleanupSearches, "owner cleanup inventory missing");
  const inventory = inspectOutageCloseInventory(
    cleanupSearches,
    traces,
    archivedTraceIDs,
  );
  const base = `/api/app/workspace/v1/agents/${encodeURIComponent(evidence.agent_id)}`;
  const restart = one(
    evidence.consumer_restarts.filter((r) => r.service === "agent-ui"),
    "one observed UI restart required",
  );
  const before = restart.before?.at,
    after = restart.after?.at,
    drain = evidence.ui_drain?.started_at;
  assert(
    [before, restart.started_at, after, drain].every(Number.isFinite) &&
      before <= restart.started_at &&
      restart.started_at < after &&
      after < drain,
    "owner UI lifecycle bounds missing",
  );
  const generation = (row) => {
    assert(
      Number.isFinite(row.started_at) &&
        Number.isFinite(row.at) &&
        row.started_at <= row.at,
      "owner HTTP observation missing",
    );
    if (row.at <= before) return 0;
    assert(
      row.started_at >= after && row.at < drain,
      "owner HTTP origin crosses UI lifecycle",
    );
    return 1;
  };
  const loginFor = (row) => {
    const login = one(
      evidence.http.filter(
        (r) =>
          r.issued_credential_scope &&
          r.issued_credential_scope === row.credential_scope,
      ),
      "actual owner credential login missing or duplicate",
    );
    assert.equal(login.path, "/api/session/login");
    assert.equal(login.method, "POST");
    assert.equal(login.status, 200);
    assert.equal(login.set_cookie_count, 2);
    assert(
      Number.isFinite(login.at) && login.at <= row.started_at,
      "owner request precedes its credential",
    );
    for (const key of ["organization_id", "user_id", "membership_id"])
      assert(
        typeof login.body?.principal?.[key] === "string" &&
          login.body.principal[key],
        "owner Principal missing",
      );
    return login;
  };
  const requests = new Map();
  const request = (id) => {
    if (requests.has(id)) return requests.get(id);
    assert(archivedTraceIDs.has(id), "private HTTP origin not archived");
    const trace = traces.get(id);
    assert(trace, "private HTTP origin missing");
    const row = one(
      evidence.http.filter((r) => r.trace_id === id),
      "actual private HTTP origin missing or duplicate",
    );
    assert.equal(row.set_cookie_count, 0);
    const tree = traceTopology(trace),
      ui = one(
        trace.spans.filter(
          (s) =>
            tree.service(s) === "agent-ui" &&
            s.operationName === "agent_ui.http.request",
        ),
        "one actual private UI receiver required",
      ),
      upstream = tree.parent(ui),
      root = tree.parent(upstream);
    assert(
      upstream && root && !tree.parent(root),
      "private HTTP origin root missing",
    );
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tree.service(upstream), "edge-gateway");
    assert.equal(
      root.operationName,
      `HTTP ${row.method} /api/app/workspace/v1/{path...}`,
    );
    assert.equal(upstream.operationName, `HTTP ${row.method} agent-ui`);
    attributes(root, {
      "span.kind": "server",
      "http.request.method": row.method,
      "http.response.status_code": row.status,
      "http.route": "/api/app/workspace/v1/{path...}",
    });
    attributes(upstream, {
      "span.kind": "client",
      "http.request.method": row.method,
      "http.response.status_code": row.status,
      "server.address": "agent-ui",
    });
    attributes(ui, {
      "span.kind": "server",
      "http.request.method": row.method,
      "http.response.status_code": row.status,
      "http.route": "/api/app/workspace/v1/*",
    });
    parentReference(trace, ui, upstream);
    parentReference(trace, upstream, root);
    assert.equal(root.references?.length ?? 0, 0);
    const gen = generation(row),
      login = loginFor(row),
      principal = login.body.principal;
    const sessionPrefix = `${base}/sessions/`;
    let kind;
    if (
      row.method === "POST" &&
      row.path === `${base}/sessions` &&
      row.status === 201
    ) {
      assert(
        typeof row.body?.sessionId === "string" && row.body.sessionId,
        "owner session creation receipt missing",
      );
      kind = "session-create";
    } else if (
      row.method === "GET" &&
      row.status === 200 &&
      (row.path === `${base}/view` ||
        (row.path.startsWith(sessionPrefix) && row.path.endsWith("/view")))
    ) {
      assert.equal(
        row.body?.agentId,
        evidence.agent_id,
        "owner view Agent differs",
      );
      if (row.path.startsWith(sessionPrefix))
        assert.equal(
          row.path,
          `${sessionPrefix}${encodeURIComponent(row.body.sessionId)}/view`,
          "owner view Session differs",
        );
      assert(
        typeof row.body.bridgeEpoch === "string" && row.body.bridgeEpoch,
        "successful owner view epoch missing",
      );
      kind = "view";
    } else {
      assert.equal(row.method, "GET");
      assert.equal(row.path, `${base}/view`, "unsupported private HTTP origin");
      assert.equal(row.status, 403);
      const restored = one(
        evidence.recovery.cases.filter(
          (c) => c.name === "deactivate" && c.restored_state?.trace_id === id,
        ),
        "403 owner lacks its actual restored-state observation",
      );
      assert.deepEqual(row, restored.restored_state);
      assert.deepEqual(
        login,
        restored.fresh_login,
        "403 owner uses another credential",
      );
      assert.deepEqual(
        principal,
        restored.login.body.principal,
        "403 owner belongs to another Principal",
      );
      assert.deepEqual(row.body, {
        code: "access_denied",
        message: "Agent access denied",
        requestId: row.body?.requestId,
        retryable: false,
        recovery: "none",
      });
      assert.match(
        row.body.requestId ?? "",
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
      );
      const event = one(
        ui.logs ?? [],
        "403 owner needs its exact denial event",
      );
      assert.deepEqual(fields(event.fields), {
        event: "antnest.ui.agent_view.failure",
        stage: "view",
        causes: '["agent_access_revoked"]',
        truncated: false,
      });
      assert(
        Number.isFinite(event.timestamp) &&
          event.timestamp >= ui.startTime &&
          event.timestamp <= end(ui),
        "403 denial outside actual UI receiver",
      );
      kind = "restored-denial";
    }
    const result = {
      trace,
      tree,
      row,
      ui,
      upstream,
      root,
      kind,
      generation: gen,
      scope: {
        organization_id: principal.organization_id,
        user_id: principal.user_id,
        agent_id: evidence.agent_id,
      },
      ui_process: processIdentity(trace, ui, "agent-ui"),
    };
    requests.set(id, result);
    return result;
  };
  // Epoch is supplied by real successful DTOs, not by host/PID values which
  // repeat across a container restart. It identifies a UI generation, not an
  // owner; different cookies and Sessions can share the same registry slot.
  const epochs = new Map(),
    uiProcesses = new Map();
  for (const row of evidence.http) {
    if (
      row.method !== "GET" ||
      row.status !== 200 ||
      !row.path?.startsWith(`${base}/`) ||
      !row.path.endsWith("/view") ||
      row.body?.bridgeEpoch === undefined
    )
      continue;
    const r = request(row.trace_id),
      epoch = row.body.bridgeEpoch;
    if (epochs.has(r.generation)) {
      assert.equal(
        epoch,
        epochs.get(r.generation),
        "inconsistent UI generation epoch",
      );
      assert.deepEqual(
        r.ui_process,
        uiProcesses.get(r.generation),
        "different UI process in one generation",
      );
    } else {
      epochs.set(r.generation, epoch);
      uiProcesses.set(r.generation, r.ui_process);
    }
  }
  assert.equal(epochs.size, 2, "both actual UI generation witnesses required");
  assert.notEqual(
    epochs.get(0),
    epochs.get(1),
    "UI epoch survived observed restart",
  );

  // A restored credential can reach an already-disabled Agent without a new
  // private request. Inventory its real HTTP denial independently of owners.
  // Cross-check both receipt inventories so neither side can omit the request.
  const restoredDenials = new Set([
    ...evidence.http
      .filter(
        (row) =>
          row.method === "GET" &&
          row.path === `${base}/view` &&
          row.status === 403,
      )
      .map((row) => row.trace_id),
    ...evidence.recovery.cases
      .filter((c) => c.name === "deactivate" && c.restored_state)
      .map((c) => c.restored_state.trace_id),
  ]);
  for (const id of restoredDenials) {
    const origin = request(id);
    assert.equal(origin.kind, "restored-denial");
    assert.equal(origin.generation, 1, "restored denial precedes UI restart");
    assert.deepEqual(
      origin.ui_process,
      uiProcesses.get(origin.generation),
      "restored denial uses another UI process",
    );
  }

  const initializations = [],
    streams = [];
  for (const trace of traces.values()) {
    const tree = traceTopology(trace);
    for (const span of trace.spans) {
      const init =
        tag(span, "rpc.method") === "initialize" &&
        tree.service(span) === "agent-acp-service";
      const get =
        span.operationName === "HTTP GET /v1/acp" ||
        (tag(span, "http.route") === "/v1/acp" &&
          tag(span, "http.request.method") === "GET");
      const watch =
        span.operationName ===
          "HTTP POST /rpc/agent-acp/watch-agent-execution-state" ||
        tag(span, "rpc.method") === "watch_agent_execution_state";
      if (!init && !get && !watch) continue;
      assert.equal(tree.service(span), "agent-acp-service");
      const origin = request(trace.traceID);
      assert.equal(
        tree.parent(span),
        origin.ui,
        "private receipt is not under its actual UI origin",
      );
      parentReference(trace, span, origin.ui);
      attributes(span, {
        "span.kind": "server",
        "http.response.status_code": 200,
      });
      const acpProcess = processIdentity(trace, span, "agent-acp-service");
      if (init) {
        assert.equal(span.operationName, "HTTP POST /v1/acp");
        attributes(span, {
          "http.request.method": "POST",
          "http.route": "/v1/acp",
          "antnest.listener": "workspace",
          "rpc.service": "acp",
          "rpc.system.name": "jsonrpc",
          "antnest.agent.id": evidence.agent_id,
        });
        initializations.push({ trace, span, origin, acpProcess });
      } else {
        assert.equal(
          span.operationName,
          watch
            ? "HTTP POST /rpc/agent-acp/watch-agent-execution-state"
            : "HTTP GET /v1/acp",
        );
        attributes(span, {
          "http.request.method": watch ? "POST" : "GET",
          "http.route": watch
            ? "/rpc/agent-acp/watch-agent-execution-state"
            : "/v1/acp",
        });
        if (watch)
          attributes(span, {
            "rpc.method": "watch_agent_execution_state",
            "rpc.service": "agent-acp",
            "rpc.system.name": "json-over-http",
            "antnest.agent.id": evidence.agent_id,
            "antnest.organization.id": origin.scope.organization_id,
          });
        else {
          attributes(span, { "antnest.listener": "workspace" });
          for (const key of ["rpc.method", "rpc.service", "rpc.system.name"])
            assert.equal(tag(span, key), undefined);
        }
        streams.push({
          trace,
          span,
          origin,
          acpProcess,
          kind: watch ? "execution-watch" : "get",
        });
      }
    }
  }
  assert(
    initializations.length > 0,
    "actual ACP initialization inventory missing",
  );
  const assigned = new Set();
  const owners = inventory.close.map((close) => {
    assert.equal(
      close.tree.parent(close.span),
      undefined,
      "owner close must be an independent root",
    );
    attributes(close.span, { "span.kind": "internal" });
    const link = one(
      close.span.references ?? [],
      "one exact owner initialization Link required",
    );
    assert.equal(link.refType, "FOLLOWS_FROM");
    const init = one(
      initializations.filter(
        (r) =>
          r.trace.traceID === link.traceID &&
          r.origin.ui.spanID === link.spanID,
      ),
      "owner close lacks its unique actual initialization",
    );
    const key = loadSpanKey(init.trace, init.span);
    assert(!assigned.has(key), "duplicate owner close for initialization");
    assigned.add(key);
    const origin = init.origin;
    assert.deepEqual(
      origin.ui_process,
      uiProcesses.get(origin.generation),
      "owner HTTP origin belongs to another UI process",
    );
    assert.deepEqual(
      processIdentity(close.trace, close.span, "agent-ui"),
      origin.ui_process,
      "close from another UI process",
    );
    assert(
      close.span.startTime > origin.ui.startTime,
      "owner close precedes initialization origin",
    );
    if (origin.kind === "session-create") {
      const path = `${base}/sessions/${encodeURIComponent(origin.row.body.sessionId)}/view`;
      assert(
        [...requests.values()].some(
          (r) =>
            r.kind === "view" &&
            r.row.path === path &&
            r.row.credential_scope === origin.row.credential_scope &&
            r.generation === origin.generation &&
            r.row.started_at >= origin.row.at,
        ),
        "session creation lacks its actual same-generation view witness",
      );
    }
    return { init, close, origin, streams: [] };
  });
  assert.equal(
    assigned.size,
    initializations.length,
    "actual initialization lacks its owner close",
  );
  for (const owner of owners)
    for (const other of owners) {
      if (
        owner === other ||
        owner.origin.generation !== other.origin.generation ||
        scopeKey(owner.origin.scope) !== scopeKey(other.origin.scope) ||
        owner.origin.ui.startTime > other.origin.ui.startTime
      )
        continue;
      assert(
        end(owner.close.span) <= other.origin.ui.startTime,
        "overlapping owners for one actual UI scope",
      );
    }
  for (const row of streams) {
    assert.deepEqual(
      row.origin.ui_process,
      uiProcesses.get(row.origin.generation),
      "private stream belongs to another UI process",
    );
    const owner = one(
      owners.filter(
        (o) =>
          o.origin.generation === row.origin.generation &&
          scopeKey(o.origin.scope) === scopeKey(row.origin.scope) &&
          row.origin.ui.startTime >= o.origin.ui.startTime &&
          row.origin.ui.startTime < o.close.span.startTime,
      ),
      "private stream has no unique actual owner",
    );
    assert.deepEqual(
      row.acpProcess,
      owner.init.acpProcess,
      "private stream belongs to another ACP process",
    );
    owner.streams.push(row);
  }
  for (const row of inventory.delete) {
    const owner = one(
      owners.filter(
        (o) =>
          o.close.trace === row.trace &&
          row.tree.parent(row.span) === o.close.span,
      ),
      "DELETE lacks its exact owner close parent",
    );
    parentReference(row.trace, row.span, owner.close.span);
    assert.deepEqual(
      processIdentity(row.trace, row.span, "agent-acp-service"),
      owner.init.acpProcess,
      "DELETE belongs to another ACP process",
    );
  }
  for (const owner of owners) {
    assert(
      owner.streams.some((r) => r.kind === "get"),
      "owner private GET inventory missing",
    );
    assert(
      owner.streams.some((r) => r.kind === "execution-watch"),
      "owner execution watch inventory missing",
    );
  }
  return {
    status: "mapped_owning_admission_pending",
    owners: owners
      .sort((a, b) => a.origin.row.started_at - b.origin.row.started_at)
      .map((o) => ({
        origin_trace_id: o.init.trace.traceID,
        origin_ui_span_id: o.origin.ui.spanID,
        initialization_span_id: o.init.span.spanID,
        close_trace_id: o.close.trace.traceID,
        close_span_id: o.close.span.spanID,
        generation: o.origin.generation,
        bridge_epoch: epochs.get(o.origin.generation),
        scope: o.origin.scope,
        origin_kind: o.origin.kind,
        streams: o.streams.map((r) => ({
          trace_id: r.trace.traceID,
          span_id: r.span.spanID,
          ui_span_id: r.origin.ui.spanID,
          kind: r.kind,
        })),
      })),
    http_origins: [...requests.values()].map((r) => ({
      trace_id: r.trace.traceID,
      ui_span_id: r.ui.spanID,
      generation: r.generation,
      kind: r.kind,
    })),
  };
}
