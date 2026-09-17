import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { gateway } from "../identity-closeout/acp-connection.mjs";
import { observeSocket, requestWithin } from "../acp-closeout/connection.mjs";
import { until } from "../acp-closeout/support.mjs";
import { observeStream, observeFetch } from "../acp-commands/transport.mjs";
import { observeWire } from "./wire.mjs";
import {
  assertPublicFrames,
  assertOperationUpdates,
  operationUpdates,
  rememberSelection,
  assertModelSelection,
} from "./evidence.mjs";

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

export async function connect(profile, agent, member, evidence = []) {
  const acp = profile.version === 1 ? v1 : v2;
  const traceID = randomBytes(16).toString("hex"),
    updates = [],
    frames = [],
    sessions = new Set(),
    selections = new Map();
  let cursor = 0,
    windowSession;
  const observed = [],
    closed = new AbortController();
  const headers = {
    Cookie: member.cookie,
    Origin: gateway,
    "X-Antnest-CSRF-Token": member.cookies.get("antnest_csrf"),
  };
  const stream = profile.http
    ? createHttpStream(`${gateway}/api/app/agents/${agent}/v1/acp`, {
        headers,
        fetch: observeFetch(fetch, observed),
      })
    : observeStream(
        createWebSocketStream(
          `${gateway.replace("http:", "ws:")}/api/app/agents/${agent}/v${profile.version}/acp`,
          {
            headers: {
              ...headers,
              traceparent: `00-${traceID}-${randomBytes(8).toString("hex")}-01`,
            },
            WebSocket: observeSocket(WebSocket, closed, () => undefined),
          },
        ),
        observed,
      );
  const connection = acp
    .client()
    .onNotification(acp.methods.client.session.update, () => {})
    .connect(observeWire(stream, updates, frames));
  const request = (method, params, timeout = 15000) =>
    requestWithin(
      (options) => connection.agent.request(method, params, options),
      closed.signal,
      () => connection.close(),
      timeout,
    );
  try {
    await request(
      acp.methods.agent.initialize,
      profile.version === 1
        ? { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }
        : {
            protocolVersion: acp.PROTOCOL_VERSION,
            info: { name: "cost-e2e", version: "1" },
            capabilities: {},
          },
    );
    const client = {
      traceID,
      frames,
      get updates() {
        return operationUpdates(
          updates.slice(cursor),
          windowSession,
          selections,
        );
      },
      get rawUpdates() {
        return updates.slice(cursor);
      },
      checkpoint(sessionId) {
        validate(client, profile);
        assert(
          updates.every((update) => sessions.has(update.sessionId)),
          "unowned Session notification",
        );
        cursor = updates.length;
        windowSession = sessionId;
      },
      close: () => connection.close(),
      request: async (name, params, timeout) => {
        const start = updates.length,
          offset = observed.length;
        let response, rejection;
        try {
          const result = (response = await request(
            acp.methods.agent.session[name],
            params,
            timeout,
          ));
          assertOperationUpdates(
            name,
            params,
            result,
            updates.slice(start),
            selections,
          );
          rememberSelection(selections, name, params, result);
          if (result.sessionId) sessions.add(result.sessionId);
          if (params.sessionId) sessions.add(params.sessionId);
          return result;
        } catch (error) {
          rejection = error.data?.code;
          throw error;
        } finally {
          await until(
            () => observed.length > offset,
            "actual SDK request",
            5000,
          );
          assert.equal(observed.length - offset, 1);
          client.lastRequest = {
            ...observed[offset],
            sessionId:
              ["new", "fork"].includes(name) && response
                ? response.sessionId
                : params.sessionId,
            agentId: agent,
            version: profile.version,
            transport: profile.http ? "http" : "websocket",
            ...(profile.http ? {} : { connectionTraceID: traceID }),
            kind: "request",
            label: `${profile.name}:${name}`,
            ...(rejection ? { rejection } : {}),
          };
          evidence.push(client.lastRequest);
          validate(client, profile);
        }
      },
    };
    return client;
  } catch (error) {
    connection.close();
    throw error;
  }
}

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
}
