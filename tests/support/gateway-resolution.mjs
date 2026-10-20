import assert from "node:assert/strict";
import {
  assertCaptureDisabled,
  databaseChildrenTopology,
  tag,
  traceTopology,
} from "../e2e/observability/trace-tree.mjs";

const prefix = "antnest.identity.resolve.";
const decisionName = "gateway.identity.resolve";
const refreshName = decisionName + ".refresh";
const profiles = new Set(["console", "workspace", "acp", "session"]);
const outcomes = new Set(["admitted", "rejected", "unavailable"]);
const attributes = new Set([
  "source",
  "profile",
  "outcome",
  "snapshot_age_ms",
  "proof_age_ms",
  "valid_for_ms",
  "shared_source_state",
  "cancel_kind",
]);
const cancelKinds = new Set([
  "caller-cancelled",
  "caller-deadline",
  "shared-cancelled",
  "shared-deadline",
  "process-shutdown",
]);
const value = (span, key) => tag(span, prefix + key);
const links = (span) =>
  (span.references ?? []).filter((r) => r.refType === "FOLLOWS_FROM");

function end(span) {
  assert(
    Number.isFinite(span?.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
    "unfinished Resolve span timing",
  );
  return span.startTime + span.duration;
}

export function assertGatewayResolutionAttributes(trace) {
  for (const span of trace.spans)
    for (const field of span.tags ?? [])
      if (field.key.startsWith(prefix))
        assert(
          attributes.has(field.key.slice(prefix.length)),
          "unknown Resolve diagnostic attribute",
        );
}

function treeFor(trace, options = {}) {
  const tree = traceTopology(trace);
  if (options.captureRpcContent !== true) assertCaptureDisabled(trace);
  // This is a topology oracle. Callers retain raw warnings/error classification
  // and their strict trace gate; no warning or missing parent is removed here.
  assertGatewayResolutionAttributes(trace);
  return tree;
}

function requestRoot(tree, root) {
  assert(
    root &&
      tree.service(root) === "edge-gateway" &&
      tag(root, "span.kind") === "server" &&
      tree.parent(root) === undefined,
    "actual Gateway request root required",
  );
  const http =
    typeof tag(root, "http.route") === "string" &&
    typeof tag(root, "http.request.method") === "string";
  const acp =
    tag(root, "rpc.service") === "acp" &&
    tag(root, "antnest.operation.phase") === "relay" &&
    tag(root, "network.transport") === "websocket" &&
    typeof tag(root, "rpc.method") === "string";
  assert(http || acp, "actual HTTP or ACP request root required");
  end(root);
}

function decisionUnder(tree, decision, root, profile) {
  assert(
    decision?.operationName === decisionName &&
      tree.service(decision) === "edge-gateway" &&
      tag(decision, "span.kind") === "internal",
    "Resolve decision missing",
  );
  requestRoot(tree, root);
  assert.equal(
    tree.parent(decision),
    root,
    "Resolve decision has wrong request root",
  );
  assert(
    profiles.has(profile) && value(decision, "profile") === profile,
    "wrong Resolve profile",
  );
  assert(outcomes.has(value(decision, "outcome")), "unknown Resolve outcome");
  assert(
    decision.startTime >= root.startTime && end(decision) <= end(root),
    "Resolve decision outside its actual request root",
  );
}

function cacheBudget(decision, ttlMs) {
  const age = value(decision, "snapshot_age_ms"),
    proof = value(decision, "proof_age_ms"),
    remaining = value(decision, "valid_for_ms");
  assert(
    ttlMs > 0 &&
      [age, proof, remaining].every(Number.isFinite) &&
      age >= 0 &&
      age < ttlMs &&
      proof >= 0 &&
      proof < ttlMs &&
      remaining > 0 &&
      // These attributes are double milliseconds, not quantized span times.
      // Cover floating point addition only, including sub-microsecond TTLs.
      age + remaining <=
        ttlMs + Number.EPSILON * Math.max(ttlMs, age, remaining) * 4,
    "invalid or expired Resolve cache budget",
  );
}

function oneLink(span) {
  const refs = links(span);
  assert.equal(refs.length, 1, "one exact Resolve source link required");
  assert(refs[0].traceID && refs[0].spanID, "incomplete Resolve source link");
  return refs[0];
}

function linkedTarget(reference, options) {
  const trace = options.traces?.get(reference.traceID);
  assert(trace?.traceID === reference.traceID, "Resolve source trace missing");
  assert(
    options.archivedTraceIDs?.has(reference.traceID),
    "Resolve source trace must be archived",
  );
  const tree = treeFor(trace, options),
    span = tree.spans.get(reference.spanID);
  assert(span, "exact linked Resolve span missing");
  return { trace, tree, span };
}

function successfulRPC(trace, tree, client) {
  assert(
    client &&
      tree.service(client) === "edge-gateway" &&
      tag(client, "span.kind") === "client",
    "linked Resolve must be an actual Gateway CLIENT",
  );
  assert.equal(
    tag(client, "http.request.method"),
    "POST",
    "wrong Resolve CLIENT method",
  );
  assert.equal(
    tag(client, "http.response.status_code"),
    200,
    "Resolve CLIENT did not succeed",
  );
  const receivers = trace.spans.filter(
    (span) =>
      tree.parent(span) === client &&
      tree.service(span) === "identity-service" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.route") === "/rpc/identity/resolve-access-token",
  );
  assert.equal(
    receivers.length,
    1,
    "one exact Resolve receiving SERVER required",
  );
  const server = receivers[0];
  assert.equal(
    tag(server, "http.request.method"),
    "POST",
    "wrong Resolve SERVER method",
  );
  assert.equal(
    tag(server, "rpc.method"),
    "resolve_access_token",
    "wrong Resolve RPC method",
  );
  assert.equal(
    tag(server, "http.response.status_code"),
    200,
    "Resolve SERVER did not succeed",
  );
  end(client);
  end(server);
  // Use the exact receiving span, not the first matching route in a connection
  // trace containing multiple real Resolve calls.
  return { server, database: databaseChildrenTopology(trace, server) };
}

function sourceOrigin(trace, tree, client, profile, ttlMs, options) {
  const root = tree.parent(client);
  if (root?.operationName === refreshName) {
    assert(
      tree.service(root) === "edge-gateway" &&
        tag(root, "span.kind") === "internal" &&
        tree.parent(root) === undefined,
      "refresh must have a process-owned root",
    );
    assert.equal(
      value(root, "profile"),
      profile,
      "wrong background Resolve profile",
    );
    assert.equal(
      value(root, "outcome"),
      "admitted",
      "background source did not succeed",
    );
    assert(
      root.startTime <= client.startTime && end(client) <= end(root),
      "RPC outside background root",
    );
    const trigger = linkedTarget(oneLink(root), options);
    decisionUnder(
      trigger.tree,
      trigger.span,
      trigger.tree.parent(trigger.span),
      profile,
    );
    assert.equal(
      value(trigger.span, "source"),
      "cache",
      "refresh trigger must be an actual cache-hit decision",
    );
    assert.equal(
      value(trigger.span, "outcome"),
      "admitted",
      "refresh trigger was not admitted",
    );
    cacheBudget(trigger.span, ttlMs);
    // Refresh may start before its triggering decision's deferred End executes.
    assert(
      trigger.span.startTime <= root.startTime,
      "refresh predates its triggering decision",
    );
    return "background-refresh";
  }
  requestRoot(tree, root);
  const origins = trace.spans
    .filter(
      (span) =>
        span.operationName === decisionName &&
        tree.parent(span) === root &&
        value(span, "source") === "rpc" &&
        span.startTime <= client.startTime,
    )
    .sort((a, b) => b.startTime - a.startTime);
  assert(origins.length > 0, "source CLIENT lacks its original rpc decision");
  decisionUnder(tree, origins[0], root, profile);
  assert(
    value(origins[0], "outcome") !== "rejected",
    "source RPC outcome contradicts admitted shared result",
  );
  // Shared work retains its original trace parent even if that caller has
  // cancelled before CLIENT creation/completion. The waiter's own completion
  // and exact link below prove admission; source-root duration is not renewed.
  return "request";
}

function cancelledBeforeClient(trace, tree, decision, root, expected, options) {
  const kind = value(decision, "cancel_kind"),
    evidence = options.cancellation;
  assert.equal(
    value(decision, "outcome"),
    "unavailable",
    "cancelled source cannot provide an admission outcome",
  );
  assert.equal(
    expected.outcome,
    "unavailable",
    "cancelled source is not authorization evidence",
  );
  assert.equal(
    expected.upstreamSpanID,
    undefined,
    "cancelled source cannot admit upstream work",
  );
  assert.equal(
    links(decision).length,
    0,
    "cancelled-before-client cannot carry an actual-client link",
  );
  assert(
    cancelKinds.has(kind) &&
      evidence?.kind === kind &&
      evidence.traceID === trace.traceID &&
      evidence.decisionSpanID === decision.spanID &&
      Number.isFinite(evidence.observedAt) &&
      evidence.observedAt >= decision.startTime &&
      evidence.observedAt <= end(decision),
    "independent cancellation evidence missing or inconsistent",
  );
  assert(
    !trace.spans.some(
      (span) =>
        tree.chain(span).includes(root) &&
        ["client", "producer"].includes(tag(span, "span.kind")) &&
        span.startTime >= decision.startTime,
    ),
    "cancelled source has subsequent upstream admission",
  );
}

// Consumers supply the actual observed request root and, where applicable,
// actual upstream CLIENT/PRODUCER. Only this Resolve expectation can replace
// Resolve SQL; callers retain all other owning-service SQL and error gates.
export function inspectGatewayResolution(trace, expected, options = {}) {
  const tree = treeFor(trace, options),
    root = tree.spans.get(expected.rootSpanID),
    decision = tree.spans.get(expected.decisionSpanID);
  const ttlMs = expected.ttlMs ?? 10000;
  assert(
    Number.isFinite(ttlMs) && ttlMs >= 0 && ttlMs <= 30000,
    "invalid Resolve policy budget",
  );
  decisionUnder(tree, decision, root, expected.profile);
  const source = value(decision, "source"),
    outcome = value(decision, "outcome");
  assert(["rpc", "cache", "shared"].includes(source), "unknown Resolve source");
  assert.equal(
    outcome,
    expected.outcome ?? "admitted",
    "unexpected Resolve outcome",
  );
  const result = {
    trace_id: trace.traceID,
    decision_span_id: decision.spanID,
    root_span_id: root.spanID,
    source,
    profile: expected.profile,
    outcome,
    admission: outcome === "admitted",
    database_spans: 0,
  };
  if (
    source === "shared" &&
    value(decision, "shared_source_state") === "cancelled-before-client"
  ) {
    cancelledBeforeClient(trace, tree, decision, root, expected, options);
    return result;
  }
  assert.equal(
    outcome,
    "admitted",
    "non-admission Resolve needs its separate failure evidence",
  );
  assert.equal(
    value(decision, "cancel_kind"),
    undefined,
    "cancellation cannot provide successful admission",
  );
  if (expected.upstreamSpanID !== undefined) {
    const upstream = tree.spans.get(expected.upstreamSpanID);
    assert(
      upstream &&
        tree.service(upstream) === "edge-gateway" &&
        tree.parent(upstream) === root &&
        ["client", "producer"].includes(tag(upstream, "span.kind")),
      "actual upstream admission span required",
    );
    assert(
      end(decision) <= upstream.startTime,
      "Resolve decision ends after upstream admission",
    );
  }
  if (source === "cache") {
    assert.equal(
      links(decision).length,
      0,
      "cache hit cannot invent an RPC source link",
    );
    cacheBudget(decision, ttlMs);
    return result;
  }
  let selected,
    sourceRoot = "request";
  if (source === "rpc") {
    const clients = trace.spans.filter(
      (span) =>
        tree.service(span) === "edge-gateway" &&
        tag(span, "span.kind") === "client" &&
        tree.parent(span) === root &&
        span.startTime >= decision.startTime &&
        end(span) <= end(decision) &&
        trace.spans.some(
          (receiver) =>
            tree.parent(receiver) === span &&
            tree.service(receiver) === "identity-service" &&
            tag(receiver, "http.route") ===
              "/rpc/identity/resolve-access-token",
        ),
    );
    assert.equal(
      clients.length,
      1,
      "one actual Resolve CLIENT required for rpc decision",
    );
    selected = { trace, tree, span: clients[0] };
  } else {
    assert.equal(
      value(decision, "shared_source_state"),
      "actual-client",
      "shared source state missing",
    );
    selected = linkedTarget(oneLink(decision), options);
  }
  const { server, database } = successfulRPC(
    selected.trace,
    selected.tree,
    selected.span,
  );
  assert(
    end(selected.span) <= end(decision),
    "shared RPC completion followed waiter admission",
  );
  if (source === "shared")
    assert(
      ttlMs > 0 && selected.span.startTime + ttlMs * 1000 > decision.startTime,
      "shared Resolve source exceeds its policy budget",
    );
  if (source === "shared")
    sourceRoot = sourceOrigin(
      selected.trace,
      selected.tree,
      selected.span,
      expected.profile,
      ttlMs,
      options,
    );
  return {
    ...result,
    database_spans: database.length,
    source_trace_id: selected.trace.traceID,
    rpc_client_span_id: selected.span.spanID,
    identity_server_span_id: server.spanID,
    source_root: sourceRoot,
  };
}
