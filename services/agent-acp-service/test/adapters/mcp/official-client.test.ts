import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { OfficialMcpDialer } from "../../../src/adapters/mcp/official-client.js";

describe("OfficialMcpDialer", () => {
  let fixture: Awaited<ReturnType<typeof startMcpFixture>> | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("negotiates the pinned protocol and executes a Tool through the official SDK", async () => {
    fixture = await startMcpFixture();
    const connection = await new OfficialMcpDialer({ trust: "runtime" }).connect({
      endpoint: fixture.endpoint,
      headers: { "x-antnest-expected-execution-id": "execution-1" },
      signal: AbortSignal.timeout(5_000),
    });

    try {
      const tools = await connection.listTools(AbortSignal.timeout(5_000));
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: "echo",
        description: "Echo text",
        annotations: { readOnlyHint: true, destructiveHint: false },
      });
      expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
      await expect(
        connection.callTool(
          { name: "echo", arguments: { text: "hello" } },
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toEqual({
        content: [{ type: "text", text: "hello" }],
        isError: false,
        meta: {
          "io.modelcontextprotocol/serverInfo": { name: "official-client-test", version: "1.0.0" },
        },
        structuredContent: {
          effect_source: null,
          effect_state: "settled",
          echoed: "hello",
        },
      });
      expect(fixture.executionIds).toEqual(["execution-1", "execution-1", "execution-1"]);
      const first = await connection.readResource(
        "antnest://runtime/info",
        AbortSignal.timeout(5000),
      );
      const second = await connection.readResource(
        "antnest://runtime/info",
        AbortSignal.timeout(5000),
      );
      expect(first).toMatchObject({
        contents: [{ uri: "antnest://runtime/info", mimeType: "application/json" }],
      });
      expect(second).not.toEqual(first);
      expect(fixture.executionIds).toHaveLength(5);
    } finally {
      await connection.close();
    }
  });
});

async function startMcpFixture(): Promise<{
  endpoint: URL;
  executionIds: string[];
  close(): Promise<void>;
}> {
  const executionIds: string[] = [];
  let resourceReads = 0;
  const handler = createMcpHandler(
    (context) => {
      executionIds.push(
        context.requestInfo?.headers.get("x-antnest-expected-execution-id") ?? "missing",
      );
      const server = new McpServer({ name: "official-client-test", version: "1.0.0" });
      server.registerResource(
        "runtime-info",
        "antnest://runtime/info",
        { mimeType: "application/json" },
        (uri) => {
          resourceReads++;
          return {
            contents: [
              {
                uri: uri.toString(),
                mimeType: "application/json",
                text: JSON.stringify({ read: resourceReads }),
              },
            ],
          };
        },
      );
      server.registerTool(
        "echo",
        {
          description: "Echo text",
          annotations: { readOnlyHint: true, destructiveHint: false },
          inputSchema: z.object({ text: z.string() }),
        },
        ({ text }) =>
          Promise.resolve({
            content: [{ type: "text", text }],
            structuredContent: {
              echoed: text,
              effect_state: "settled",
              effect_source: null,
            },
          }),
      );
      return server;
    },
    { legacy: "reject" },
  );
  const server = createServer((request, response) => {
    void forwardRequest(request, response, handler);
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("MCP fixture has no TCP address");
  }
  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}/mcp`),
    executionIds,
    close: async () => {
      await handler.close();
      await closeServer(server);
    },
  };
}

async function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: McpHttpHandler,
): Promise<void> {
  try {
    const body = await readBody(request);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(name, item);
        }
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method ?? "GET",
      headers,
    };
    if (body.length > 0) {
      init.body = new Uint8Array(body);
      init.duplex = "half";
    }
    const result = await handler.fetch(
      new Request(`http://${request.headers.host}${request.url ?? "/"}`, init),
    );
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500).end();
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
