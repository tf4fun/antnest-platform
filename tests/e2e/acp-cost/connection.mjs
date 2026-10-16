import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import {
  openPrivateCommandConnection,
  withPrivateCommandConnection,
} from "../acp-commands/connection.mjs";
import {
  assertPublicFrames,
  assertOperationUpdates,
  operationUpdates,
  rememberSelection,
  assertModelSelection,
} from "./evidence.mjs";
import { bindCostConfiguration } from "./client-evidence.mjs";

export const setup = { cwd: "/workspace", mcpServers: [] };
export const profiles = [
  { name: "v1-ws", version: 1 },
  { name: "v2-ws", version: 2 },
  { name: "v1-http", version: 1, http: true },
];
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionUpdate",
    $defs: schema.$defs,
  }),
);

function requestIdentity(
  client,
  actual,
  { label, sessionId, rejection, failed = false } = {},
) {
  assert.equal(client.boundary, "private-acp");
  assert(typeof actual?.requestId === "string" && actual.requestId.length > 0);
  let inputSessionID;
  if (client.transport === "http") {
    const posts = client
      .httpSnapshot()
      .requests.filter((row) => row.method === "POST");
    const matches = posts.filter(
      (row) => String(row.requestID) === actual.requestId,
    );
    assert.equal(
      matches.length,
      1,
      "actual Cost HTTP request missing or duplicated",
    );
    const row = matches[0];
    assert.strictEqual(row, posts.at(-1), "stale Cost HTTP receipt");
    assert.equal(actual.method, row.rpcMethod);
    for (const [key, value] of Object.entries({
      traceID: row.traceID,
      clientSpanID: row.clientSpanID,
      httpRequestIndex: row.index,
      connectionID: row.connectionID,
    }))
      assert.equal(actual[key], value, "foreign Cost HTTP identity");
    inputSessionID = row.rpcSessionID ?? null;
  } else {
    assert.equal(client.transport, "websocket");
    const matches = client.requests.filter(
      (row) => row.requestId === actual.requestId,
    );
    assert.equal(
      matches.length,
      1,
      "actual Cost SDK request missing or duplicated",
    );
    assert.strictEqual(
      matches[0],
      client.requests.at(-1),
      "stale Cost SDK receipt",
    );
    assert.equal(actual.method, matches[0].method);
    inputSessionID = matches[0].sessionId ?? null;
  }
  if (Object.hasOwn(actual, "inputSessionID"))
    assert.equal(actual.inputSessionID, inputSessionID);
  if (rejection)
    assert.deepEqual(actual.rejectionReceipt, {
      rpcCode: -32020,
      code: rejection,
      retryable: false,
    });
  else
    assert.equal(
      actual.rejectionReceipt,
      undefined,
      "Cost rejection recorded as success",
    );
  if (
    ["initialize", "session/list"].includes(actual.method) ||
    (actual.method === "session/new" && (rejection || failed))
  ) {
    assert.equal(inputSessionID, null);
    assert.equal(sessionId, undefined);
  } else {
    assert(typeof sessionId === "string" && sessionId.length > 0);
    if (actual.method === "session/new") assert.equal(inputSessionID, null);
    else if (actual.method === "session/fork" && !rejection && !failed) {
      assert(typeof inputSessionID === "string" && inputSessionID.length > 0);
      assert.notEqual(sessionId, inputSessionID);
    } else assert.equal(sessionId, inputSessionID);
  }
  return structuredClone({
    ...actual,
    boundary: "private-acp",
    version: client.version,
    protocolVersion: client.version,
    agentId: client.agentId,
    transport: client.transport,
    inputSessionID,
    sessionId,
    kind: "request",
    outcome: rejection ? "rejected" : failed ? "failed" : "succeeded",
    label,
    ...(client.transport === "websocket"
      ? {
          connectionTraceID: client.connectionTraceID,
          clientSpanID: client.clientSpanID,
        }
      : {}),
    ...(rejection ? { rejection } : {}),
  });
}

