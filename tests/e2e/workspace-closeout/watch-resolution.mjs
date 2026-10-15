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
      !tree.parent(root) &&
      ((typeof tag(root, "http.route") === "string" &&
        typeof tag(root, "http.request.method") === "string") ||
        (tag(root, "rpc.service") === "acp" &&
          tag(root, "antnest.operation.phase") === "relay" &&
          tag(root, "network.transport") === "websocket" &&
          typeof tag(root, "rpc.method") === "string")),
    "actual Resolve request root required",
  );
  end(root);
}
function decisionUnder(tree, decision, root) {
  requestRoot(tree, root);
  assert(
    tree.service(decision) === "edge-gateway" &&
      decision.operationName === decisionName &&
      tag(decision, "span.kind") === "internal" &&
      tree.parent(decision) === root,
    "Resolve decision has wrong watch ancestry",
  );
  assert.equal(
    value(decision, "profile"),
    "workspace",
    "wrong watch Resolve profile",
  );
  assert(
    decision.startTime >= root.startTime && end(decision) <= end(root),
    "Resolve decision outside watch request",
  );
}
function errorDecision(span, outcome) {
  assert(hasError(span), "failed Resolve decision error missing");
  assert.equal(
    tag(span, "otel.status_description"),
    outcome,
    "wrong Resolve failure description",
  );
  assert.equal(
    tag(span, "error.type"),
    undefined,
    "unrelated Resolve decision error",
  );
}
function linked(reference, options) {
  assert(reference?.traceID && reference.spanID, "exact Resolve link missing");
  const trace = options.traces?.get(reference.traceID);
  assert(trace?.traceID === reference.traceID, "Resolve source trace missing");
  assert(
    options.archivedTraceIDs?.has(reference.traceID),
    "Resolve source archive missing",
  );
  const tree = traceTopology(trace),
    span = tree.spans.get(reference.spanID);
  assert(span, "exact Resolve source span missing");
  return { trace, tree, span };
}
function clientShape(tree, client) {
  assert.equal(tree.service(client), "edge-gateway");
  assert.equal(tag(client, "span.kind"), "client");
  assert.equal(client.operationName, "HTTP POST identity-service");
  assert.equal(tag(client, "http.request.method"), "POST");
  end(client);
}
function receipt(trace, tree, client, status, cancelled = false) {
  clientShape(tree, client);
  assert(
    tag(client, "http.response.status_code") === status ||
      (cancelled && tag(client, "http.response.status_code") === undefined),
    "Resolve CLIENT and receiver status disagree",
  );
  const server = one(
    trace.spans.filter(
      (span) =>
        tree.parent(span) === client &&
        tree.service(span) === "identity-service" &&
        tag(span, "span.kind") === "server",
    ),
    "actual Resolve receiver",
  );
  assert.equal(tag(server, "http.route"), "/rpc/identity/resolve-access-token");
  assert.equal(tag(server, "http.request.method"), "POST");
  assert.equal(tag(server, "rpc.method"), "resolve_access_token");
  assert.equal(tag(server, "http.response.status_code"), status);
  end(server);
  const database = databaseChildrenTopology(trace, server);
  assert(!database.some(hasError), "failed Resolve SQL");
  if (status === 401) {
    assert(hasError(client) && hasError(server), "actual denial error missing");
    if (!cancelled) assert.equal(tag(client, "error.type"), "401");
    assert.equal(tag(server, "error.type"), "unauthenticated");
  } else {
    assert(
      (cancelled || !hasError(client)) && !hasError(server),
      "failed admitted Resolve RPC",
    );
  }
  return { server, database };
}

