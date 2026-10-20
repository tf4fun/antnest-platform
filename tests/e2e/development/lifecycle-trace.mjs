import assert from "node:assert/strict";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { traceTopology, tag } from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";

export function inspectDevelopmentLifecycle(trace, expected, secrets = []) {
  // Validate every original probe before checking this scenario's coverage.
  const result = inspectLifecycle(trace, expected, secrets);
  const tree = traceTopology(trace),
    owners = new Map();
  for (const probe of trace.spans) {
    if (
      hasError(probe) ||
      tree.service(probe) !== "runtime-controller" ||
      tag(probe, "peer.service") !== "docker" ||
      tag(probe, "http.response.status_code") !== 404
    )
      continue;
    const owner = tree.parent(probe);
    if (!owners.has(owner.spanID))
      owners.set(owner.spanID, {
        owner_span_id: owner.spanID,
        operation: owner.operationName,
        generation: tag(owner, "antnest.runtime.generation"),
        probe_span_ids: [],
      });
    owners.get(owner.spanID).probe_span_ids.push(probe.spanID);
  }
  const groups = [...owners.values()];
  const required =
    expected.kind === "create"
      ? ["runtime.platform.ensure_storage", "runtime.platform.create"]
      : ["enable", "rebuild"].includes(expected.kind)
        ? ["runtime.platform.create"]
        : [];
  for (const operation of required)
    assert(
      groups.some((group) => group.operation === operation),
      `${expected.kind} has no owned ${operation} absence probe`,
    );
  // Auxiliary resources vary by preparation and cleanup state. Their actual
  // counts remain evidence; they cannot replace a required owning boundary.
  return { ...result, platform_absence_owners: groups };
}
