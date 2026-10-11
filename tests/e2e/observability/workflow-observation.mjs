import assert from "node:assert/strict";
import { lifecyclePlans } from "./lifecycle-workflow.mjs";
import { collectObservabilityResolution } from "./resolve-evidence.mjs";

// The five lifecycle commands share one Gateway admission shape. The owning
// callback still controls workflow, readiness, retry and terminal evidence.
export async function collectWorkflowObservation(
  base,
  identity,
  config,
  options,
) {
  assert(
    Object.hasOwn(lifecyclePlans, identity.kind),
    "unsupported lifecycle observation",
  );
  return collectObservabilityResolution(
    base,
    {
      traceID: identity.traceID,
      profile: "console",
      resolveTTLMS: config.resolveTTLMS,
      route: "/api/admin/{path...}",
      method: "POST",
      status: 202,
      consoleRoute:
        identity.kind === "create"
          ? "/api/admin/agents"
          : `/api/admin/agents/{agent_id}/${identity.kind}`,
    },
    { ...options, captureRpcContent: config.captureRpcContent },
  );
}