function sourceOrigin(selected, options, ttlMs, decision, rejected = true) {
  const { tree, span: client } = selected;
  assert(
    ttlMs > 0 && client.startTime + ttlMs * 1000 > decision.startTime,
    "shared Resolve source exceeds its policy budget",
  );
  const root = tree.parent(client);
  if (root?.operationName === decisionName + ".refresh") {
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tag(root, "span.kind"), "internal");
    assert.equal(tree.parent(root), undefined, "refresh must own its root");
    assert.equal(value(root, "profile"), "workspace");
    const outcome = value(root, "outcome");
    assert(
      ["admitted", "rejected", "unavailable"].includes(outcome),
      "unknown refresh outcome",
    );
    if (rejected)
      assert.equal(outcome, "rejected", "wrong rejected refresh outcome");
    if (outcome !== "admitted") errorDecision(root, outcome);
    else
      assert(
        !hasError(client) && tag(client, "http.response.status_code") === 200,
        "admitted refresh contradicts RPC failure",
      );
    assert(
      root.startTime <= client.startTime && end(client) <= end(root),
      "RPC outside refresh root",
    );
    const trigger = linked(one(links(root), "refresh trigger link"), options);
    const triggerRoot = trigger.tree.parent(trigger.span);
    const checked = inspectGatewayResolution(
      trigger.trace,
      {
        rootSpanID: triggerRoot?.spanID,
        decisionSpanID: trigger.span.spanID,
        profile: "workspace",
        ttlMs,
      },
      options,
    );
    assert.equal(
      checked.source,
      "cache",
      "refresh trigger was not a cache hit",
    );
    assert(
      trigger.span.startTime <= root.startTime,
      "refresh predates trigger",
    );
    return {
      kind: "background-refresh",
      outcome,
      gateways: [
        { trace: selected.trace, span: root },
        { trace: trigger.trace, span: trigger.span },
        { trace: trigger.trace, span: triggerRoot },
      ],
    };
  }
  requestRoot(tree, root);
  const origin = selected.trace.spans
    .filter(
      (span) =>
        span.operationName === decisionName &&
        tree.parent(span) === root &&
        value(span, "source") === "rpc" &&
        span.startTime <= client.startTime,
    )
    .sort((a, b) => b.startTime - a.startTime)[0];
  assert(origin, "source CLIENT lacks original rpc decision");
  decisionUnder(tree, origin, root);
  const outcome = value(origin, "outcome");
  assert(
    (rejected
      ? ["rejected", "unavailable"]
      : ["admitted", "rejected", "unavailable"]
    ).includes(outcome),
    "source outcome contradicts actual denial",
  );
  if (outcome !== "admitted") errorDecision(origin, outcome);
  else
    assert(
      !hasError(client) && tag(client, "http.response.status_code") === 200,
      "admitted source contradicts RPC failure",
    );
  if (outcome !== "unavailable")
    assert(end(client) <= end(origin), "source denial predates RPC completion");
  // The original caller may cancel before the retained work completes.
  return {
    kind: "request",
    outcome,
    gateways: [
      { trace: selected.trace, span: root },
      { trace: selected.trace, span: origin },
    ],
  };
}

function closureWitness(decision, expected, context) {
  const closure = expected.closure;
  assert(
    closure?.traceID === expected.traceID &&
      Number.isSafeInteger(closure.observedAt) &&
      closure.observedAt >= expected.stopWindow.start &&
      closure.observedAt <= expected.stopWindow.end,
    "independent watch closure witness missing or outside window",
  );
  const local = closure.kind === "local-close" && context.localCancelled;
  const access =
    closure.kind === "access-denied" &&
    expected.revoked === true &&
    expected.states?.some((state) => state.access_allowed === false) &&
    (context.localCancelled || context.feedCancelled);
  const feed =
    closure.kind === "transport-end" &&
    expected.revoked === true &&
    context.feedCancelled;
  assert(
    local || access || feed,
    "watch closure does not prove pending caller cancellation",
  );
  // The probe and Gateway clocks have an observed interval, not an invented
  // exact common timestamp. Require that interval to overlap the pending check.
  assert(
    (closure.observedAt + context.clockOffset.min) * 1000 <= end(decision) &&
      (closure.observedAt + context.clockOffset.max) * 1000 >=
        decision.startTime,
    "watch closure does not overlap pending Resolve",
  );
}

function cancelledTransport(client, expected, context) {
  if (!hasError(client) || tag(client, "error.type") === "401") return false;
  const cancelled =
    tag(client, "error.type") === "cancelled" &&
    tag(client, "otel.status_description") === "Request was cancelled";
  const feedCause =
    expected.resolveTTLMS === 0 &&
    expected.revoked === true &&
    context.feedCancelled &&
    tag(client, "error.type") === "operation_failed" &&
    tag(client, "otel.status_description") ===
      "Operation failed; unclassified error text was not exported";
  assert(cancelled || feedCause, "unrelated pending Resolve transport failure");
  assert(
    client.logs?.some(
      (event) =>
        event.fields?.some(
          (field) => field.key === "event" && field.value === "antnest.error",
        ) &&
        event.fields?.some(
          (field) =>
            field.key === "antnest.error.stage" &&
            ["send", "read_response", "close_response"].includes(field.value),
        ),
    ),
    "Resolve cancellation stage missing",
  );
  assert(
    [undefined, 200, 401].includes(tag(client, "http.response.status_code")),
    "unrelated pending Resolve status",
  );
  return true;
}

