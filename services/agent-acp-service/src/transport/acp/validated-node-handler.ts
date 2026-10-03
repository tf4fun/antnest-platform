import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import type { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { readRpcRequest, readRequestBytes, RpcRequestError, rpcJson } from "../rpc-request.js";

// Retain SDK ownership of ACP routing/connection IDs/SSE. This adapter validates
// raw UTF-8 and duplicate JSON members before the SDK's text decoding boundary.
export function createValidatedNodeHttpHandler(server: AcpServer, maximum: number) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    void handle(server, request, response, maximum);
  };
}
async function handle(
  server: AcpServer,
  request: IncomingMessage,
  response: ServerResponse,
  maximum: number,
): Promise<void> {
  const disconnected = new AbortController();
  const close = () => {
    if (!response.writableFinished) disconnected.abort();
  };
  request.once("aborted", close);
  response.once("close", close);
  try {
    const body =
      request.method === "POST"
        ? JSON.stringify(await readRpcRequest(request, maximum))
        : undefined;
    if (request.method === "DELETE" && (await readRequestBytes(request, maximum)).length !== 0)
      throw new RpcRequestError(400, "invalid_request", "DELETE does not accept a request body");
    const headers = new Headers();
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!);
    if (body !== undefined) headers.delete("content-length");
    // An incoming Host is never used to choose a dependency or trusted origin.
    const input = new Request(new URL(request.url ?? "/v1/acp", "http://agent-acp-service"), {
      method: request.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
      signal: disconnected.signal,
    });
    const result = await server.handleRequest(input);
    if (response.destroyed) {
      await result.body?.cancel();
      return;
    }
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.writeHead(result.status);
    response.flushHeaders();
    if (result.body)
      await pipeline(Readable.fromWeb(result.body as ReadableStream<Uint8Array>), response, {
        signal: disconnected.signal,
      });
    else response.end();
  } catch (error) {
    if (!response.destroyed && !response.headersSent) {
      const status = error instanceof RpcRequestError ? error.status : 503;
      response.setHeader("Connection", "close");
      rpcJson(response, status, {
        code: error instanceof RpcRequestError ? error.code : "acp_http_unavailable",
        retryable: status === 503,
      });
    } else if (!response.destroyed) response.destroy();
  } finally {
    request.off("aborted", close);
    response.off("close", close);
  }
}
