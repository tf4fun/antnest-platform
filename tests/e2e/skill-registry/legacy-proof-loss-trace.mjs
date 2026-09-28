import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";

export function inspectLegacyProofLossRecoveryTrace(trace, expected) {
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
    "recovery root",
  );
  assert.equal(tree.service(root), "agent-controller");
  assert.equal(
    tag(root, "http.route"),
    "/internal/agents/{agent_id}/legacy-system-skills-migration/proof-loss-recovery",
  );
  const workflow = one(
    descendants(
      root,
      "agent-controller",
      "RunWorkflow:LegacyProofLossRecoveryWorkflow",
    ),
    "recovery Workflow",
  );
  one(
    descendants(
      workflow,
      "agent-controller",
      "RunActivity:legacy_proof_loss.admit",
    ),
    "admission activity",
  );
  const disable = one(
    descendants(
      workflow,
      "agent-controller",
      "RunActivity:legacy_proof_loss.disable_runtime",
    ),
    "Disable activity",
  );
  const rcClient = one(
    descendants(disable, "agent-controller", "HTTP POST runtime-controller"),
    "RC client",
  );
  const rcServer = one(
    descendants(
      rcClient,
      "runtime-controller",
      "HTTP POST /internal/runtimes/{agent_id}/disable",
    ),
    "RC Disable server",
  );
  const rcEffect = one(
    descendants(
      rcServer,
      "runtime-controller",
      "runtime.lifecycle.disable_runtime",
    ),
    "RC Disable effect",
  );
  one(
    descendants(rcEffect, "runtime-controller", "runtime.platform.delete"),
    "platform delete",
  );
  const publish = one(
    descendants(
      workflow,
      "agent-controller",
      "RunActivity:legacy_proof_loss.publish",
    ),
    "publish activity",
  );
  const egressClient = one(
    descendants(publish, "agent-controller", "HTTP GET runtime-egress"),
    "Egress client",
  );
  one(
    descendants(
      egressClient,
      "antnest-runtime-egress",
      "HTTP GET /internal/agent-networks/{agent_id}",
    ),
    "closed Egress recheck",
  );
  const publicationSQL = spans.filter(
    (span) =>
      tree.service(span) === "agent-controller" &&
      tree.chain(span).includes(publish) &&
      tag(span, "db.system.name") === "postgresql" &&
      typeof tag(span, "db.query.text") === "string",
  );
  assert(
    publicationSQL.some((span) =>
      /\bagent_events\b/u.test(tag(span, "db.query.text")),
    ),
    "recovery publication audit INSERT missing",
  );
  assert(
    publicationSQL.some((span) =>
      /\blegacy_proof_loss_recoveries\b/u.test(tag(span, "db.query.text")),
    ),
    "recovery receipt publication missing",
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
    "recovery Trace has warnings beyond the accepted clock diagnostic",
  );
  return {
    trace_id: trace.traceID,
    spans: spans.length,
    services: [...new Set(spans.map(tree.service))].sort(),
    recovery_workflow: true,
    rc_disable: true,
    egress_recheck: true,
    publication_sql: true,
    warning_count: warnings.length,
  };
}

export function inspectLegacyProofLossCrashDiagnostic(trace, expected) {
  assert.equal(trace?.traceID, expected.traceID);
  assert(trace.spans?.length, "crash Trace was not exported");
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), expected.secrets ?? []);
  const ids = new Set(trace.spans.map((span) => span.spanID));
  const missingParents = trace.spans.filter((span) =>
    (span.references ?? []).some(
      (ref) => ref.refType === "CHILD_OF" && !ids.has(ref.spanID),
    ),
  );
  assert(
    trace.spans.some(
      (span) => span.operationName === "RunActivity:legacy_proof_loss.publish",
    ),
    "recovery publish activity was not exported",
  );
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    topology_scope: "abnormal_exit_diagnostic",
    missing_parent_spans: missingParents.length,
  };
}
