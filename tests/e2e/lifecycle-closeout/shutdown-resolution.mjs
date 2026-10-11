import assert from "node:assert/strict";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import {
  databaseChildrenTopology,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";

const prefix = "antnest.identity.resolve.";
const decisionName = "gateway.identity.resolve";
const value = (span, key) => tag(span, prefix + key);
const links = (span) =>
  (span.references ?? []).filter((ref) => ref.refType === "FOLLOWS_FROM");
const one = (rows, label) => {
  assert.equal(rows.length, 1, `missing or duplicate ${label}`);
  return rows[0];
};
function end(span) {
  assert(
    Number.isFinite(span?.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
    "unfinished Resolve timing",
  );
  return span.startTime + span.duration;
}
function requestRoot(tree, root) {
  assert(
    root &&
      tree.service(root) === "edge-gateway" &&
      tag(root, "span.kind") === "server" &&
      !tree.parent(root),
    "actual Resolve request root required",
  );
  assert(
    (typeof tag(root, "http.route") === "string" &&
      typeof tag(root, "http.request.method") === "string") ||
      (tag(root, "rpc.service") === "acp" &&
        tag(root, "antnest.operation.phase") === "relay" &&
        tag(root, "network.transport") === "websocket" &&
        typeof tag(root, "rpc.method") === "string"),
    "actual HTTP or ACP source root required",
  );
  end(root);
}
function decisionUnder(tree, decision, root, profile) {
  requestRoot(tree, root);
  assert(
    tree.service(decision) === "edge-gateway" &&
      decision.operationName === decisionName &&
      tag(decision, "span.kind") === "internal" &&
      tree.parent(decision) === root,
    "wrong shutdown Resolve ancestry",
  );
  assert.equal(
    value(decision, "profile"),
    profile,
    "wrong shutdown Resolve profile",
  );
  assert(
    decision.startTime >= root.startTime && end(decision) <= end(root),
    "Resolve decision outside watch root",
  );
}
function unavailable(span) {
  assert.equal(
    value(span, "outcome"),
    "unavailable",
    "unexpected shutdown Resolve failure",
  );
  assert(hasError(span), "unavailable Resolve error missing");
  assert.equal(tag(span, "otel.status_description"), "unavailable");
  assert.equal(
    tag(span, "error.type"),
    undefined,
    "unrelated Resolve decision error",
  );
  assert.equal(
    tag(span, "antnest.error.code"),
    undefined,
    "unrelated Resolve decision error",
  );
  assert(
    !(span.logs ?? []).some((event) =>
      (event.fields ?? []).some(
        (field) =>
          ["error.type", "antnest.error.code"].includes(field.key) ||
          (field.key === "event" &&
            ["antnest.error", "exception"].includes(field.value)),
      ),
    ),
    "unrelated Resolve marker error event",
  );
}
function linked(reference, options) {
  assert(reference?.traceID && reference.spanID, "exact source link missing");
  const trace = options.traces?.get(reference.traceID);
  assert(trace?.traceID === reference.traceID, "Resolve source trace missing");
  assert(
    options.archivedTraceIDs?.has(reference.traceID),
    "Resolve source archive missing",
  );
  const tree = traceTopology(trace),
    client = tree.spans.get(reference.spanID);
  assert(client, "exact source CLIENT missing");
  return { trace, tree, client };
}
function clientShape(tree, client) {
  assert.equal(tree.service(client), "edge-gateway");
  assert.equal(tag(client, "span.kind"), "client");
  assert.equal(client.operationName, "HTTP POST identity-service");
  assert.equal(tag(client, "http.request.method"), "POST");
  end(client);
}
function cancelledTransport(client) {
  if (!hasError(client)) return false;
  assert.equal(
    tag(client, "error.type"),
    "cancelled",
    "unrelated Resolve transport error",
  );
  assert.equal(tag(client, "otel.status_description"), "Request was cancelled");
  const status = tag(client, "http.response.status_code");
  assert(
    [undefined, 200].includes(status),
    "unrelated cancelled Resolve status",
  );
  let events = 0;
  for (const event of client.logs ?? []) {
    const fields = event.fields ?? [];
    assert(
      !fields.some(
        (field) =>
          field.key.startsWith("exception.") ||
          (field.key === "event" && field.value === "exception"),
      ),
      "unrelated Resolve exception event",
    );
    if (
      !fields.some(
        (field) => field.key === "event" && field.value === "antnest.error",
      )
    ) {
      assert(
        !fields.some((field) =>
          ["error.type", "antnest.error.code", "antnest.error.stage"].includes(
            field.key,
          ),
        ),
        "unclassified Resolve error event",
      );
      continue;
    }
    assert.equal(
      one(
        fields.filter((field) => field.key === "error.type"),
        "cancellation event type",
      ).value,
      "cancelled",
      "conflicting Resolve cancellation event",
    );
    const stage = one(
      fields.filter((field) => field.key === "antnest.error.stage"),
      "cancellation event stage",
    ).value;
    assert(
      (status === undefined
        ? ["send"]
        : ["read_response", "close_response"]
      ).includes(stage),
      "Resolve cancellation stage contradicts response status",
    );
    for (const field of fields)
      if (field.key === "antnest.error.code")
        assert.equal(
          field.value,
          "cancelled",
          "conflicting Resolve cancellation event",
        );
    events += 1;
  }
  assert(events > 0, "Resolve cancellation stage missing");
  return true;
}
function receipt(selected, cancelled = false) {
  const { trace, tree, client } = selected;
  clientShape(tree, client);
  const receivers = trace.spans.filter(
    (span) =>
      tree.parent(span) === client &&
      tree.service(span) === "identity-service" &&
      tag(span, "span.kind") === "server",
  );
  if (
    cancelled &&
    tag(client, "http.response.status_code") === undefined &&
    receivers.length === 0
  )
    return;
  assert(
    tag(client, "http.response.status_code") === 200 ||
      (cancelled && tag(client, "http.response.status_code") === undefined),
    "Resolve CLIENT receipt did not succeed",
  );
  const server = one(receivers, "actual Resolve receiver");
  assert.equal(tag(server, "http.route"), "/rpc/identity/resolve-access-token");
  assert.equal(tag(server, "http.request.method"), "POST");
  assert.equal(tag(server, "rpc.method"), "resolve_access_token");
  assert.equal(tag(server, "http.response.status_code"), 200);
  end(server);
  const database = databaseChildrenTopology(trace, server);
  assert(
    ![server, ...database].some(hasError) && (cancelled || !hasError(client)),
    "failed actual Resolve RPC or SQL",
  );
  return { server, database };
}
function failureSource(selected, decision, profile, ttlMs, options) {
  const { trace, tree, client } = selected;
  assert(
    ttlMs > 0 && client.startTime + ttlMs * 1000 > decision.startTime,
    "shared source exceeds policy budget",
  );
  const root = tree.parent(client);
  if (root?.operationName === decisionName + ".refresh") {
    assert(
      tree.service(root) === "edge-gateway" &&
        tag(root, "span.kind") === "internal" &&
        !tree.parent(root),
      "refresh must own its root",
    );
    assert.equal(value(root, "profile"), profile, "wrong refresh profile");
    const outcome = value(root, "outcome");
    if (outcome === "unavailable") unavailable(root);
    else {
      assert.equal(outcome, "admitted", "unexpected refresh outcome");
      assert(
        !hasError(client) && tag(client, "http.response.status_code") === 200,
        "admitted refresh contradicts RPC failure",
      );
    }
    assert(
      root.startTime <= client.startTime && end(client) <= end(root),
      "RPC outside refresh root",
    );
    const trigger = linked(one(links(root), "refresh trigger"), options);
    const checked = inspectGatewayResolution(
      trigger.trace,
      {
        rootSpanID: trigger.tree.parent(trigger.client)?.spanID,
        decisionSpanID: trigger.client.spanID,
        profile,
        ttlMs,
      },
      options,
    );
    assert.equal(
      checked.source,
      "cache",
      "refresh trigger must be a cache hit",
    );
    assert(
      trigger.client.startTime <= root.startTime,
      "refresh predates trigger",
    );
    return "background-refresh";
  }
  requestRoot(tree, root);
  const origin = trace.spans
    .filter(
      (span) =>
        span.operationName === decisionName &&
        tree.parent(span) === root &&
        value(span, "source") === "rpc" &&
        span.startTime <= client.startTime,
    )
    .sort((a, b) => b.startTime - a.startTime)[0];
  assert(origin, "source CLIENT lacks original rpc decision");
  decisionUnder(tree, origin, root, profile);
  if (value(origin, "outcome") === "unavailable") unavailable(origin);
  else {
    assert.equal(
      value(origin, "outcome"),
      "admitted",
      "unexpected source decision outcome",
    );
    assert(
      !hasError(client) && tag(client, "http.response.status_code") === 200,
      "admitted source contradicts RPC failure",
    );
    assert(
      end(client) <= end(origin),
      "source admission predates RPC completion",
    );
  }
  // Retained work may end after the original caller's cancelled root.
  return "request";
}

export function inspectShutdownResolutions(
  trace,
  root,
  upstream,
  expected,
  options,
  inWindow,
) {
  const tree = traceTopology(trace),
    profile = expected.executionState ? "workspace" : "console",
    ttlMs = expected.resolveTTLMS ?? 10000;
  const decisions = trace.spans
    .filter((span) => span.operationName === decisionName)
    .sort((a, b) => a.startTime - b.startTime);
  for (const decision of decisions)
    decisionUnder(tree, decision, root, profile);
  const initial = one(
    decisions.filter((span) => span.startTime < upstream.startTime),
    "initial Resolve before forwarding",
  );
  const records = [],
    owners = new Map(),
    currentClients = new Set(),
    rpcCreators = new Set(),
    allowedErrors = new Set();
  const remember = (decision, selected, received) => {
    const { trace: source, client } = selected;
    if (value(decision, "source") === "rpc") {
      const key = `${source.traceID}:${client.spanID}`;
      assert(!rpcCreators.has(key), "multiple rpc decisions claim one CLIENT");
      rpcCreators.add(key);
    }
    if (source === trace) currentClients.add(client);
    if (received)
      owners.set(`${source.traceID}:${received.server.spanID}`, received);
  };
  for (const decision of decisions) {
    // marker.End precedes the resolver result and guard cancellation. It is
    // not a clock anchor for rejecting concurrent guard/frame checks.
    if (value(decision, "outcome") === "admitted") {
      const record = inspectGatewayResolution(
        trace,
        {
          rootSpanID: root.spanID,
          decisionSpanID: decision.spanID,
          profile,
          ttlMs,
          ...(decision === initial ? { upstreamSpanID: upstream.spanID } : {}),
        },
        options,
      );
      if (record.rpc_client_span_id) {
        const source =
          record.source_trace_id === trace.traceID
            ? trace
            : options.traces.get(record.source_trace_id);
        const sourceTree = traceTopology(source);
        const selected = {
          trace: source,
          tree: sourceTree,
          client: sourceTree.spans.get(record.rpc_client_span_id),
        };
        remember(decision, selected, receipt(selected));
      }
      records.push(record);
      continue;
    }
    assert(decision !== initial, "failed Resolve cannot admit a watch");
    unavailable(decision);
    assert(
      inWindow(decision),
      "Resolve cancellation outside observed stop window",
    );
    const source = value(decision, "source");
    let selected,
      received,
      sourceRoot = "request";
    if (source === "shared") {
      assert(ttlMs > 0, "shared cancellation with cache disabled");
      assert(
        ["caller-cancelled", "process-shutdown"].includes(
          value(decision, "cancel_kind"),
        ),
        "unproved shutdown cancellation kind",
      );
      const state = value(decision, "shared_source_state");
      if (state === "cancelled-before-client")
        assert.equal(
          links(decision).length,
          0,
          "pre-CLIENT snapshot invented a link",
        );
      else {
        assert.equal(
          state,
          "actual-client",
          "unknown shared cancellation state",
        );
        selected = linked(
          one(links(decision), "cancelled source link"),
          options,
        );
      }
    } else {
      assert.equal(source, "rpc", "invalid unavailable source");
      assert.equal(
        links(decision).length,
        0,
        "rpc cancellation invented shared link",
      );
      assert.equal(value(decision, "cancel_kind"), undefined);
      assert.equal(value(decision, "shared_source_state"), undefined);
      selected = {
        trace,
        tree,
        client: one(
          trace.spans.filter(
            (span) =>
              tree.parent(span) === root &&
              tree.service(span) === "edge-gateway" &&
              tag(span, "span.kind") === "client" &&
              span.operationName === "HTTP POST identity-service" &&
              span.startTime >= decision.startTime &&
              span.startTime <= end(decision),
          ),
          "cancelled Resolve actual CLIENT",
        ),
      };
    }
    if (selected) {
      clientShape(selected.tree, selected.client);
      assert(
        selected.client.startTime <= end(decision),
        "CLIENT created after cancellation snapshot",
      );
      const cancelled = cancelledTransport(selected.client);
      // rpc markers lack a cancellation reason. A successful receipt alone
      // cannot distinguish shutdown from other unavailable outcomes.
      if (source === "rpc")
        assert(cancelled, "rpc unavailable lacks actual cancellation evidence");
      if (source === "rpc" && ttlMs === 0)
        assert(
          end(selected.client) <= end(decision),
          "TTL zero Resolve must join its synchronous CLIENT",
        );
      if (source === "rpc" || (cancelled && selected.trace === trace))
        assert(
          inWindow(selected.client),
          "actual Resolve cancellation outside stop window",
        );
      received = receipt(selected, cancelled);
      if (source === "shared")
        sourceRoot = failureSource(selected, decision, profile, ttlMs, options);
      remember(decision, selected, received);
      if (selected.trace === trace && hasError(selected.client))
        allowedErrors.add(selected.client);
    }
    allowedErrors.add(decision);
    records.push({
      trace_id: trace.traceID,
      root_span_id: root.spanID,
      decision_span_id: decision.spanID,
      source,
      profile,
      outcome: "unavailable",
      admission: false,
      cancellation_verified: true,
      closure: expected.closure,
      database_spans: received?.database.length ?? 0,
      ...(selected
        ? {
            source_trace_id: selected.trace.traceID,
            rpc_client_span_id: selected.client.spanID,
            source_root: sourceRoot,
          }
        : {}),
      ...(received ? { identity_server_span_id: received.server.spanID } : {}),
    });
  }
  for (const span of trace.spans) {
    if (
      tree.service(span) === "identity-service" &&
      tag(span, "span.kind") === "server"
    )
      assert(
        owners.has(`${trace.traceID}:${span.spanID}`),
        "unbound Identity receiver",
      );
    if (
      tree.service(span) === "edge-gateway" &&
      ["client", "producer"].includes(tag(span, "span.kind"))
    )
      assert(
        span === upstream || currentClients.has(span),
        "unbound Gateway upstream or Resolve CLIENT",
      );
  }
  return {
    gateway_resolution: records[0],
    gateway_revalidations: records.slice(1),
    identity_checks: owners.size,
    identity_sql: [...owners.values()].reduce(
      (n, owner) => n + owner.database.length,
      0,
    ),
    allowedErrors,
  };
}
