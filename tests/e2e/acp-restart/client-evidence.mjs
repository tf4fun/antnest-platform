import assert from "node:assert/strict";
import { inspect } from "node:util";
import { replayRequest } from "../managed-mcp/protocol.mjs";

const setup = { cwd: "/workspace", mcpServers: [] };
const kinds = ["completed", "model-held", "tool-held", "inflight"];
const roles = ["prompt", "replay-1", "replay-2", "rebuild"];
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
export async function preserveRestartFailure(error, preserve) {
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

function checkConnection(connection) {
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
export function createRestartRecorder(client, meta, preserve) {
  assert.equal(typeof preserve, "function", "Restart private archive required");
  assert.equal(client.boundary, "private-acp");
  assert.equal(client.transport, "websocket");
  assert.equal(client.agentId, meta.agentId);
  assert.equal(client.version, meta.version);
  assert(
    [1, 2].includes(meta.version) &&
      kinds.includes(meta.kind) &&
      roles.includes(meta.role),
  );
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
          checkConnection(snapshot());
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

export function indexRestartRequests({ agentId, connections }) {
  nonempty(agentId);
  assert.equal(connections.length, 26);
  unique(
    connections.map((row) => row.connectionTraceID),
    "connection Trace",
  );
  unique(
    connections.map((row) => row.clientSpanID),
    "connection CLIENT",
  );
  const requests = [],
    initializations = [],
    sessions = [];
  for (const version of [1, 2])
    for (const kind of kinds) {
      const label = `v${version}-${kind}`;
      const phase =
        kind === "inflight" ? `v${version}-tool-inflight` : label + "-fault";
      const group = connections.filter(
        (row) => row.version === version && row.kind === kind,
      );
      assert.deepEqual(
        group.map((row) => row.role),
        kind === "inflight" ? roles : roles.slice(0, 3),
      );
      const sessionId = group[0].evidence[0]?.requestResult?.sessionId;
      nonempty(sessionId);
      sessions.push(sessionId);
      const other =
        kind === "inflight"
          ? group[0].evidence[1]?.requestResult?.sessionId
          : undefined;
      if (kind === "inflight") {
        nonempty(other);
        sessions.push(other);
      }
      const replay = replayRequest(version, sessionId);
      for (const c of group) {
        assert.equal(c.agentId, agentId);
        assert.match(c.connectionTraceID, /^[a-f0-9]{32}$/u);
        assert.match(c.clientSpanID, /^[a-f0-9]{16}$/u);
        checkConnection(c);
        initializations.push({
          ...structuredClone(c.initialization),
          version,
          kind: "request",
          label: `${label}-${c.role}-initialize`,
        });
        const calls =
          c.role === "prompt"
            ? [
                ["new", setup, "request", label + "-new", sessionId],
                ...(kind === "inflight"
                  ? [["new", setup, "request", label + "-other-new", other]]
                  : []),
                [
                  "prompt",
                  { sessionId, prompt: [{ type: "text", text: phase }] },
                  kind === "completed" ? "ordinary" : "interruption",
                  phase,
                  sessionId,
                ],
              ]
            : [
                [
                  replay.method,
                  replay.params,
                  "request",
                  c.role === "rebuild"
                    ? label + "-rebuild-replay"
                    : label + "-" + c.role,
                  sessionId,
                ],
                ...(c.role === "replay-1"
                  ? []
                  : kind === "inflight" && c.role === "replay-2"
                    ? [
                        [
                          "prompt",
                          {
                            sessionId: other,
                            prompt: [
                              { type: "text", text: "unresolved-denied" },
                            ],
                          },
                          "request",
                          label + "-denied",
                          other,
                          "runtime_barrier_required",
                        ],
                      ]
                    : [
                        [
                          "prompt",
                          {
                            sessionId,
                            prompt: [{ type: "text", text: label + "-post" }],
                          },
                          "ordinary",
                          label + "-post",
                          sessionId,
                        ],
                      ]),
              ];
        assert.equal(c.evidence.length, calls.length);
        for (const [
          i,
          [method, params, requestKind, requestLabel, target, rejection],
        ] of calls.entries()) {
          const row = c.evidence[i];
          assert.equal(row.method, "session/" + method);
          assert.deepEqual(row.requestParams, params);
          assert.equal(row.inputSessionID, params.sessionId ?? null);
          assert.equal(row.sessionId, target);
          const failed =
            rejection !== undefined ||
            (requestKind === "interruption" && version === 1);
          assert.equal(row.outcome, failed ? "failed" : "succeeded");
          if (method === "new")
            assert.equal(row.requestResult.sessionId, target);
          if (rejection) {
            assert.equal(row.failureCode, -32020);
            assert.deepEqual(row.failureData, {
              code: rejection,
              retryable: false,
            });
            assert.deepEqual(row.rejectionReceipt, {
              rpcCode: -32020,
              code: rejection,
              retryable: false,
            });
            const raw = c.raw_frames.filter(
              (frame) =>
                Object.hasOwn(frame, "id") &&
                String(frame.id) === row.requestId,
            );
            assert.equal(
              raw.length,
              1,
              "original barrier rejection reply required",
            );
            assert.equal(raw[0].error.code, row.failureCode);
            assert.deepEqual(raw[0].error.data, row.failureData);
          }
          requests.push({
            ...structuredClone(row),
            version,
            kind: requestKind,
            label: requestLabel,
            ...(["ordinary", "interruption"].includes(requestKind)
              ? { phase: requestLabel }
              : {}),
            ...(rejection ? { rejection } : {}),
          });
        }
      }
    }
  unique(sessions, "Session");
  assert.equal(requests.length, 46);
  assert.equal(initializations.length, 26);
  return { requests, initializations };
}
