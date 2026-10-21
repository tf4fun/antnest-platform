import assert from "node:assert/strict";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
import {
  openPrivateCommandConnection,
  withPrivateCommandConnection,
} from "../acp-commands/connection.mjs";

function identity(client, actual, label, kind, details = {}) {
  assert.equal(client.boundary, "private-acp");
  assert([1, 2].includes(client.version));
  assert(
    actual &&
      typeof actual.requestId === "string" &&
      actual.requestId.length > 0,
  );
  let inputSessionID;
  if (client.transport === "http") {
    assert.equal(client.version, 1);
    const sent = client
      .httpSnapshot()
      .requests.filter((item) => item.method === "POST");
    const matches = sent.filter(
      (item) => String(item.requestID) === actual.requestId,
    );
    assert.equal(matches.length, 1, "missing or repeated native HTTP request");
    const wire = matches[0];
    assert.strictEqual(wire, sent.at(-1), "stale native HTTP receipt");
    assert.equal(wire.rpcMethod, actual.method);
    for (const [key, value] of Object.entries({
      traceID: wire.traceID,
      clientSpanID: wire.clientSpanID,
      httpRequestIndex: wire.index,
      connectionID: wire.connectionID,
    }))
      assert.equal(actual[key], value, "foreign native HTTP identity");
    inputSessionID = wire.rpcSessionID ?? null;
  } else {
    assert.equal(client.transport, "websocket");
    const matches = client.requests.filter(
      (item) => item.requestId === actual.requestId,
    );
    assert.equal(matches.length, 1, "missing or repeated native SDK request");
    const wire = matches[0];
    assert.strictEqual(
      wire,
      client.requests.at(-1),
      "stale native SDK receipt",
    );
    assert.equal(wire.method, actual.method);
    inputSessionID = wire.sessionId ?? null;
  }
  if (Object.hasOwn(actual, "inputSessionID"))
    assert.equal(actual.inputSessionID, inputSessionID);
  const { rejection, phase, promptReceipt } = details;
  const sessionId = details.sessionId ?? actual.sessionId;
  if (rejection) {
    const expected = admissionErrorReceipt(rejection);
    assert.deepEqual(actual.rejectionReceipt, {
      rpcCode: expected.code,
      ...expected.data,
    });
  } else
    assert.equal(
      actual.rejectionReceipt,
      undefined,
      "denied request recorded as success",
    );
  if (
    actual.method === "initialize" ||
    (actual.method === "session/new" && rejection === "access_denied")
  ) {
    assert.equal(inputSessionID, null);
    assert.equal(sessionId, undefined);
  } else {
    assert(typeof sessionId === "string" && sessionId.length > 0);
    if (actual.method === "session/new") assert.equal(inputSessionID, null);
    else {
      assert(typeof inputSessionID === "string" && inputSessionID.length > 0);
      if (actual.method === "session/fork" && !rejection)
        assert.notEqual(sessionId, inputSessionID);
      else assert.equal(sessionId, inputSessionID);
    }
  }
  assert(["request", "native", "local-failure"].includes(kind));
  if (kind !== "request") {
    assert.equal(actual.method, "session/prompt");
    assert(typeof phase === "string" && phase.length > 0);
    assert.equal(promptReceipt?.requestId, actual.requestId);
    assert.equal(promptReceipt?.sessionId, sessionId);
  }
  return structuredClone({
    ...actual,
    label,
    kind,
    boundary: client.boundary,
    transport: client.transport,
    protocolVersion: client.version,
    version: client.version,
    agentId: client.agentId,
    ...(client.transport === "websocket"
      ? {
          connectionTraceID: client.connectionTraceID,
          clientSpanID: client.clientSpanID,
        }
      : {}),
    inputSessionID,
    sessionId,
    ...(rejection ? { rejection } : {}),
    ...(phase === undefined ? {} : { phase }),
    ...(promptReceipt === undefined ? {} : { promptReceipt }),
  });
}

