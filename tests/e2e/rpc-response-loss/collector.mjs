import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { collectPrivateRestartTrace } from "../acp-restart/collector.mjs";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { privateACPStrictOutcome } from "../observability/private-acp-inventory.mjs";
import { commandStrictOutcome } from "../acp-commands/trace.mjs";
import { inspectPrivateClosedPrompt } from "./closed-trace.mjs";

const reasons = new Set([
  "rpc-closed-admission",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);
export function rpcLossStrictOutcome(results) {
  const privateResults = results.filter(
    (row) => row.diagnostic_inventory_verified === true,
  );
  const legacy = results.filter(
    (row) => row.diagnostic_inventory_verified !== true,
  );
  const privateOutcome = privateResults.length
    ? privateACPStrictOutcome(privateResults, reasons)
    : { accepted: true };
  const legacyOutcome = commandStrictOutcome(legacy);
  const accepted = privateOutcome.accepted && legacyOutcome.accepted;
  return {
    ...privateOutcome,
    strict_trace: results.every((row) => row.strict_trace === "passed")
      ? "passed"
      : "failed",
    accepted,
    exit_code: accepted ? 0 : 1,
  };
}
export async function collectPrivateRpcLossTrace(base, original, options = {}) {
  if (original.rejection === undefined)
    return collectPrivateRestartTrace(base, original, options);
  const expected = structuredClone(original);
  for (const [key, value] of Object.entries({
    boundary: "private-acp",
    transport: "websocket",
    kind: "request",
    method: "session/prompt",
    outcome: "failed",
    rejection: "agent_unavailable",
  }))
    assert.equal(expected[key], value);
  assert.equal(expected.version, expected.protocolVersion);
  assert(
    expected.failureCode === -32020,
    "invalid original closed-admission RPC code",
  );
  assert(
    isDeepStrictEqual(expected.failureData, {
      code: "agent_unavailable",
      retryable: false,
    }),
    "invalid original closed-admission data",
  );
  assert(
    isDeepStrictEqual(expected.rejectionReceipt, {
      rpcCode: -32020,
      code: "agent_unavailable",
      retryable: false,
    }),
    "invalid original closed-admission receipt",
  );
  assert(
    expected.requestParams?.sessionId === expected.sessionId,
    "invalid original closed-admission Session",
  );
  expected.outcome = "rejected";
  const result = await collectPrivateACPConsumerTrace(base, expected, options, {
    ownedReasons: reasons,
    inspect(trace, bound, secrets, requests) {
      assert(
        !requests.some((row) => row.trace_id === bound.connectionTraceID),
        "closed admission connection reached Provider",
      );
      const selected = requests.filter(
        (row) => row.trace_id === trace.traceID || row.phase === bound.label,
      );
      return {
        ...inspectPrivateClosedPrompt(trace, bound, secrets, selected),
        label: bound.label,
        kind: bound.kind,
      };
    },
  });
  options.signal?.throwIfAborted();
  assert.equal(rpcLossStrictOutcome([result]).accepted, true);
  return result;
}
