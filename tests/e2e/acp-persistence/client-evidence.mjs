import assert from "node:assert/strict";
import { inspect } from "node:util";
import { replayRequest } from "../managed-mcp/protocol.mjs";

const setup = { cwd: "/workspace", mcpServers: [] };
const phases = ["intent", "accept", "finish"];
const roles = ["prompt", "replay-1", "replay-2"];
const nonempty = (value) =>
  assert(typeof value === "string" && value.length > 0);
const unique = (values, label) =>
  assert.equal(
    new Set(values).size,
    values.length,
    `duplicate Persistence ${label}`,
  );
function fail(errors) {
  const all = [...new Set(errors)];
  if (all.length === 1) throw all[0];
  if (all.length)
    throw new AggregateError(
      all,
      "Persistence request, evidence or cleanup failed",
    );
}
function identity(client, actual, method, inputSessionID) {
  assert.equal(actual?.method, method, "actual Persistence request required");
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
  assert.equal(
    connection.closed,
    true,
    "Persistence connection has not joined",
  );
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
      assert.equal(row[key], value, `foreign Persistence request ${key}`);
    assert.equal(
      row.closedBeforeResponse,
      undefined,
      "Persistence cannot borrow a deliberate-close exception",
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
        "successful Persistence response missing or duplicated",
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
        "failed Persistence request has a conflicting response",
      );
    }
  }
}

// The existing shared connection owns delegation and SDK handling. This recorder
// owns original business inputs/results and joins their private archive on error.
export function createPersistenceRecorder(client, meta, preserve) {
  assert.equal(
    typeof preserve,
    "function",
    "Persistence private archive required",
  );
  assert.equal(client.boundary, "private-acp");
  assert.equal(client.transport, "websocket");
  assert.equal(client.agentId, meta.agentId);
  assert.equal(client.version, meta.version);
  assert(
    [1, 2].includes(meta.version) &&
      phases.includes(meta.phase) &&
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
        "Persistence request overlap or closed connection",
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
        }
        row.outcome = failed ? "failed" : "succeeded";
        if (!failed) row.requestResult = structuredClone(result);
        row.sessionId = input.sessionId ?? result?.sessionId;
        try {
          const actual = client.requests.slice(offset);
          assert.equal(
            actual.length,
            1,
            "missing or overlapping Persistence wire request",
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

export function indexPersistenceRequests({ agentId, connections }) {
  nonempty(agentId);
  assert.equal(connections.length, 18);
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
    for (const phase of phases) {
      const label = `v${version}-${phase}`;
      const group = connections.filter(
        (row) => row.version === version && row.phase === phase,
      );
      assert.deepEqual(
        group.map((row) => row.role),
        roles,
      );
      const sessionId = group[0].evidence[0]?.requestResult?.sessionId;
      nonempty(sessionId);
      sessions.push(sessionId);
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
        const replay = replayRequest(version, sessionId);
        const calls =
          c.role === "prompt"
            ? [
                ["new", setup, "request", label + "-new"],
                [
                  "prompt",
                  {
                    sessionId,
                    prompt: [{ type: "text", text: label + "-fault" }],
                  },
                  "fault",
                  label + "-fault",
                ],
              ]
            : [
                [replay.method, replay.params, "request", label + "-" + c.role],
                ...(c.role === "replay-2"
                  ? [
                      [
                        "prompt",
                        {
                          sessionId,
                          prompt: [{ type: "text", text: label + "-post" }],
                        },
                        "ordinary",
                        label + "-post",
                      ],
                    ]
                  : []),
              ];
        assert.equal(c.evidence.length, calls.length);
        for (const [
          i,
          [method, params, kind, requestLabel],
        ] of calls.entries()) {
          const row = c.evidence[i];
          assert.equal(row.method, "session/" + method);
          assert.deepEqual(row.requestParams, params);
          assert.equal(row.inputSessionID, params.sessionId ?? null);
          assert.equal(row.sessionId, sessionId);
          const failed =
            kind === "fault" && !(version === 2 && phase === "finish");
          assert.equal(row.outcome, failed ? "failed" : "succeeded");
          if (method === "new")
            assert.equal(row.requestResult.sessionId, sessionId);
          requests.push({
            ...structuredClone(row),
            version,
            kind,
            label: requestLabel,
            ...(kind === "fault"
              ? { phase }
              : kind === "ordinary"
                ? { phase: requestLabel }
                : {}),
          });
        }
      }
    }
  unique(sessions, "Session");
  assert.equal(requests.length, 30);
  assert.equal(initializations.length, 18);
  return { requests, initializations };
}
