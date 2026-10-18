import assert from "node:assert/strict";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { inspectPrivateCommandTrace } from "../acp-commands/trace.mjs";
import { privateACPStrictOutcome } from "../observability/private-acp-inventory.mjs";

const reasons = new Set([
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);
export const restorePrivateOutcome = (results) =>
  privateACPStrictOutcome(results, reasons);

export async function collectPrivateRestoreTrace(base, expected, options) {
  assert.equal(expected.rejection, undefined);
  assert.equal(expected.rejectionReceipt, undefined);
  return collectPrivateACPConsumerTrace(base, expected, options, {
    ownedReasons: reasons,
    inspect(trace, bound, secrets, requests) {
      const result = inspectPrivateCommandTrace(
        trace,
        bound,
        secrets,
        requests,
      );
      if (bound.kind === "ordinary") {
        assert(typeof bound.runId === "string" && bound.runId.length > 0);
        assert.equal(
          result.run_id,
          bound.runId,
          "Restore Trace belongs to another Run",
        );
      }
      return {
        ...result,
        topology: "passed",
        method: bound.method,
        request_id: bound.requestId,
        connection_trace_id: bound.connectionTraceID,
        session_id: bound.sessionId,
      };
    },
  });
}