// Locate a real non-admitting workspace RPC without turning a waiter or
// pre-CLIENT cancellation into a dependency failure. A shared deadline still
// requires a completed actual deadline CLIENT. Owning callers must still
// validate its exact error/SQL receipt and independent fault window.
export function inspectWorkspaceFailureSource(trace, root, decision, options) {
  const tree = traceTopology(trace);
  decisionUnder(tree, decision, root);
  const outcome = value(decision, "outcome");
  assert(["rejected", "unavailable"].includes(outcome));
  errorDecision(decision, outcome);
  const cancelKind = value(decision, "cancel_kind");
  assert(
    cancelKind === undefined ||
      (cancelKind === "shared-deadline" && outcome === "unavailable"),
    "cancelled waiter cannot prove Identity failure",
  );
  const source = value(decision, "source");
  let selected,
    origin = { kind: "request", outcome, gateways: [] };
  if (source === "rpc") {
    assert.equal(cancelKind, undefined, "RPC creator has shared cancellation");
    assert.equal(links(decision).length, 0);
    assert.equal(value(decision, "shared_source_state"), undefined);
    selected = {
      trace,
      tree,
      span: one(
        trace.spans.filter(
          (span) =>
            tree.parent(span) === root &&
            tree.service(span) === "edge-gateway" &&
            tag(span, "span.kind") === "client" &&
            span.operationName === "HTTP POST identity-service" &&
            span.startTime >= decision.startTime &&
            end(span) <= end(decision),
        ),
        "actual failed workspace CLIENT",
      ),
    };
  } else {
    assert.equal(source, "shared");
    assert.equal(value(decision, "shared_source_state"), "actual-client");
    selected = linked(
      one(links(decision), "actual failed workspace source link"),
      options,
    );
    origin = sourceOrigin(
      selected,
      options,
      10000,
      decision,
      outcome === "rejected",
    );
    // A refresh records the retained flight's result directly. A request
    // owner may instead have cancelled before an actual 401 completed, but
    // an unavailable RPC cannot produce a rejected owner decision.
    if (origin.kind === "background-refresh" || outcome === "unavailable")
      assert.equal(origin.outcome, outcome, "contradictory source outcome");
  }
  clientShape(selected.tree, selected.span);
  if (cancelKind === "shared-deadline") {
    assert(
      hasError(selected.span),
      "shared deadline lacks failed actual CLIENT",
    );
    assert.equal(tag(selected.span, "error.type"), "deadline_exceeded");
    assert.equal(
      tag(selected.span, "otel.status_description"),
      "Request deadline exceeded",
    );
  }
  assert.equal(tag(selected.span, "server.address"), "identity-service");
  assert(
    end(selected.span) <= end(decision),
    "failed decision precedes its actual source completion",
  );
  const process = (raw, span) => {
    const metadata = raw.processes[span.processID];
    const tags = Object.fromEntries(
      (metadata.tags ?? []).map((t) => [t.key, t.value]),
    );
    assert.equal(
      Object.keys(tags).length,
      (metadata.tags ?? []).length,
      "duplicate Gateway resource field",
    );
    for (const key of ["host.name", "service.instance.id"])
      assert(typeof tags[key] === "string" && tags[key]);
    assert(
      Number.isSafeInteger(tags["process.pid"]) && tags["process.pid"] > 0,
    );
    return [
      metadata.serviceName,
      tags["host.name"],
      tags["process.pid"],
      tags["service.instance.id"],
    ];
  };
  for (const gateway of [
    { trace, span: decision },
    { trace: selected.trace, span: selected.span },
    ...origin.gateways,
  ]) {
    if (gateway.trace === trace)
      assert.equal(
        gateway.span.processID,
        root.processID,
        "failure ancestry belongs to another Gateway process",
      );
    else
      assert.deepEqual(
        process(gateway.trace, gateway.span),
        process(trace, root),
        "failure ancestry belongs to another Gateway process",
      );
  }
  return {
    ...selected,
    record: {
      trace_id: trace.traceID,
      root_span_id: root.spanID,
      decision_span_id: decision.spanID,
      profile: "workspace",
      source,
      outcome,
      ...(cancelKind === undefined ? {} : { cancel_kind: cancelKind }),
      admission: false,
      source_trace_id: selected.trace.traceID,
      rpc_client_span_id: selected.span.spanID,
      source_root: origin.kind,
    },
  };
}

