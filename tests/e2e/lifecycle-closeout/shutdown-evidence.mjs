import assert from "node:assert/strict";
import {
  tag,
  traceTopology,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

function sameContainers(project, before, after) {
  assert(before.length > 0, "empty shutdown inventory");
  assert.deepEqual(
    after.map((r) => r.name).sort(),
    before.map((r) => r.name).sort(),
    "container inventory changed",
  );
  assert.equal(new Set(before.map((r) => r.name)).size, before.length);
  return before.map((prior) => {
    const next = after.find((r) => r.name === prior.name);
    assert(
      prior.project === project && next.project === project,
      "foreign shutdown scope",
    );
    assert(
      prior.running && prior.id === next.id && prior.image === next.image,
      "container identity changed",
    );
    assert(
      !next.oom && next.error === "",
      `${prior.name}: daemon or OOM failure`,
    );
    return [prior, next];
  });
}
export function assertStopped(project, before, after) {
  return sameContainers(project, before, after).map(([prior, next]) => {
    assert(
      !next.running && next.exit === 0,
      `${prior.name}: not cleanly stopped`,
    );
    assert(
      next.started === prior.started &&
        Date.parse(next.finished) > Date.parse(prior.started),
      "stale shutdown evidence",
    );
    return { service: next.name, exit: next.exit };
  });
}
export function assertRestarted(project, before, after) {
  return sameContainers(project, before, after).map(([prior, next]) => {
    assert(
      next.running &&
        next.health === "healthy" &&
        Date.parse(next.started) > Date.parse(prior.started),
      "service did not restart",
    );
    return { service: next.name, same_container: true };
  });
}
export function inspectShutdownTrace(trace, expected, secrets) {
  assertSecretFree(JSON.stringify(trace) ?? "", secrets);
  assert(
    trace?.traceID === expected.traceID && trace.spans.length > 0,
    "shutdown trace missing",
  );
  assert(
    trace.spans.every((s) => s.traceID === trace.traceID),
    "foreign shutdown span",
  );
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  const spans = tree.spans;
  assert.equal(spans.size, trace.spans.length, "duplicate shutdown span");
  const service = (s) => trace.processes[s.processID]?.serviceName;
  const servers = (name) =>
    trace.spans.filter(
      (s) => service(s) === name && tag(s, "span.kind") === "server",
    );
  const roots = servers("edge-gateway").filter(
    (s) =>
      tag(s, "http.route") === expected.route &&
      tag(s, "http.request.method") === "GET",
  );
  assert.equal(roots.length, 1, "exact Gateway watch server required");
  const root = roots[0];
  const window = expected.stopWindow;
  const finished = (root.startTime + root.duration) / 1000;
  assert(
    Number.isFinite(window?.start) &&
      Number.isFinite(window?.end) &&
      window.end >= window.start &&
      finished >= window.start &&
      finished <= window.end,
    "Gateway watch did not finish in the observed stop window",
  );
  const cancelled =
    hasError(root) &&
    tag(root, "otel.status_description") === "handler_aborted" &&
    tag(root, "antnest.http.request_cancelled") === true;
  function chain(span) {
    const result = [],
      seen = new Set();
    while (span) {
      assert(!seen.has(span.spanID), "cyclic shutdown trace");
      seen.add(span.spanID);
      result.push(span);
      if (span === root) return result;
      const parents =
        span.references?.filter((r) => r.refType === "CHILD_OF") ?? [];
      assert(
        parents.length === 1 && parents[0].traceID === trace.traceID,
        "detached shutdown dependency",
      );
      span = spans.get(parents[0].spanID);
    }
    throw new Error("detached shutdown dependency");
  }
  const identities = servers("identity-service");
  assert(identities.length > 0, "Identity access check missing");
  if (expected.executionState)
    assert(
      !trace.spans.some(
        (s) =>
          service(s) === "agent-controller" || service(s) === "admin-console",
      ),
      "execution watch calls management service",
    );
  const controllers = servers(
    expected.executionState ? "agent-acp-service" : "agent-controller",
  ).filter(
    (s) =>
      tag(s, "http.route") ===
      (expected.executionState
        ? "/rpc/agent-acp/watch-agent-execution-state"
        : expected.controllerRoute),
  );
  if (expected.executionState)
    for (const span of controllers) {
      assert.equal(tag(span, "http.request.method"), "POST");
      assert.equal(tag(span, "rpc.method"), "watch_agent_execution_state");
    }
  assert.equal(controllers.length, 1, "exact Controller watch server required");
  const selected = new Set([root, ...identities]);
  for (const span of controllers) {
    const parents = chain(span);
    if (expected.console) {
      const consoleSpan = parents.find(
        (s) =>
          service(s) === "admin-console" && tag(s, "span.kind") === "server",
      );
      assert(consoleSpan, "Controller watch bypasses Console");
      selected.add(consoleSpan);
    }
    selected.add(span);
  }
  const inWindow = (span) => {
    const ended = (span.startTime + span.duration) / 1000;
    return span.duration > 0 && ended >= window.start && ended <= window.end;
  };
  const cancellation = (span) => {
    if (!inWindow(span) || tag(span, "http.response.status_code") !== 200)
      return false;
    let classification;
    if (span === root && cancelled) classification = "handler_aborted";
    const parent = tree.parent(span);
    if (
      service(span) === "edge-gateway" &&
      tag(span, "span.kind") === "client" &&
      parent === root &&
      tag(span, "error.type") === "cancelled" &&
      span.operationName ===
        (expected.executionState
          ? "HTTP POST agent-acp-workspace"
          : "HTTP GET admin-console") &&
      tag(span, "http.request.method") ===
        (expected.executionState ? "POST" : "GET")
    )
      classification = "cancelled";
    if (
      expected.executionState &&
      controllers.includes(span) &&
      tag(span, "error.type") === "stream_interrupted"
    )
      classification = "stream_interrupted";
    if (expected.console) {
      const consoleServer = (candidate) =>
        service(candidate) === "admin-console" &&
        tag(candidate, "span.kind") === "server" &&
        tag(candidate, "http.route") ===
          "/api/admin/agents/{agent_id}/events/watch" &&
        tag(candidate, "http.request.method") === "GET" &&
        selected.has(candidate);
      if (consoleServer(span) && tag(span, "error.type") === "cancelled")
        classification = "cancelled";
      if (
        service(span) === "admin-console" &&
        tag(span, "span.kind") === "client" &&
        consoleServer(parent) &&
        span.operationName === "HTTP GET agent-controller" &&
        tag(span, "http.request.method") === "GET" &&
        tag(span, "error.type") === "cancelled" &&
        controllers.some((controller) => tree.parent(controller) === span)
      )
        classification = "cancelled";
      if (
        controllers.includes(span) &&
        tag(span, "http.request.method") === "GET" &&
        tag(span, "error.type") === "canceled" &&
        tag(span, "otel.status_description") === "request_failed"
      )
        classification = "canceled";
    }
    if (!classification) return false;
    for (const event of span.logs ?? []) {
      if (
        !event.fields?.some(
          (f) => f.key === "event" && f.value === "antnest.error",
        )
      )
        continue;
      for (const field of event.fields)
        if (
          ["error.type", "antnest.error.code"].includes(field.key) &&
          field.value !== classification
        )
          return false;
    }
    return true;
  };
  for (const span of selected) {
    chain(span);
    assert(
      span.duration > 0 && tag(span, "http.response.status_code") === 200,
      "shutdown request did not finish with HTTP 200",
    );
  }
  for (const span of trace.spans) {
    assert(
      tree.chain(span).includes(root),
      "shutdown span detached from Gateway watch",
    );
    assert(
      !hasError(span) || cancellation(span),
      "unexpected error in shutdown trace dependency",
    );
  }
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((s) => s.warnings ?? []),
  ];
  const errors = trace.spans.filter(hasError).length;
  return {
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
    error_spans: errors,
    cancellation_error_spans: errors,
    strict_trace: warnings.length || errors ? "failed" : "passed",
    trace_id: trace.traceID,
    spans: trace.spans.length,
    finished_servers: selected.size,
    gateway_ancestry: true,
    gateway_outcome: cancelled ? "cancelled_stream" : "completed",
    stop_window_verified: true,
  };
}

export function assertReadyExecutionState(state, agentID) {
  assert.deepEqual(Object.keys(state).sort(), [
    "access_allowed",
    "active_session_id",
    "agent_id",
    "availability",
    "configuration_revision",
    "unavailable_reason",
  ]);
  assert.equal(state.agent_id, agentID);
  assert.equal(state.availability, "ready");
  assert.equal(state.access_allowed, true);
  assert.match(state.configuration_revision, /^[a-f0-9]{64}$/);
  assert.equal(state.active_session_id, null);
  assert.equal(state.unavailable_reason, null);
}
export function assertIdleMaintenance(audits, model) {
  assert.deepEqual(audits.items, [], "idle maintenance created a Run");
  assert.equal(audits.next_cursor, null, "audit baseline is truncated");
  assert.deepEqual(model.requests, [], "idle maintenance reached model");
  assert.deepEqual(model.errors, [], "model fixture rejected execution");
}
