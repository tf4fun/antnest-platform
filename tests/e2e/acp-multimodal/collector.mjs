import assert from "node:assert/strict";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { privateACPStrictOutcome } from "../observability/private-acp-inventory.mjs";
import { inspectPrivateNativeTrace } from "./private-trace.mjs";

const ownedReasons = new Set([
  "multimodal-rejection",
  "multimodal-model-unsupported-content",
  "private-http-sse-close",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);

export function privateNativeStrictOutcome(results) {
  return privateACPStrictOutcome(results, ownedReasons);
}

export function collectPrivateNativeTrace(base, expected, options = {}) {
  return collectPrivateACPConsumerTrace(base, expected, options, {
    ownedReasons,
    inspect: (trace, bound, secrets, requests) => {
      assert(Array.isArray(requests));
      const execution = ["native", "local-failure"].includes(bound.kind);
      if (execution)
        assert(typeof bound.phase === "string" && bound.phase.length > 0);
      // Keep both correlations: a wrong/missing phase on this Trace and a
      // foreign Trace with this phase must both reach the owning validator.
      const selected = requests.filter(
        (item) =>
          item.trace_id === trace.traceID ||
          (execution && item.phase === bound.phase),
      );
      return inspectPrivateNativeTrace(trace, bound, secrets, selected);
    },
  });
}
