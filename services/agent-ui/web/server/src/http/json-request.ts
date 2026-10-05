import type { IncomingMessage } from "node:http";
import { strictObject } from "../adapters/strict-json.ts";
import { fields } from "../adapters/service-authentication.ts";
import { copyAuthenticatedRequest } from "./trusted-identity.ts";

export class HttpInputError extends Error {
  public readonly status: number;
  public readonly code: string;
  public constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export function requireJsonMedia(request: IncomingMessage): void {
  const all = fields(request);
  const types = all.filter(field => field.name.toLowerCase() === "content-type");
  const encodings = all.filter(field => field.name.toLowerCase() === "content-encoding");
  if (types.length !== 1 || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(types[0]!.value) ||
    encodings.length > 1 || (encodings.length === 1 && encodings[0]!.value !== "identity"))
    throw new HttpInputError(415, "unsupported_media_type");
}
export async function validateJsonRequest(request: Request): Promise<Request> {
  const maximum = 64 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > maximum) throw new HttpInputError(413, "request_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpInputError(400, "invalid_json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel(request.signal.reason).catch(() => {}); };
  request.signal.addEventListener("abort", abort, { once: true });
  let complete = false;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      request.signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum) throw new HttpInputError(413, "request_too_large");
      chunks.push(chunk.value);
    }
    complete = true;
  } finally {
    request.signal.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  try { strictObject(bytes); } catch { throw new HttpInputError(400, "invalid_json"); }
  const validated = new Request(request.url, { method: request.method, headers: request.headers,
    signal: request.signal, body: bytes });
  copyAuthenticatedRequest(request, validated);
  return validated;
}
