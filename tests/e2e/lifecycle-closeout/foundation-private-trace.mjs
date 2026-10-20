import assert from "node:assert/strict";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { inspectPrivateCommandTrace } from "../acp-commands/trace.mjs";
import { inspectPrivateManagedTrace } from "../managed-mcp/request-trace.mjs";
import { privateACPStrictOutcome } from "../observability/private-acp-inventory.mjs";

const reasons = new Set([
  "managed-busy-rejection",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);
export const foundationPrivateOutcome = (results) =>
  privateACPStrictOutcome(results, reasons);

export async function collectFoundationRequests(rows, collect, signal) {
  const results = [],
    errors = [];
  for (const row of rows) {
    if (signal?.aborted) break;
    try {
      results.push(await collect(row));
    } catch (error) {
      errors.push(error);
    }
  }
  if (signal?.aborted) errors.push(signal.reason);
  const failures = [...new Set(errors)];
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Foundation private Trace collection failed",
    );
  return results;
}
export function collectFoundationPrivateTrace(base, expected, options) {
  return collectPrivateACPConsumerTrace(base, expected, options, {
    ownedReasons: reasons,
    inspect(trace, bound, secrets, requests) {
      const result = (
        bound.rejection
          ? inspectPrivateManagedTrace
          : inspectPrivateCommandTrace
      )(trace, bound, secrets, requests);
      if (bound.rejection) assert.equal(result.no_execution, true);
      if (bound.runId)
        assert.equal(
          result.run_id,
          bound.runId,
          "Foundation Trace belongs to another Run",
        );
      return {
        ...result,
        ...(bound.rejection ? { runtime_tool_calls: 0 } : {}),
        topology: "passed",
        method: bound.method,
        request_id: bound.requestId,
        connection_trace_id: bound.connectionTraceID,
        session_id: bound.sessionId,
      };
    },
  });
}
