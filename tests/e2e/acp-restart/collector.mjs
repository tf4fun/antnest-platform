import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { inspectPrivateCommandTrace } from "../acp-commands/trace.mjs";
import { inspectPrivateCostControlTrace } from "../acp-cost/control-trace.mjs";
import { inspectPrivateCostSessionTrace } from "../acp-cost/session-trace.mjs";
import { inspectProgressBarrierTrace } from "../acp-progress/control-trace.mjs";
import {
  assertRuntimeBinding,
  restartDiagnosticReasons,
  restartStrictOutcome,
} from "./trace.mjs";

// Reuse existing collectors and inspectors; only Restart's recorder projection
// and original Provider/Runtime expectations belong to this consumer.
export async function collectPrivateRestartTrace(base, original, options = {}) {
  const expected = structuredClone(original);
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert(["request", "ordinary"].includes(expected.kind));
  assert.equal(expected.version, expected.protocolVersion);
  if (expected.rejection !== undefined) {
    assert.equal(expected.kind, "request");
    assert.equal(expected.method, "session/prompt");
    assert.equal(expected.outcome, "failed");
    assert.equal(expected.rejection, "runtime_barrier_required");
    assert(
      expected.failureCode === -32020,
      "invalid original barrier RPC code",
    );
    assert(
      isDeepStrictEqual(expected.failureData, {
        code: expected.rejection,
        retryable: false,
      }),
      "invalid original barrier failure data",
    );
    assert(
      isDeepStrictEqual(expected.rejectionReceipt, {
        rpcCode: -32020,
        code: expected.rejection,
        retryable: false,
      }),
      "invalid original barrier rejection receipt",
    );
    expected.outcome = "rejected";
  } else {
    assert.equal(expected.outcome, "succeeded");
    if (expected.method !== "initialize") {
      assert(expected.requestParams && expected.requestResult);
      assert.equal(
        expected.requestParams.sessionId ?? null,
        expected.inputSessionID,
      );
      if (expected.kind === "ordinary") {
        assert.equal(expected.method, "session/prompt");
        assert.equal(expected.inputSessionID, expected.sessionId);
      } else {
        assert(
          ["session/new", "session/load", "session/resume"].includes(
            expected.method,
          ),
        );
        expected.requestReceipt = {
          requestId: expected.requestId,
          params: expected.requestParams,
          result: expected.requestResult,
        };
      }
    } else assert.equal(expected.kind, "request");
  }
  const result = await collectPrivateACPConsumerTrace(base, expected, options, {
    ownedReasons: restartDiagnosticReasons,
    inspect(trace, bound, secrets, requests) {
      assert(
        !requests.some((row) => row.trace_id === bound.connectionTraceID),
        "Restart connection reached Provider",
      );
      const selected = requests.filter(
        (row) =>
          row.trace_id === trace.traceID ||
          (bound.kind === "ordinary" && row.phase === bound.phase),
      );
      if (bound.kind === "ordinary")
        assert(
          selected.every((row) => row.trace_id === trace.traceID),
          "foreign Restart Provider Trace",
        );
      let report;
      if (bound.rejection !== undefined)
        report = inspectProgressBarrierTrace(trace, bound, secrets, selected);
      else if (bound.method === "initialize")
        report = inspectPrivateCostControlTrace(
          trace,
          bound,
          secrets,
          selected,
        );
      else if (bound.kind === "ordinary") {
        report = inspectPrivateCommandTrace(trace, bound, secrets, selected);
        if (bound.runtimeBinding)
          assertRuntimeBinding(
            trace,
            bound.runtimeBinding.run,
            bound.runtimeBinding.runtime,
          );
      } else
        report = inspectPrivateCostSessionTrace(
          trace,
          bound,
          secrets,
          selected,
        );
      return {
        ...report,
        label: bound.label,
        kind: bound.kind,
        method: bound.method,
        request_id: bound.requestId,
      };
    },
  });
  options.signal?.throwIfAborted();
  assert.equal(restartStrictOutcome([result]).accepted, true);
  return result;
}

// Open connections must archive initialize before their next injected failure.
export function restartTraceInitializations(connections) {
  const seen = new Set();
  return connections.map((connection) => {
    const row = connection.initialization;
    assert(
      !seen.has(connection.connectionTraceID),
      "duplicate Restart connection",
    );
    seen.add(connection.connectionTraceID);
    for (const [field, value] of Object.entries({
      agentId: connection.agentId,
      protocolVersion: connection.version,
      connectionTraceID: connection.connectionTraceID,
      clientSpanID: connection.clientSpanID,
      method: "initialize",
      outcome: "succeeded",
      inputSessionID: null,
    }))
      assert.equal(row[field], value);
    return {
      ...structuredClone(row),
      version: connection.version,
      kind: "request",
      label: `v${connection.version}-${connection.kind}-${connection.role}-initialize`,
    };
  });
}
