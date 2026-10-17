import assert from "node:assert/strict";
import {
  openPrivateCommandConnection,
  withPrivateCommandConnection,
} from "../acp-commands/connection.mjs";
import { caseFor } from "./model.mjs";

function identity(client, actual, method, sessionId, { phase, denial } = {}) {
  assert.equal(client.boundary, "private-acp");
  assert.equal(client.transport, "websocket");
  assert([1, 2].includes(client.version));
  assert.equal(actual?.method, method, "actual File SDK request missing");
  assert(typeof actual.requestId === "string" && actual.requestId.length > 0);
  const wire = client.requests.filter(
    (item) => item.requestId === actual.requestId,
  );
  assert.equal(wire.length, 1, "duplicate or missing File wire request");
  assert.equal(wire[0].method, method);
  assert.equal(wire[0], client.requests.at(-1), "stale File request receipt");
  const inputSessionID = wire[0].sessionId ?? null;
  if (Object.hasOwn(actual, "inputSessionID"))
    assert.equal(actual.inputSessionID, inputSessionID);
  if (denial)
    assert.deepEqual(actual.rejectionReceipt, {
      rpcCode: -32020,
      code: denial,
      retryable: false,
    });
  else
    assert.equal(
      actual.rejectionReceipt,
      undefined,
      "denied request cannot be recorded as success",
    );
  if (
    method === "initialize" ||
    (method === "session/new" && denial === "access_denied")
  ) {
    assert.equal(sessionId, undefined);
    assert.equal(inputSessionID, null);
  } else {
    assert(typeof sessionId === "string" && sessionId.trim().length > 0);
    if (method === "session/new") assert.equal(inputSessionID, null);
    else {
      assert(typeof inputSessionID === "string" && inputSessionID.length > 0);
      if (method === "session/fork" && !denial)
        assert.notEqual(sessionId, inputSessionID);
      else assert.equal(sessionId, inputSessionID);
    }
  }
  if (phase !== undefined) {
    assert.equal(method, "session/prompt");
    assert(phase.startsWith(`v${client.version}-`));
    caseFor(phase);
  }
  return structuredClone({
    ...actual,
    boundary: client.boundary,
    transport: client.transport,
    protocolVersion: client.version,
    agentId: client.agentId,
    connectionTraceID: client.connectionTraceID,
    clientSpanID: client.clientSpanID,
    inputSessionID,
    sessionId,
    ...(phase === undefined ? {} : { phase }),
    ...(denial === undefined ? {} : { denial }),
  });
}

export function fileRequestIdentity(client, method, sessionId, details) {
  return identity(client, client.lastRequest, method, sessionId, details);
}

export async function openPrivateFileConnection(
  version,
  agentId,
  browser,
  options,
) {
  assert([1, 2].includes(version));
  const client = await openPrivateCommandConnection(
    { version },
    agentId,
    browser,
    options,
  );
  try {
    assert.equal(client.requests.length, 1, "one actual initialize required");
    client.initializationRequest = identity(
      client,
      client.requests[0],
      "initialize",
      undefined,
    );
    return client;
  } catch (error) {
    return withPrivateCommandConnection(client, [], async () => {
      throw error;
    });
  }
}
