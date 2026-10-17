import assert from "node:assert/strict";
import { inspect } from "node:util";

const nonempty = (value) =>
  assert(typeof value === "string" && value.length > 0);
const unique = (values, label) =>
  assert.equal(
    new Set(values).size,
    values.length,
    `duplicate Restart ${label}`,
  );
function fail(errors) {
  const all = [...new Set(errors)];
  if (all.length === 1) throw all[0];
  if (all.length)
    throw new AggregateError(
      all,
      "Restart request, evidence or cleanup failed",
    );
}
export async function preservePrivateACPFailure(error, preserve) {
  try {
    await preserve(error);
  } catch (archiveError) {
    fail([error, archiveError]);
  }
}
function identity(client, actual, method, inputSessionID) {
  assert.equal(actual?.method, method, "actual Restart request required");
  nonempty(actual.requestId);
  assert.equal(actual.sessionId ?? null, inputSessionID);
  return {
    boundary: client.boundary,
    transport: client.transport,
    protocolVersion: client.version,
    agentId: client.agentId,
    connectionTraceID: client.connectionTraceID,
    clientSpanID: client.clientSpanID,
    method,
    requestId: actual.requestId,
    inputSessionID,
  };
}

export function checkPrivateACPConnection(connection) {
  assert.equal(connection.closed, true, "Restart connection has not joined");
  assert.deepEqual(connection.evidence_errors, []);
  const rows = [connection.initialization, ...connection.evidence];
  unique(
    rows.map((row) => row.requestId),
    "request ID on connection",
  );
  assert.deepEqual(
    connection.requests.map(({ requestId, method, sessionId }) => ({
      requestId,
      method,
      sessionId: sessionId ?? null,
    })),
    rows.map(({ requestId, method, inputSessionID }) => ({
      requestId,
      method,
      sessionId: inputSessionID,
    })),
  );
  assert.equal(rows[0].method, "initialize");
  assert.equal(rows[0].outcome, "succeeded");
  assert.equal(rows[0].inputSessionID, null);
  assert.equal(rows[0].sessionId, undefined);
  assert.equal(
    rows[0].initializationResult.protocolVersion,
    connection.version,
  );
  for (const row of rows) {
    for (const [key, value] of Object.entries({
      boundary: "private-acp",
      transport: "websocket",
      protocolVersion: connection.version,
      agentId: connection.agentId,
      connectionTraceID: connection.connectionTraceID,
      clientSpanID: connection.clientSpanID,
    }))
      assert.equal(row[key], value, `foreign Restart request ${key}`);
    assert.equal(
      row.closedBeforeResponse,
      undefined,
      "Restart cannot borrow a deliberate-close exception",
    );
    nonempty(row.requestId);
    const raw = connection.raw_frames.filter(
      (frame) =>
        Object.hasOwn(frame, "id") &&
        String(frame.id) === row.requestId &&
        (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")),
    );
    if (row.outcome === "succeeded") {
      assert.equal(
        raw.length,
        1,
        "successful Restart response missing or duplicated",
      );
      assert(
        Object.hasOwn(raw[0], "result") && !Object.hasOwn(raw[0], "error"),
      );
      assert.equal(row.failure, undefined);
      if (row.method === "initialize")
        assert.equal(raw[0].result.protocolVersion, connection.version);
      else {
        assert(row.requestResult && typeof row.requestResult === "object");
        if (row.method === "session/new")
          assert.equal(raw[0].result.sessionId, row.requestResult.sessionId);
        if (row.method === "session/prompt" && connection.version === 2) {
          nonempty(row.requestResult.messageId);
          assert.equal(
            raw[0].result.messageId,
            row.requestResult.messageId,
            "v2 prompt ACK changed after receipt",
          );
        }
      }
    } else {
      assert.equal(row.outcome, "failed");
      nonempty(row.failure);
      assert.equal(row.requestResult, undefined);
      assert(
        raw.length <= 1 &&
          raw.every(
            (frame) =>
              Object.hasOwn(frame, "error") && !Object.hasOwn(frame, "result"),
          ),
        "failed Restart request has a conflicting response",
      );
    }
  }
}

// The existing shared connection owns delegation and SDK handling. This recorder
// owns original business inputs/results and joins their private archive on error.
export function createPrivateACPRecorder(client, meta, preserve) {
  assert.equal(typeof preserve, "function", "Restart private archive required");
  assert.equal(client.boundary, "private-acp");
  assert.equal(client.transport, "websocket");
  assert.equal(client.agentId, meta.agentId);
  assert.equal(client.version, meta.version);
  assert([1, 2].includes(meta.version));
  assert.equal(
    client.requests.length,
    1,
    "exactly one existing initialization required",
  );
  assert(Array.isArray(client.rawFrames));
  const metadata = structuredClone(meta);
  const initialization = {
    ...identity(client, client.requests[0], "initialize", null),
    outcome: "succeeded",
    initializationResult: structuredClone(client.initializationResult),
  };
  const records = [],
    evidenceErrors = [],
    pending = new Set();
  let closing,
    closed = false;
  const snapshot = () => ({
    ...metadata,
    connectionTraceID: client.connectionTraceID,
    clientSpanID: client.clientSpanID,
    closed,
    initialization: structuredClone(initialization),
    evidence: structuredClone(records),
    requests: structuredClone(client.requests),
    raw_frames: structuredClone(client.rawFrames),
    updates: structuredClone(client.updates ?? []),
    evidence_errors: evidenceErrors.map((error) => inspect(error)),
  });
  const archive = async () => {
    try {
      await preserve(snapshot());
    } catch (error) {
      evidenceErrors.push(error);
      throw error;
    }
  };
  return {
    snapshot,
    async request(name, params, timeout = 120000) {
      assert(
        !closing && pending.size === 0,
        "Restart request overlap or closed connection",
      );
      const input = structuredClone(params),
        offset = client.requests.length;
      const operation = (async () => {
        const errors = [];
        let result,
          failed = false;
        const row = { method: "session/" + name, requestParams: input };
        try {
          result = await client.request(name, params, timeout);
        } catch (error) {
          failed = true;
          errors.push(error);
          row.failure = inspect(error, { depth: 8 });
          if (error?.code !== undefined) row.failureCode = error.code;
          if (error?.data !== undefined)
            row.failureData = structuredClone(error.data);
          if (
            typeof error?.code === "number" &&
            typeof error?.data?.code === "string" &&
            typeof error?.data?.retryable === "boolean"
          )
            row.rejectionReceipt = {
              rpcCode: error.code,
              code: error.data.code,
              retryable: error.data.retryable,
            };
        }
        row.outcome = failed ? "failed" : "succeeded";
        if (!failed) row.requestResult = structuredClone(result);
        row.sessionId = input.sessionId ?? result?.sessionId;
        try {
          const actual = client.requests.slice(offset);
          assert.equal(
            actual.length,
            1,
            "missing or overlapping Restart wire request",
          );
          Object.assign(
            row,
            identity(client, actual[0], row.method, input.sessionId ?? null),
          );
        } catch (error) {
          evidenceErrors.push(error);
          errors.push(error);
        }
        records.push(row);
        try {
          await archive();
        } catch (error) {
          errors.push(error);
        }
        fail(errors);
        return result;
      })();
      pending.add(operation);
      try {
        return await operation;
      } finally {
        pending.delete(operation);
      }
    },
    closeAndWait() {
      return (closing ??= Promise.resolve().then(async () => {
        const errors = [];
        try {
          await client.closeAndWait();
          closed = true;
        } catch (error) {
          errors.push(error);
        }
        while (pending.size) await Promise.allSettled([...pending]);
        try {
          checkPrivateACPConnection(snapshot());
        } catch (error) {
          errors.push(error);
        }
        errors.push(...evidenceErrors);
        try {
          await archive();
        } catch (error) {
          errors.push(error);
        }
        fail(errors);
        return snapshot();
      }));
    },
  };
}
