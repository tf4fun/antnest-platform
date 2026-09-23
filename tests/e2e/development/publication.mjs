import assert from "node:assert/strict";
import {
  traceTopology,
  tag,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { hasError } from "../acp-plan/requests.mjs";

export function selectPublications(data, cutoff = -Infinity) {
  assert(Array.isArray(data), "publication search must return traces");
  const roots = data.filter((trace) => {
    const tree = traceTopology(trace);
    const attempt = trace.spans.find(
      (s) => s.operationName === "agent_controller.execution_publication",
    );
    return attempt && !tree.parent(attempt) && attempt.startTime >= cutoff;
  });
  assert(roots.length >= 3, "three independent publication traces required");
  const selected = roots.slice(0, 3);
  for (const trace of selected)
    assert.match(
      trace.traceID ?? "",
      /^[a-f0-9]{32}$/u,
      "publication Trace ID missing",
    );
  assert.equal(
    new Set(selected.map((t) => t.traceID)).size,
    3,
    "three distinct publication Traces required",
  );
  return selected;
}

export function inspectPublication(
  trace,
  expectedTraceID,
  organization,
  secrets = [],
  saveRaw = () => {},
  cutoff = -Infinity,
) {
  assert.equal(
    trace?.traceID,
    expectedTraceID,
    "publication Trace identity mismatch",
  );
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const attempt = trace.spans.find(
    (s) => s.operationName === "agent_controller.execution_publication",
  );
  assert(attempt);
  assert(attempt.startTime >= cutoff, "publication precedes restart cutoff");
  assert.equal(tree.service(attempt), "agent-controller");
  assert.equal(tag(attempt, "antnest.organization.id"), organization);
  assert(!tree.parent(attempt), "periodic/startup publication must be a root");
  assert(!trace.spans.some(hasError), "publication contains errors");
  const owned = trace.spans.filter((s) => tree.chain(s).includes(attempt));
  const querySpans = owned.filter(
    (s) =>
      tree.service(s) === "agent-controller" &&
      tag(s, "db.system.name") === "postgresql",
  );
  assert.equal(
    querySpans.filter((s) =>
      /SELECT revision FROM agent_controller.execution_configuration_sync\b/i.test(
        tag(s, "db.query.text") ?? "",
      ),
    ).length,
    1,
  );
  const acks = querySpans.filter((s) =>
    /UPDATE agent_controller.execution_configuration_sync\s+SET applied_revision=/i.test(
      (tag(s, "db.query.text") ?? "").replace(/\s+/g, " "),
    ),
  );
  assert.equal(acks.length, 1);
  assert.equal(tree.parent(acks[0]), attempt);
  const clients = owned.filter(
    (s) =>
      tree.service(s) === "agent-controller" &&
      s.operationName === "HTTP POST agent-acp-service",
  );
  assert.equal(clients.length, 1);
  assert.equal(tree.parent(clients[0]), attempt);
  assert.equal(tag(clients[0], "http.response.status_code"), 200);
  const server = owned.find(
    (s) =>
      tree.parent(s) === clients[0] &&
      tree.service(s) === "agent-acp-service" &&
      tag(s, "http.route") === "/rpc/agent-acp/apply-execution-snapshot",
  );
  assert(server);
  assert.equal(tag(server, "http.response.status_code"), 200);
  assert.equal(
    tag(attempt, "antnest.configuration.applied_revision"),
    tag(clients[0], "antnest.configuration.applied_revision"),
  );
  assert(tag(attempt, "antnest.configuration.applied_revision") > 0);
  saveRaw(trace);
  const warnings = [
    ...new Set([
      ...(trace.warnings ?? []),
      ...trace.spans.flatMap((s) => s.warnings ?? []),
    ]),
  ];
  assert(
    warnings.every((w) => w.startsWith("clock skew adjustment disabled")),
    "unexpected publication warning",
  );
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    source_reads: 1,
    acknowledgement_writes: 1,
    applied_revision: tag(attempt, "antnest.configuration.applied_revision"),
    errors: 0,
    strict_trace: warnings.length ? "failed" : "passed",
    warnings,
  };
}
