import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError } from "../domain/errors.js";
import { strictObject } from "../adapters/strict-json.js";
import { fields } from "../adapters/service-authentication.js";

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
  requireJsonMedia(request);
  const bytes = await readRequestBytes(request, maxBytes);
  try {
    return strictObject(bytes);
  } catch {
    throw new RpcRequestError(400, "invalid_json", "Invalid JSON RPC request");
  }
}

export async function readRequestBytes(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

export function requireJsonMedia(request: IncomingMessage): void {
  const headers = fields(request);
  const types = headers.filter((field) => field.name.toLowerCase() === "content-type");
  const encodings = headers.filter((field) => field.name.toLowerCase() === "content-encoding");
  if (
    types.length !== 1 ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(types[0]!.value) ||
    encodings.length > 1 ||
    (encodings.length === 1 && encodings[0]!.value !== "identity")
  )
    throw new RpcRequestError(
      415,
      "unsupported_media_type",
      "Use unencoded application/json with UTF-8 charset only",
    );
}

export function rpcJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return;
  if (status === 405) response.setHeader("Allow", "POST");
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
