import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const same = (
  actual,
  expected,
  message = "Workspace original request fields disagree",
) => assert(isDeepStrictEqual(actual, expected), message);

export const workspaceRequestKey = (row) =>
  `${row.connectionTraceID}/${row.requestId}`;

// Project one recorded RPC independently. A damaged sibling is reported by the
// separate inventory gate and must not prevent this original Trace being read.
export function projectWorkspaceRequest(connection, row, observation = {}) {
  const fields = new Set([
    "connectionTraceID",
    "requestId",
    "method",
    "sessionId",
    "kind",
    "phase",
    "toolName",
    "rejection",
    "runId",
    "run",
    "runtime",
    "probe",
    "label",
  ]);
  for (const key of Object.keys(observation))
    assert(fields.has(key), "unexpected Workspace request annotation");
  for (const [key, value] of Object.entries({
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: 1,
    agentId: connection.agentId,
    connectionTraceID: connection.connectionTraceID,
    clientSpanID: connection.clientSpanID,
  }))
    same(row[key], value);
  same(connection.version, 1);
  for (const key of ["connectionTraceID", "requestId", "method", "sessionId"])
    if (Object.hasOwn(observation, key)) same(observation[key], row[key]);
  for (const key of [
    "closedBeforeResponse",
    "requestReceipt",
    "kind",
    "phase",
    "rejection",
  ])
    same(row[key], undefined, "raw Workspace row was annotated");
  const wires = connection.requests.filter(
    (item) => item.requestId === row.requestId,
  );
  same(wires.length, 1);
  same(wires[0].method, row.method);
  same(wires[0].sessionId ?? null, row.inputSessionID);
  const frames = connection.raw_frames.filter(
    (frame) =>
      Object.hasOwn(frame, "id") &&
      String(frame.id) === row.requestId &&
      (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")),
  );
  const projected = { ...structuredClone(row), kind: "request" };
  if (row.outcome === "succeeded") {
    for (const field of ["rejectionReceipt", "failureCode", "failureData"])
      same(
        row[field],
        undefined,
        "successful Workspace request retained failure metadata",
      );
    same(frames.length, 1);
    same(frames[0].error, undefined);
    same(row.failure, undefined);
    if (row.method === "initialize") {
      same(row.inputSessionID, null);
      same(row.sessionId, undefined);
      same(frames[0].result, row.initializationResult);
      same(row.initializationResult.protocolVersion, 1);
    } else {
      same(frames[0].result, row.requestResult);
      assert(row.requestParams && row.requestResult);
      same(row.inputSessionID, row.requestParams.sessionId ?? null);
      same(
        row.sessionId,
        row.requestParams.sessionId ?? row.requestResult.sessionId,
      );
      projected.requestReceipt = {
        requestId: row.requestId,
        params: structuredClone(row.requestParams),
        result: structuredClone(row.requestResult),
      };
    }
  } else {
    same(row.outcome, "failed");
    assert(typeof row.failure === "string" && row.failure.length > 0);
    same(row.requestResult, undefined);
    same(row.inputSessionID, row.requestParams.sessionId);
    same(row.sessionId, row.inputSessionID);
    if (row.rejectionReceipt) {
      const rejection = row.rejectionReceipt.code;
      assert(
        ["agent_busy", "runtime_barrier_required", "access_denied"].includes(
          rejection,
        ),
      );
      const receipt = { rpcCode: -32020, code: rejection, retryable: false };
      same(row.rejectionReceipt, receipt);
      same(row.failureCode, -32020);
      same(row.failureData?.code, rejection);
      same(row.failureData?.retryable, false);
      same(frames.length, 1);
      same(frames[0].result, undefined);
      same(frames[0].error.code, -32020);
      same(frames[0].error.data?.code, rejection);
      same(frames[0].error.data?.retryable, false);
      same(row.method, "session/prompt");
      projected.rejection = rejection;
      projected.outcome = "rejected";
    } else {
      same(frames.length, 0, "deliberate disconnect has a wire reply");
      same(row.method, "session/prompt");
      assert(["c4-cancel", "c4-offline"].includes(observation.phase));
    }
  }
  if (observation.phase) {
    assert(
      ["c4-cancel", "c4-offline", "c4-rebuilt"].includes(observation.phase),
    );
    same(row.method, "session/prompt");
    same(projected.rejection, undefined);
    same(row.requestParams.prompt, [{ type: "text", text: observation.phase }]);
    same(
      row.outcome,
      observation.phase === "c4-rebuilt" ? "succeeded" : "failed",
    );
    projected.kind =
      observation.phase === "c4-cancel" ? "cancelled" : "ordinary";
    projected.phase = observation.phase;
  }
  for (const key of ["kind", "rejection"])
    if (Object.hasOwn(observation, key)) same(observation[key], projected[key]);
  if (observation.toolName !== undefined) {
    same(observation.phase, "c4-rebuilt");
    same(observation.toolName, "read");
  }
  if (observation.probe !== undefined) {
    same(observation.probe, true);
    same(projected.rejection, "access_denied");
  }
  for (const key of ["toolName", "runId", "run", "runtime", "probe", "label"])
    if (Object.hasOwn(observation, key))
      projected[key] = structuredClone(observation[key]);
  return projected;
}
