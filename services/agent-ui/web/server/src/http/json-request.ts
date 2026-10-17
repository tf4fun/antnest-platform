import type { IncomingMessage } from "node:http";
import type { PromptInputObserver } from "../telemetry.ts";
import { strictObject } from "../adapters/strict-json.ts";
import { fields } from "../adapters/service-authentication.ts";
import { copyAuthenticatedRequest } from "./trusted-identity.ts";
import { largeInputBytes, runInputWork } from "./input-work.ts";

type ValidatedJson = { value: Record<string, unknown>; byteLength: number };
const validatedBodies = new WeakMap<Request, ValidatedJson>();

// This record is attached only to the exact Request created after strict native
// HTTP validation. Clones and direct handler requests take the strict read path.
export function takeValidatedJson(request: Request): ValidatedJson | undefined {
  const validated = request.bodyUsed ? undefined : validatedBodies.get(request);
  validatedBodies.delete(request);
  return validated;
}

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
export async function validateJsonRequest(request: Request, maximum = 64 * 1024 * 1024,
  observe?: PromptInputObserver): Promise<Request> {
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
      if (chunk.done) { observe?.("body-eof", size); break; }
      size += chunk.value.length;
      if (size > maximum) throw new HttpInputError(413, "request_too_large");
      if (chunk.value.length > 0 && size === chunk.value.length) observe?.("receive-started", size);
      chunks.push(chunk.value);
    }
    complete = true;
  } finally {
    request.signal.removeEventListener("abort", abort);
    // A cloned Request may have an unread sibling. Cancel this reader without
    // making rejection wait for that independently owned tee branch.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const parse = () => {
    const bytes = Buffer.concat(chunks);
    let value: Record<string, unknown>;
    try { value = strictObject(bytes); } catch { throw new HttpInputError(400, "invalid_json"); }
    observe?.("body-parsed", bytes.byteLength);
    return { bytes, value };
  };
  // Keep cancellation outside the JSON error mapping and the reservation owned
  // by native dispatch until queued parsing has actually finished.
  const { bytes, value } = size >= largeInputBytes
    ? await runInputWork(parse, request.signal) : parse();
  // A byte-array Request constructor copies the entire upload. The owned buffer
  // already has a bounded lifetime; expose it once through a normal body stream.
  const validated = new Request(request.url, { method: request.method, headers: request.headers,
    signal: request.signal,
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  copyAuthenticatedRequest(request, validated);
  validatedBodies.set(validated, { value, byteLength: bytes.byteLength });
  return validated;
}