export function nativeRequestKey(request) {
  const { transport, requestId } = request;
  assert(["http", "websocket"].includes(transport));
  const traceID =
    transport === "http" ? request.traceID : request.connectionTraceID;
  assert(typeof traceID === "string" && traceID.length > 0);
  assert(typeof requestId === "string" && requestId.length > 0);
  return JSON.stringify([transport, traceID, requestId]);
}

export function nativeRequestIdentity(
  client,
  label,
  kind = "request",
  details = {},
) {
  assert(
    client.lastRequest?.method.startsWith("session/"),
    "actual native SDK request required",
  );
  return identity(client, client.lastRequest, label, kind, details);
}

export async function openPrivateNativeConnection(
  profile,
  agentId,
  browser,
  options,
) {
  const client = await openPrivateCommandConnection(
    profile,
    agentId,
    browser,
    options,
  );
  try {
    const result = client.initializationResult;
    const capabilities =
      profile.version === 1
        ? result?.agentCapabilities?.promptCapabilities
        : result?.capabilities?.session?.prompt;
    for (const name of ["image", "audio", "embeddedContext"])
      assert(
        profile.version === 1
          ? capabilities?.[name] === true
          : capabilities?.[name] !== null &&
              typeof capabilities?.[name] === "object" &&
              !Array.isArray(capabilities[name]),
        `missing ${name} capability`,
      );
    let actual;
    if (client.transport === "http") {
      const sent = client
        .httpSnapshot()
        .requests.filter((item) => item.method === "POST");
      assert.equal(sent.length, 1, "one actual native initialization required");
      const initial = sent[0];
      assert.equal(initial.rpcMethod, "initialize");
      actual = {
        method: "initialize",
        requestId: String(initial.requestID),
        traceID: initial.traceID,
        clientSpanID: initial.clientSpanID,
        connectionID: initial.connectionID,
        httpRequestIndex: initial.index,
      };
    } else {
      assert.equal(
        client.requests.length,
        1,
        "one actual native initialization required",
      );
      actual = client.requests[0];
      assert.equal(actual.method, "initialize");
    }
    client.initializationRequest = identity(
      client,
      actual,
      `${profile.name}:initialize`,
      "request",
    );
    return client;
  } catch (error) {
    return withPrivateCommandConnection(client, [], async () => {
      throw error;
    });
  }
}

export function nativePromptReceipt(
  client,
  sessionId,
  { result = null, error = null, failed = false },
) {
  const actual = client.lastRequest;
  assert.equal(actual?.method, "session/prompt");
  assert.equal(actual.inputSessionID, sessionId);
  assert(typeof actual.requestId === "string" && actual.requestId.length > 0);
  assert(
    client.updates.every((frame) => frame.sessionId === sessionId),
    "foreign prompt Session update",
  );
  let failure = null;
  const terminals = client.updates.filter(
    ({ update }) =>
      update.sessionUpdate === "state_update" && update.state === "idle",
  );
  if (client.version === 1) {
    assert.deepEqual(terminals, []);
    if (failed) {
      failure = {
        rpcCode: error?.code,
        code: error?.data?.code,
        retryable: error?.data?.retryable,
      };
      assert.deepEqual(failure, {
        rpcCode: -32022,
        code: "model_unsupported_content",
        retryable: false,
      });
      assert.equal(result, null);
    } else {
      assert.equal(error, null);
      assert.deepEqual(result, { stopReason: "end_turn" });
    }
  } else {
    assert.equal(client.version, 2);
    assert.equal(error, null);
    assert.deepEqual(Object.keys(result ?? {}), ["messageId"]);
    assert(typeof result.messageId === "string" && result.messageId.length > 0);
    assert.deepEqual(terminals, [
      {
        sessionId,
        update: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: failed ? "_failed" : "end_turn",
        },
      },
    ]);
  }
  return structuredClone({
    requestId: actual.requestId,
    sessionId,
    result,
    error: failure,
    terminals,
  });
}
