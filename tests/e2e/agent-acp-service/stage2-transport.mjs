import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  context,
  propagation,
  trace,
  SpanKind,
} from "../../../services/agent-acp-service/node_modules/@opentelemetry/api/build/src/index.js";
import { NodeSDK } from "../../../services/agent-acp-service/node_modules/@opentelemetry/sdk-node/build/src/index.js";
import { OTLPTraceExporter } from "../../../services/agent-acp-service/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/index.js";
import * as acp from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/v2/acp.js";
import { createWebSocketStream } from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/ws-stream.js";
import WebSocket from "../../../services/agent-acp-service/node_modules/ws/wrapper.mjs";
import { assertPromptEvidence } from "./stage2-acp-evidence.mjs";

export async function waitFor(read, accept, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}

export function startClientTelemetry(endpoint) {
  const sdk = new NodeSDK({
    serviceName: "antnest-stage2-client",
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [],
  });
  sdk.start();
  return sdk;
}

export function traced(name, operation) {
  return trace
    .getTracer("antnest-stage2-client")
    .startActiveSpan(name, async (span) => {
      try {
        return await operation(span.spanContext().traceId);
      } finally {
        span.end();
      }
    });
}

export async function json(
  url,
  body,
  status = 200,
  headers = {},
  method = body === undefined ? "GET" : "POST",
) {
  return trace.getTracer("antnest-stage2-client").startActiveSpan(
    `HTTP ${method}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "server.address": new URL(url).hostname,
      },
    },
    async (span) => {
      const outgoing = { "content-type": "application/json", ...headers };
      propagation.inject(context.active(), outgoing);
      try {
        const response = await fetch(url, {
          method,
          headers: outgoing,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        span.setAttribute("http.response.status_code", response.status);
        const payload = await response.json();
        assert.equal(
          response.status,
          status,
          `${method} ${new URL(url).pathname}: ${JSON.stringify(payload)}`,
        );
        return payload;
      } finally {
        span.end();
      }
    },
  );
}

export function executionHeaders(organizationId, principalId, agentId) {
  return {
    "x-antnest-organization-id": organizationId,
    "x-antnest-principal-id": principalId,
    "x-antnest-agent-id": agentId,
  };
}

export async function openClient(url, headers, { promptContext = true } = {}) {
  const updates = [];
  const closed = new AbortController();
  const client = acp
    .client()
    .onNotification(acp.methods.client.session.update, ({ params }) =>
      updates.push(params),
    );
  class Socket extends WebSocket {
    constructor(...args) {
      super(...args);
      this.on("error", (error) => closed.abort(error));
    }
  }
  const transportHeaders = { ...headers };
  propagation.inject(context.active(), transportHeaders);
  const connection = client.connect(
    createWebSocketStream(url, {
      WebSocket: Socket,
      headers: transportHeaders,
    }),
  );
  connection.closed.then(
    () => closed.abort(new Error("ACP connection closed")),
    (error) => closed.abort(error),
  );
  const request = async (method, params) => {
    const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(30000)]);
    return connection.agent.request(method, params, {
      cancellationSignal: signal,
    });
  };
  try {
    await request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      info: { name: "antnest-stage2-e2e", version: "1.0.0" },
      capabilities: {},
    });
    await connection.initialized;
  } catch (error) {
    connection.close();
    await connection.closed.catch(() => {});
    throw error;
  }
  return {
    request,
    newSession: () =>
      request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      }),
    async prompt(sessionId) {
      const start = updates.length;
      const carrier = {};
      if (promptContext) propagation.inject(context.active(), carrier);
      const ack = await request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Create the Stage 2 acceptance evidence file.",
          },
        ],
        _meta: carrier,
      });
      const events = await waitFor(
        async () => {
          closed.signal.throwIfAborted();
          return updates
            .slice(start)
            .filter((item) => item.sessionId === sessionId);
        },
        (items) =>
          items.some(
            ({ update }) =>
              update.sessionUpdate === "state_update" &&
              update.state === "idle",
          ),
        "ACP prompt completion",
      );
      return {
        session_id: sessionId,
        message: assertPromptEvidence(ack, events, sessionId),
      };
    },
    async denied(sessionId, codes = ["access_denied", "agent_unavailable"]) {
      await assert.rejects(
        request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "This prompt must not be admitted." }],
        }),
        (error) => codes.includes(error?.data?.code),
      );
    },
    async close() {
      connection.close();
      await connection.closed.catch(() => {});
    },
  };
}
