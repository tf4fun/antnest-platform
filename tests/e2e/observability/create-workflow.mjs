import { inspectWorkflow } from "./lifecycle-workflow.mjs";

export function inspectCreateWorkflow(trace, requestID, options = {}) {
  return inspectWorkflow(trace, requestID, { ...options, kind: "create" });
}
