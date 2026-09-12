import assert from "node:assert/strict";
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
      next.running && Date.parse(next.started) > Date.parse(prior.started),
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
  const spans = new Map(trace.spans.map((s) => [s.spanID, s]));
  assert.equal(spans.size, trace.spans.length, "duplicate shutdown span");
  const service = (s) => trace.processes[s.processID]?.serviceName;
  const tag = (s, key) => s.tags?.find((t) => t.key === key)?.value;
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
    tag(root, "error") === true &&
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
  const controllers = servers("agent-controller").filter(
    (s) => tag(s, "http.route") === expected.controllerRoute,
  );
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
  for (const span of selected) {
    chain(span);
    assert(
      span.duration > 0 &&
        (tag(span, "error") !== true || (span === root && cancelled)) &&
        tag(span, "http.response.status_code") === 200,
      `shutdown request did not finish successfully: ${service(span)}; ` +
        `status=${Number(tag(span, "http.response.status_code"))}; ` +
        `error=${tag(span, "error") === true}; ` +
        `handler_aborted=${tag(span, "otel.status_description") === "handler_aborted"}; ` +
        `finished=${span.duration > 0}`,
    );
  }
  for (const span of trace.spans) {
    const ended = (span.startTime + span.duration) / 1000;
    const cancelledClient =
      cancelled &&
      service(span) === "edge-gateway" &&
      tag(span, "span.kind") === "client" &&
      tag(span, "error.type") === "cancelled" &&
      tag(span, "http.response.status_code") === 200 &&
      span.duration > 0 &&
      ended >= window.start &&
      ended <= window.end &&
      span.references?.some(
        (ref) =>
          ref.refType === "CHILD_OF" &&
          ref.traceID === trace.traceID &&
          ref.spanID === root.spanID,
      );
    assert(
      tag(span, "error") !== true ||
        (span === root && cancelled) ||
        cancelledClient,
      "unexpected error in shutdown trace dependency",
    );
  }
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    finished_servers: selected.size,
    gateway_ancestry: true,
    gateway_outcome: cancelled ? "cancelled_stream" : "completed",
    stop_window_verified: true,
  };
}
