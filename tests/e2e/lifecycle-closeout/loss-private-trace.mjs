import assert from "node:assert/strict";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import {
  inspectPrivateCommandTrace,
  requestTraceBoundary,
} from "../acp-commands/trace.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { privateACPStrictOutcome } from "../observability/private-acp-inventory.mjs";
import { inspectLossDenial } from "./loss-current.mjs";
import { lossUnavailableRejection } from "./loss-private-diagnostics.mjs";

const reasons = new Set([
  "loss-unavailable-rejection",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);
export const lossPrivateOutcome = (results) =>
  privateACPStrictOutcome(results, reasons);

export function inspectPrivateLossDenial(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.protocolVersion, 1);
  assert.equal(expected.transport, "websocket");
  assert.equal(expected.kind, "request");
  assert.equal(expected.method, "session/prompt");
  assert(
    expected.closedBeforeResponse === undefined ||
      expected.closedBeforeResponse === false,
  );
  assert.equal(requests.length, 0);
  const result = inspectLossDenial(trace, expected, secrets);
  const { tree, request } = requestTraceBoundary(trace, expected, secrets);
  const observations = [];
  const proof = lossUnavailableRejection(
    trace,
    tree,
    request,
    expected,
    observations,
  );
  for (const span of trace.spans) {
    assert(
      !/^(agent\.run|model\.|mcp\.|runtime\.|HTTP POST model$)/u.test(
        span.operationName,
      ),
    );
    assert.notEqual(tree.service(span), "antnest-runtime");
    assertSessionSuccess(proof.views.get(span) ?? span);
  }
  for (const span of expected.connectionTrace.spans) assertSessionSuccess(span);
  return {
    ...result,
    runtime_tool_calls: 0,
    owned_error_spans: proof.records,
    neutral_diagnostics: [],
    time_observations: observations,
  };
}

export function collectPrivateLossTrace(base, expected, options) {
  return collectPrivateACPConsumerTrace(base, expected, options, {
    ownedReasons: reasons,
    inspect(trace, bound, secrets, requests) {
      const result = (
        bound.rejection ? inspectPrivateLossDenial : inspectPrivateCommandTrace
      )(trace, bound, secrets, requests);
      if (bound.runId)
        assert.equal(
          result.run_id,
          bound.runId,
          "Loss Trace belongs to another Run",
        );
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
