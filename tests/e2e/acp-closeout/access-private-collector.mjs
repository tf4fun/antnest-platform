import assert from "node:assert/strict";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { inspectPrivateCostControlTrace } from "../acp-cost/control-trace.mjs";
import { inspectPrivateCostSessionTrace } from "../acp-cost/session-trace.mjs";
import { inspectPrivateCostConfigurationTrace } from "../acp-cost/configuration-trace.mjs";
import { inspectPrivateCommandTrace } from "../acp-commands/trace.mjs";
import { assertExecutionBinding } from "./access-evidence.mjs";
import { privateACPStrictOutcome } from "../observability/private-acp-inventory.mjs";

const reasons = new Set([
  "cost-rejection",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);
export function privateCloseoutStrictOutcome(results) {
  return privateACPStrictOutcome(results, reasons);
}

// Closeout owns only the original recorder projection. The existing complete
// source collector and service-operation inspectors retain their admission.
export async function collectPrivateCloseoutTrace(
  base,
  original,
  options = {},
) {
  const expected = structuredClone(original);
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert.equal(expected.version, expected.protocolVersion);
  assert(["request", "ordinary"].includes(expected.kind));
  if (expected.rejection !== undefined) {
    assert.equal(expected.kind, "request");
    assert.equal(expected.outcome, "failed");
    assert.equal(expected.failureCode, -32020);
    assert.deepEqual(expected.failureData, {
      code: expected.rejection,
      retryable: false,
    });
    assert.deepEqual(expected.rejectionReceipt, {
      rpcCode: -32020,
      code: expected.rejection,
      retryable: false,
    });
    assert.equal(
      expected.requestParams?.sessionId ?? null,
      expected.inputSessionID,
    );
    assert.equal(expected.requestResult, undefined);
    expected.outcome = "rejected";
  } else {
    assert.equal(expected.outcome, "succeeded");
    if (expected.method === "initialize")
      assert.equal(expected.kind, "request");
    else {
      assert(expected.requestParams && expected.requestResult);
      assert.equal(
        expected.requestParams.sessionId ?? null,
        expected.inputSessionID,
      );
      const receipt = {
        requestId: expected.requestId,
        params: expected.requestParams,
        result: expected.requestResult,
      };
      if (expected.kind === "ordinary") {
        assert.equal(expected.method, "session/prompt");
        assert.equal(expected.inputSessionID, expected.sessionId);
        assert(typeof expected.runId === "string" && expected.runId.length > 0);
        assert.deepEqual(expected.requestParams.prompt, [
          { type: "text", text: expected.phase },
        ]);
      } else if (expected.method === "session/list")
        expected.listReceipt = receipt;
      else {
        assert(
          ["session/new", "session/load", "session/resume"].includes(
            expected.method,
          ),
        );
        expected.requestReceipt = receipt;
      }
    }
  }
  const result = await collectPrivateACPConsumerTrace(base, expected, options, {
    ownedReasons: reasons,
    inspect(trace, bound, secrets, requests) {
      assert(
        !requests.some((row) => row.trace_id === bound.connectionTraceID),
        "Closeout connection reached Provider",
      );
      const selected = requests.filter(
        (row) =>
          row.trace_id === trace.traceID ||
          (bound.kind === "ordinary" && row.phase === bound.phase),
      );
      if (bound.kind === "ordinary")
        assert(
          selected.every((row) => row.trace_id === trace.traceID),
          "foreign Closeout Provider Trace",
        );
      const inspect =
        bound.rejection || bound.method === "initialize"
          ? inspectPrivateCostControlTrace
          : bound.kind === "ordinary"
            ? inspectPrivateCommandTrace
            : bound.method === "session/list"
              ? inspectPrivateCostConfigurationTrace
              : inspectPrivateCostSessionTrace;
      const checked = inspect(trace, bound, secrets, selected);
      if (bound.kind === "ordinary") assertExecutionBinding(checked, bound);
      return {
        ...checked,
        label: bound.label,
        kind: bound.kind,
        method: bound.method,
        request_id: bound.requestId,
      };
    },
  });
  options.signal?.throwIfAborted();
  assert.equal(privateCloseoutStrictOutcome([result]).accepted, true);
  return result;
}
