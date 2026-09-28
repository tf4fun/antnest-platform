import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";

export function inspectLegacySourceRecoveryTrace(trace, expected) {
  assert.equal(trace?.traceID, expected.traceID);
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), expected.secrets ?? []);
  const spans = trace.spans;
  const one = (candidates, label) => {
    assert.equal(
      candidates.length,
      1,
      `expected one ${label}, found ${candidates.length}`,
    );
    return candidates[0];
  };
  const descendants = (ancestor, service, name) =>
    spans.filter(
      (span) =>
        tree.service(span) === service &&
        span.operationName === name &&
        tree.chain(span).includes(ancestor),
    );
  const root = one(
    spans.filter((span) => !tree.parent(span)),
    "source recovery root",
  );
  assert.equal(tree.service(root), "agent-controller");
  assert.equal(
    tag(root, "http.route"),
    "/internal/agents/{agent_id}/legacy-system-skills-migration/source-recovery",
  );
  const workflow = one(
    descendants(
      root,
      "agent-controller",
      "RunWorkflow:LegacySourceRecoveryWorkflow",
    ),
    "source recovery Workflow",
  );
  one(
    descendants(
      workflow,
      "agent-controller",
      "RunActivity:legacy_source.admit",
    ),
    "admission activity",
  );
  const stages = descendants(
    workflow,
    "agent-controller",
    "RunActivity:legacy_source.advance",
  );
  assert.equal(
    stages.length,
    4,
    "source recovery must durably advance all four effect stages",
  );
  const rcClient = one(
    stages.flatMap((stage) =>
      descendants(stage, "agent-controller", "HTTP POST runtime-controller"),
    ),
    "RC Disable client",
  );
  one(
    descendants(
      rcClient,
      "runtime-controller",
      "HTTP POST /internal/runtimes/{agent_id}/disable",
    ),
    "RC Disable server",
  );
  assert(
    stages.some(
      (stage) =>
        descendants(stage, "agent-controller", "HTTP PUT runtime-egress")
          .length > 0,
    ),
    "source network fence is missing",
  );
  assert(
    stages.some(
      (stage) =>
        descendants(stage, "agent-controller", "HTTP GET runtime-egress")
          .length > 0,
    ),
    "closed Egress recheck is missing",
  );
  const sql = spans.filter(
    (span) =>
      tree.service(span) === "agent-controller" &&
      stages.some((stage) => tree.chain(span).includes(stage)) &&
      tag(span, "db.system.name") === "postgresql" &&
      typeof tag(span, "db.query.text") === "string",
  );
  assert(
    sql.some((span) => /\bagent_events\b/u.test(tag(span, "db.query.text"))),
    "source recovery audit event INSERT missing",
  );
  assert(
    sql.some((span) =>
      /\blegacy_source_recoveries\b/u.test(tag(span, "db.query.text")),
    ),
    "source recovery receipt publication missing",
  );
  const warnings = [
    ...(trace.warnings ?? []),
    ...spans.flatMap((span) => span.warnings ?? []),
  ];
  assert(
    warnings.every((warning) =>
      /^clock skew adjustment disabled; not applying calculated delta of -?[0-9.]+(?:ns|µs|ms|s)$/u.test(
        warning,
      ),
    ),
    "source recovery Trace has warnings beyond the accepted clock diagnostic",
  );
  return {
    trace_id: trace.traceID,
    spans: spans.length,
    recovery_workflow: true,
    rc_disable: true,
    egress_fence: true,
    publication_sql: true,
    warning_count: warnings.length,
  };
}