// Watch owns rejection/closure evidence. The shared admission oracle remains
// unable to turn a rejected or unavailable decision into authorization.
export function inspectWatchResolutions(
  trace,
  root,
  upstream,
  expected,
  options,
  inWindow,
  closureContext = {},
) {
  const tree = traceTopology(trace),
    ttlMs = expected.resolveTTLMS ?? 10000;
  const decisions = trace.spans
    .filter((span) => span.operationName === decisionName)
    .sort((a, b) => a.startTime - b.startTime);
  for (const decision of decisions) decisionUnder(tree, decision, root);
  const initial = one(
    decisions.filter((span) => span.startTime < upstream.startTime),
    "initial Resolve before watch upstream",
  );
  const records = [],
    owners = new Map(),
    allowedErrors = new Set(),
    currentClients = new Set(),
    rpcCreators = new Set();
  const claimRpcClient = (decision, sourceTrace, client) => {
    if (value(decision, "source") !== "rpc") return;
    const key = `${sourceTrace.traceID}:${client.spanID}`;
    assert(!rpcCreators.has(key), "multiple rpc decisions claim one CLIENT");
    rpcCreators.add(key);
  };
  let rejected = false,
    terminal = false;
  for (const decision of decisions) {
    assert(!terminal, "Resolve continued after failed watch revalidation");
    const outcome = value(decision, "outcome");
    if (outcome === "admitted") {
      const record = inspectGatewayResolution(
        trace,
        {
          rootSpanID: root.spanID,
          decisionSpanID: decision.spanID,
          profile: "workspace",
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
        const sourceTree = traceTopology(source),
          client = sourceTree.spans.get(record.rpc_client_span_id);
        claimRpcClient(decision, source, client);
        const { server, database } = receipt(source, sourceTree, client, 200);
        owners.set(`${source.traceID}:${server.spanID}`, {
          trace: source,
          server,
          database,
        });
        if (source === trace) currentClients.add(client);
      }
      records.push(record);
      continue;
    }
    assert(decision !== initial, "failed Resolve cannot admit the watch");
    if (outcome === "unavailable") {
      assert(inWindow(decision), "Resolve cancellation outside close window");
      errorDecision(decision, "unavailable");
      closureWitness(decision, expected, closureContext);
      const source = value(decision, "source");
      let selected,
        sourceRoot = "request",
        received;
      if (source === "shared") {
        assert.equal(
          value(decision, "cancel_kind"),
          "caller-cancelled",
          "unproved Resolve cancellation kind",
        );
        const state = value(decision, "shared_source_state");
        if (state === "cancelled-before-client")
          assert.equal(
            links(decision).length,
            0,
            "pre-CLIENT cancellation invented a source link",
          );
        else {
          assert.equal(state, "actual-client");
          selected = linked(
            one(links(decision), "cancelled Resolve source link"),
            options,
          );
        }
      } else {
        assert.equal(source, "rpc", "invalid cancelled Resolve source");
        assert.equal(
          links(decision).length,
          0,
          "rpc cancellation invented shared provenance",
        );
        // Without an actual CLIENT the rpc marker cannot distinguish caller
        // cancellation from capacity or other preflight unavailability.
        selected = {
          trace,
          tree,
          span: one(
            trace.spans.filter(
              (span) =>
                tree.service(span) === "edge-gateway" &&
                tree.parent(span) === root &&
                tag(span, "span.kind") === "client" &&
                span.operationName === "HTTP POST identity-service" &&
                span.startTime >= decision.startTime,
            ),
            "cancelled Resolve actual CLIENT",
          ),
        };
      }
      for (const span of trace.spans)
        assert(
          !(
            tree.service(span) === "edge-gateway" &&
            tree.chain(span).includes(root) &&
            ["client", "producer"].includes(tag(span, "span.kind")) &&
            span.startTime >= decision.startTime &&
            span !== selected?.span
          ),
          "cancelled Resolve has subsequent upstream admission",
        );
      if (selected) {
        const { trace: sourceTrace, tree: sourceTree, span: client } = selected;
        claimRpcClient(decision, sourceTrace, client);
        clientShape(sourceTree, client);
        if (source === "shared")
          assert(
            client.startTime <= end(decision),
            "shared CLIENT created after cancellation snapshot",
          );
        const cancelled = cancelledTransport(client, expected, closureContext);
        const receivers = sourceTrace.spans.filter(
          (span) =>
            sourceTree.parent(span) === client &&
            sourceTree.service(span) === "identity-service" &&
            tag(span, "span.kind") === "server",
        );
        if (
          receivers.length ||
          !cancelled ||
          tag(client, "http.response.status_code") !== undefined
        ) {
          const status = tag(
            one(receivers, "cancelled Resolve receiver"),
            "http.response.status_code",
          );
          assert(
            [200, 401].includes(status),
            "unrelated cancelled Resolve receiver failure",
          );
          if (status === 401)
            assert.equal(
              expected.revoked,
              true,
              "undeclared cancelled-source rejection",
            );
          received = receipt(
            sourceTrace,
            sourceTree,
            client,
            status,
            cancelled,
          );
          owners.set(`${sourceTrace.traceID}:${received.server.spanID}`, {
            trace: sourceTrace,
            ...received,
          });
        }
        if (source === "shared")
          sourceRoot = sourceOrigin(
            selected,
            options,
            ttlMs,
            decision,
            false,
          ).kind;
        if (sourceTrace === trace) {
          currentClients.add(client);
          if (hasError(client)) allowedErrors.add(client);
          if (received && hasError(received.server))
            allowedErrors.add(received.server);
        }
      }
      allowedErrors.add(decision);
      terminal = true;
      records.push({
        trace_id: trace.traceID,
        decision_span_id: decision.spanID,
        root_span_id: root.spanID,
        source,
        profile: "workspace",
        outcome,
        admission: false,
        cancellation_verified: true,
        closure: expected.closure,
        database_spans: received?.database.length ?? 0,
        ...(selected
          ? {
              source_trace_id: selected.trace.traceID,
              rpc_client_span_id: selected.span.spanID,
              source_root: sourceRoot,
            }
          : {}),
        ...(received
          ? { identity_server_span_id: received.server.spanID }
          : {}),
      });
      continue;
    }
    assert.equal(
      outcome,
      "rejected",
      "unavailable watch Resolve needs independent cancellation evidence",
    );
    assert.equal(expected.revoked, true, "undeclared watch revocation");
    assert(inWindow(decision), "Resolve denial outside revocation window");
    errorDecision(decision, "rejected");
    const source = value(decision, "source");
    let selected,
      sourceRoot = "request";
    if (source === "rpc") {
      assert.equal(
        links(decision).length,
        0,
        "rpc decision invented a shared link",
      );
      const client = one(
        trace.spans.filter(
          (span) =>
            tree.parent(span) === root &&
            tree.service(span) === "edge-gateway" &&
            tag(span, "span.kind") === "client" &&
            span.operationName === "HTTP POST identity-service" &&
            span.startTime >= decision.startTime &&
            end(span) <= end(decision),
        ),
        "rejected Resolve CLIENT",
      );
      selected = { trace, tree, span: client };
    } else {
      assert.equal(source, "shared", "invalid rejected Resolve source");
      assert.equal(value(decision, "shared_source_state"), "actual-client");
      assert.equal(
        value(decision, "cancel_kind"),
        undefined,
        "cancelled waiter cannot prove rejection",
      );
      selected = linked(one(links(decision), "shared rejection link"), options);
      sourceRoot = sourceOrigin(selected, options, ttlMs, decision).kind;
    }
    const { trace: sourceTrace, tree: sourceTree, span: client } = selected;
    claimRpcClient(decision, sourceTrace, client);
    const { server, database } = receipt(sourceTrace, sourceTree, client, 401);
    assert(
      end(client) <= end(decision),
      "denial predates actual RPC completion",
    );
    assert(
      inWindow(client) && inWindow(server),
      "denial outside revocation window",
    );
    owners.set(`${sourceTrace.traceID}:${server.spanID}`, {
      trace: sourceTrace,
      server,
      database,
    });
    if (sourceTrace === trace) {
      currentClients.add(client);
      allowedErrors.add(client);
      allowedErrors.add(server);
    }
    allowedErrors.add(decision);
    rejected = true;
    terminal = true;
    records.push({
      trace_id: trace.traceID,
      decision_span_id: decision.spanID,
      root_span_id: root.spanID,
      source,
      profile: "workspace",
      outcome,
      admission: false,
      database_spans: database.length,
      source_trace_id: sourceTrace.traceID,
      rpc_client_span_id: client.spanID,
      identity_server_span_id: server.spanID,
      source_root: sourceRoot,
    });
  }
  for (const span of trace.spans) {
    if (
      tree.service(span) === "identity-service" &&
      tag(span, "span.kind") === "server"
    )
      assert(
        owners.has(`${trace.traceID}:${span.spanID}`),
        "unbound Identity revalidation receiver",
      );
    if (
      tree.service(span) === "edge-gateway" &&
      tag(span, "span.kind") === "client" &&
      span.operationName === "HTTP POST identity-service"
    )
      assert(currentClients.has(span), "unbound Identity revalidation CLIENT");
  }
  return {
    gateway_resolution: records[0],
    gateway_revalidations: records.slice(1),
    identity_checks: owners.size,
    identity_sql: [...owners.values()].reduce(
      (count, owner) => count + owner.database.length,
      0,
    ),
    revocation_verified: rejected,
    allowedErrors,
  };
}
