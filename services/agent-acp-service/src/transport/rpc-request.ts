import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError } from "../domain/errors.js";

export class RpcRequestError extends DomainError {
  public constructor(
    public readonly status: number,
    code: string,
    message: string,
  ) {
    super(code, message);
  }
}

export async function readRpcRequest(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (request.method !== "POST")
    throw new RpcRequestError(405, "method_not_allowed", "Use POST for internal RPC requests");
  const media = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  const encoding = request.headers["content-encoding"];
  if (media !== "application/json" || (encoding !== undefined && encoding !== "identity"))
    throw new RpcRequestError(415, "unsupported_media_type", "Use unencoded application/json");
  const tooLarge = () =>
    new RpcRequestError(413, "request_too_large", "RPC request exceeds the body limit");
  if (Number(request.headers["content-length"]) > maxBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const input: AsyncIterable<unknown> = request.iterator({ destroyOnReturn: false });
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk)) throw new Error("HTTP request body must contain bytes");
    bytes += chunk.length;
    if (bytes > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed;
  } catch {
    throw new RpcRequestError(400, "invalid_json", "Invalid JSON RPC request");
  }
}

export function rpcJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return;
  if (status === 405) response.setHeader("Allow", "POST");
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
