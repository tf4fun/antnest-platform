import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import type { Pool } from "pg";
import { expect } from "vitest";

import { OpenAICompatibleModel } from "../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { identityHeaders } from "../../../../services/agent-acp-service/test/support/fixtures.js";
import { startBoundaryApplication } from "./postgres-boundary-application.js";

export const CONTEXT_PRIMARY_MODEL = "context-wire-primary";
export const CONTEXT_SUMMARY_MODEL = "context-wire-summary";
export const CONTEXT_PROVIDER_SECRET = "synthetic-context-provider-secret";
// Sentinels verify usage/cost transport and persistence, not tokenizer accuracy.
export const CONTEXT_PROVIDER_USAGE = {
  prompt_tokens: 17,
  completion_tokens: 11,
  total_tokens: 28,
  cost: 0.000039,
  cost_currency: "USD",
};

export type ContextWireRequest = {
  model: string;
  messages: { role: string; content: unknown; pinned?: unknown }[];
  stream: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: unknown[];
  max_tokens: number;
};
type Scenario = {
  task: string;
  reply: string;
  summary: string;
  overflow: "once" | "always" | "never";
  failSummary?: boolean;
};
type Observation = { request: ContextWireRequest; status: number };
export type ContextHttpProvider = {
  baseUrl: string;
  requests: Observation[];
};

async function end(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, {
    "content-type": status === 200 ? "text/event-stream" : "application/json",
  });
  await new Promise<void>((resolve, reject) => {
    response.once("finish", resolve);
    response.once("error", reject);
    response.once("close", () => {
      if (!response.writableFinished)
        reject(new Error("Context Provider response closed before finish"));
    });
    response.end(body);
  });
}

function completion(content: string): string {
  const at = Math.ceil(content.length / 2);
  const frames = [
    {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: content.slice(0, at) },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { content: content.slice(at) },
          finish_reason: "stop",
        },
      ],
    },
    { choices: [], usage: CONTEXT_PROVIDER_USAGE },
  ];
  return (
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

export async function withContextHttpProvider(
  scenario: Scenario,
  operation: (provider: ContextHttpProvider) => Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  const originals: Promise<void>[] = [];
  const sockets = new Set<Socket>();
  const requests: Observation[] = [];
  let foreground = 0;
  let overflowSent = false;
  const server = createServer((request, response) => {
    const original = (async () => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe(
        `Bearer ${CONTEXT_PROVIDER_SECRET}`,
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const part = Buffer.from(chunk as Uint8Array);
        bytes += part.length;
        if (bytes > 64 * 1024)
          throw new Error("Context fixture request exceeded its body limit");
        chunks.push(part);
      }
      const body = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as ContextWireRequest;
      expect(body.stream).toBe(true);
      expect(body.stream_options?.include_usage).toBe(true);
      expect(body.max_tokens).toBeGreaterThan(0);
      expect(Array.isArray(body.messages)).toBe(true);
      expect(body.messages.every((message) => !("pinned" in message))).toBe(
        true,
      );
      const observed = { request: body, status: 200 };
      requests.push(observed);
      if (requests.length > 200 * 8)
        throw new Error("Unexpected context Provider request storm");
      if (body.model === CONTEXT_SUMMARY_MODEL) {
        expect(body.tools).toBeUndefined();
        if (scenario.failSummary) {
          observed.status = 500;
          await end(response, 500, JSON.stringify({ error: "summary failed" }));
        } else await end(response, 200, completion(scenario.summary));
        return;
      }
      expect(body.model).toBe(CONTEXT_PRIMARY_MODEL);
      expect(JSON.stringify(body.messages)).toContain(scenario.task);
      if (
        scenario.overflow === "always" ||
        (scenario.overflow === "once" && foreground === 80 && !overflowSent)
      ) {
        overflowSent = true;
        observed.status = 400;
        await end(
          response,
          400,
          JSON.stringify({ error: { code: "context_length_exceeded" } }),
        );
        return;
      }
      foreground += 1;
      await end(response, 200, completion(scenario.reply));
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
    originals.push(original);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const collect = async (operation: Promise<unknown>) => {
    try {
      await operation;
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing context Provider listener");
    await operation({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requests,
    });
  } catch (error) {
    errors.push(error);
  } finally {
    // Forced fixture teardown cannot stand in for original transport cleanup.
    await collect(expect.poll(() => sockets.size, { timeout: 2000 }).toBe(0));
    if (server.listening) {
      const closing = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await collect(closing);
    }
    await Promise.all(originals);
    await collect(
      Promise.resolve().then(() => {
        expect(server.address()).toBeNull();
        expect(sockets.size).toBe(0);
      }),
    );
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "Context HTTP Provider business or original cleanup failed",
    );
}

export async function withContextProtocolApplication(
  provider: ContextHttpProvider,
  pool: Pool,
  operation: (fixture: {
    connection: acp.ClientConnection;
    updates: acp.SessionUpdate[];
  }) => Promise<void>,
  maxModelRequests = 8,
): Promise<void> {
  const configuration = executionConfiguration();
  configuration.providers[0]!.base_url = provider.baseUrl;
  configuration.providers[0]!.credential.secret = CONTEXT_PROVIDER_SECRET;
  const primary = configuration.models[0]!;
  Object.assign(primary, {
    model: CONTEXT_PRIMARY_MODEL,
    context_window: 8192,
    max_output_tokens: 256,
    tokenizer: "none",
    compaction_model_profile_id: "wire-summary-profile",
  });
  const summary = {
    ...structuredClone(primary),
    model_profile_id: "wire-summary-profile",
    model: CONTEXT_SUMMARY_MODEL,
    max_output_tokens: 512,
  };
  delete summary.compaction_model_profile_id;
  configuration.models.push(summary);
  for (const agent of configuration.agents) {
    agent.model_retry = { max: 0, base_ms: 1, cap_ms: 1 };
    agent.max_model_requests = maxModelRequests;
  }
  const app = await startBoundaryApplication(pool, undefined, {
    configuration,
    modelTransport: new OpenAICompatibleModel({
      destination: { allowPrivateEndpoints: true },
    }),
  });
  const errors: unknown[] = [];
  const updates: acp.SessionUpdate[] = [];
  let connection: acp.ClientConnection | undefined;
  try {
    connection = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .connect(
        createHttpStream(app.httpUrl, {
          headers: identityHeaders(app.identity()),
        }),
      );
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await operation({ connection, updates });
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      connection?.close();
      await connection?.closed;
    } catch (error) {
      errors.push(error);
    }
    try {
      await app.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      expect(app.model.complete.mock.calls.length).toBe(0);
      expect(app.tools.call).not.toHaveBeenCalled();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "ACP context HTTP business or original cleanup failed",
    );
}
