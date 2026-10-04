import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { runtimeAuthority } from "./runtime-authority.js";

// Official SDK server with streaming HTTP forwarding, shared by adapter and ACP/PG tests.
export async function startProgressFixture(
  options: {
    title?: string;
    toolName?: string;
    inputSchema?: z.ZodObject;
    meta?: Record<string, unknown>;
    structuredContent?: Record<string, unknown>;
  } = {},
) {
  const ready = Promise.withResolvers<ServerContext>();
  const ended = Promise.withResolvers<void>();
  const outcome = Promise.withResolvers<boolean>();
  const executionIds: string[] = [];
  const receivedArguments: Record<string, unknown>[] = [];
  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: "progress-fixture", version: "1.0.0" });
      mcp.registerTool(
        options.toolName ?? "read",
        {
          inputSchema:
            options.inputSchema ??
            z.object({
              path: z.union([
                z.string(),
                z.object({
                  root: z.enum(["workspace", "system_skills"]),
                  path: z.string(),
                }),
              ]),
            }),
          ...(options.title === undefined ? {} : { title: options.title }),
        },
        async (_args: Record<string, unknown>, context: ServerContext) => {
          receivedArguments.push(_args);
          executionIds.push(
            context.http?.req?.headers.get("x-antnest-expected-execution-id") ??
              "missing",
          );
          ready.resolve(context);
          const isError = await outcome.promise;
          ended.resolve();
          return {
            content: [{ type: "text" as const, text: "final result" }],
            isError,
            ...(options.meta === undefined ? {} : { _meta: options.meta }),
            ...(options.structuredContent === undefined
              ? {}
              : { structuredContent: options.structuredContent }),
          };
        },
      );
      return mcp;
    },
    { legacy: "reject" },
  );
  const server = createServer((request, response) => {
    if (!authority.admit(request, response)) return;
    void forward(request, response, handler);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing MCP address");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const authority = runtimeAuthority(endpoint, "runtime-execution-1");
  return {
    endpoint,
    authority,
    ready: ready.promise,
    executionIds,
    receivedArguments,
    async progress(progress: number, message: string, wrongToken = false) {
      const context = await ready.promise;
      const token = context.mcpReq._meta?.progressToken;
      if (token === undefined)
        throw new Error("Client did not request progress");
      await context.mcpReq.notify({
        method: "notifications/progress",
        params: {
          progressToken: wrongToken ? 9999999 : token,
          progress,
          message,
        },
      });
    },
    finish(isError = false) {
      outcome.resolve(isError);
    },
    async close() {
      outcome.resolve(false);
      // Let an active handler finish before closing the official SDK.
      if (executionIds.length > 0) await ended.promise;
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
      await authority.connections.close();
    },
  };
}

async function forward(
  request: IncomingMessage,
  response: ServerResponse,
  handler: McpHttpHandler,
) {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.from(chunk as Uint8Array));
    const headers = new Headers();
    for (const [name, values] of Object.entries(request.headers)) {
      for (const value of Array.isArray(values)
        ? values
        : values === undefined
          ? []
          : [values]) {
        headers.append(name, value);
      }
    }
    const body = Buffer.concat(chunks);
    const result = await handler.fetch(
      new Request(`http://${request.headers.host}${request.url}`, {
        method: request.method ?? "POST",
        headers,
        ...(body.length === 0 ? {} : { body: new Uint8Array(body) }),
      }),
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body === null) response.end();
    else await pipeline(Readable.from(result.body), response);
  } catch {
    response.destroy();
  }
}