export async function openPrivateCostConnection(
  profile,
  agent,
  member,
  evidence = [],
  options = {},
) {
  assert(Array.isArray(evidence), "Cost request inventory required");
  const transport = await openPrivateCommandConnection(profile, agent, member, {
    ...options,
    captureRawFrames: true,
  });
  const client = Object.create(transport);
  const records = [],
    pending = new Set(),
    sessions = new Set(),
    selections = new Map();
  let cursor = 0,
    windowSession,
    closing;
  const allUpdates = () =>
    transport.rawFrames
      .filter((frame) => frame.method === "session/update")
      .map((frame) => structuredClone(frame.params));
  Object.defineProperties(client, {
    frames: { enumerable: true, value: transport.rawFrames },
    updates: {
      enumerable: true,
      get: () =>
        operationUpdates(allUpdates().slice(cursor), windowSession, selections),
    },
    rawUpdates: { enumerable: true, get: () => allUpdates().slice(cursor) },
  });
  client.checkpoint = (sessionId) => {
    validate(client, profile);
    const updates = allUpdates();
    assert(
      updates.every((update) => sessions.has(update.sessionId)),
      "unowned Session notification",
    );
    cursor = updates.length;
    windowSession = sessionId;
  };
  client.closeAndWait = () => {
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        const errors = [];
        try {
          await transport.closeAndWait();
        } catch (error) {
          errors.push(error);
        }
        // Closing the transport first settles admitted RPCs. Their original
        // failures remain on the request promises; cleanup joins all wrappers
        // before attaching one final snapshot to the complete record inventory.
        while (pending.size) await Promise.allSettled([...pending]);
        try {
          validate(client, profile);
          assert(
            allUpdates().every((update) => sessions.has(update.sessionId)),
            "unowned Session notification",
          );
        } catch (error) {
          errors.push(error);
        }
        try {
          if (transport.transport === "http") {
            const snapshot = transport.httpSnapshot();
            for (const record of [client.initializationRequest, ...records])
              record.httpConnection = snapshot;
          }
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length)
          throw new AggregateError(errors, "Cost connection cleanup failed");
      });
      void closing.catch(() => {});
    }
    return closing;
  };
  client.close = client.closeAndWait;
  client.request = (name, params, timeout) => {
    if (closing) return Promise.reject(new Error("Cost connection is closing"));
    if (pending.size) return Promise.reject(new Error("Cost request overlap"));
    const task = request(name, params, timeout);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  async function request(name, params, timeout) {
    // Keep the exact parameters sent to this SDK request even if its caller
    // mutates the original object while the transport is awaiting a response.
    params = structuredClone(params);
    const start = allUpdates().length,
      previous = transport.lastRequest;
    const errors = [];
    let result,
      failed = false;
    try {
      result = await transport.request(name, params, timeout);
    } catch (error) {
      failed = true;
      errors.push(error);
    }
    if (!failed)
      try {
        assertOperationUpdates(
          name,
          params,
          result,
          allUpdates().slice(start),
          selections,
        );
        rememberSelection(selections, name, params, result);
        if (result.sessionId) sessions.add(result.sessionId);
        if (params.sessionId) sessions.add(params.sessionId);
      } catch (error) {
        errors.push(error);
      }
    try {
      if (transport.lastRequest && transport.lastRequest !== previous) {
        client.lastRequest = requestIdentity(transport, transport.lastRequest, {
          label: profile.name + ":" + name,
          sessionId:
            ["new", "fork"].includes(name) && result
              ? result.sessionId
              : params.sessionId,
          rejection: failed
            ? transport.lastRequest.rejectionReceipt?.code
            : undefined,
          failed,
        });
        if (!failed)
          client.lastRequest.requestReceipt = structuredClone({
            requestId: client.lastRequest.requestId,
            params,
            result,
          });
        records.push(client.lastRequest);
        evidence.push(client.lastRequest);
      }
      validate(client, profile);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, "Cost request and evidence failed");
    return result;
  }
  try {
    let actual;
    if (transport.transport === "http") {
      const posts = transport
        .httpSnapshot()
        .requests.filter((row) => row.method === "POST");
      assert.equal(posts.length, 1, "one actual Cost initialization required");
      const row = posts[0];
      actual = {
        method: row.rpcMethod,
        requestId: String(row.requestID),
        traceID: row.traceID,
        clientSpanID: row.clientSpanID,
        httpRequestIndex: row.index,
        connectionID: row.connectionID,
      };
    } else {
      assert.equal(
        transport.requests.length,
        1,
        "one actual Cost initialization required",
      );
      actual = transport.requests[0];
    }
    assert.equal(actual.method, "initialize");
    client.initializationRequest = requestIdentity(transport, actual, {
      label: profile.name + ":initialize",
    });
    client.initializationRequest.initializationResult = structuredClone(
      transport.initializationResult,
    );
    validate(client, profile);
    return client;
  } catch (error) {
    return withPrivateCommandConnection(transport, [], async () => {
      throw error;
    });
  }
}

export const connect = openPrivateCostConnection;

export function validate(client, profile) {
  assertPublicFrames(client.frames);
  for (const { update } of client.rawUpdates ?? client.updates)
    assert(
      validators[profile.version - 1](update),
      "invalid official SessionUpdate schema",
    );
  assert(
    !(client.rawUpdates ?? client.updates).some(({ update }) =>
      ["tool_call", "tool_call_update"].includes(update.sessionUpdate),
    ),
    "unexpected Tool execution",
  );
}

export async function setModel(client, profile, sessionId, value) {
  const result = await client.request("setConfigOption", {
    sessionId,
    configId: "model",
    value,
    ...(profile.version === 2 ? { type: "id" } : {}),
  });
  assertModelSelection(result, value);
  bindCostConfiguration(client, sessionId, value);
}
