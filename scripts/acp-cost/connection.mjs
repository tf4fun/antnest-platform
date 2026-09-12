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
import { observeWire } from "./wire.mjs";
import {
  assertPublicFrames,
  assertOperationUpdates,
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

export async function connect(profile, agent, member) {
  const acp = profile.version === 1 ? v1 : v2;
  const traceID = randomBytes(16).toString("hex"),
    updates = [],
    frames = [],
    sessions = new Set();
  let cursor = 0;
  const headers = {
    Cookie: member.cookie,
    Origin: gateway,
    "X-Antnest-CSRF-Token": member.cookies.get("antnest_csrf"),
    traceparent: `00-${traceID}-${randomBytes(8).toString("hex")}-01`,
  };
  const stream = profile.http
    ? createHttpStream(`${gateway}/api/app/agents/${agent}/v1/acp`, { headers })
    : createWebSocketStream(
        `${gateway.replace("http:", "ws:")}/api/app/agents/${agent}/v${profile.version}/acp`,
        { headers, WebSocket },
      );
  const connection = acp
    .client()
    .onNotification(acp.methods.client.session.update, () => {})
    .connect(observeWire(stream, updates, frames));
  const request = (method, params, timeout = 15000) =>
    connection.agent.request(method, params, {
      signal: AbortSignal.timeout(timeout),
    });
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
        return updates.slice(cursor);
      },
      checkpoint() {
        validate(client, profile);
        assert(
          updates.every((update) => sessions.has(update.sessionId)),
          "unowned Session notification",
        );
        cursor = updates.length;
      },
      close: () => connection.close(),
      request: async (name, params, timeout) => {
        const start = updates.length;
        try {
          const result = await request(
            acp.methods.agent.session[name],
            params,
            timeout,
          );
          assertOperationUpdates(name, params, result, updates.slice(start));
          if (result.sessionId) sessions.add(result.sessionId);
          if (params.sessionId) sessions.add(params.sessionId);
          return result;
        } finally {
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
  for (const { update } of client.updates)
    assert(
      validators[profile.version - 1](update),
      "invalid official SessionUpdate schema",
    );
  assert(
    !client.updates.some(({ update }) =>
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
