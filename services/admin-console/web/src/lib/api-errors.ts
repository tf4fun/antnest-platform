import { ERROR_METADATA } from "./errors.gen.ts";
import type { RemoteErrorBody } from "./types.ts";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function readRemoteError(value: unknown, _status: number): RemoteErrorBody {
  const body = (
    value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
  ) as RemoteErrorBody;
  const code = typeof body.code === "string" ? body.code : undefined;
  const meta = code !== undefined && Object.hasOwn(ERROR_METADATA, code) ? ERROR_METADATA[code] : undefined;
  return {
    code,
    category: meta?.category ?? "internal",
    message: typeof body.message === "string" ? body.message : undefined,
    retryable: meta?.retryable ?? false,
    request_id:
      typeof body.request_id === "string" && SAFE_REQUEST_ID.test(body.request_id)
        ? body.request_id
        : undefined,
    details:
      body.details !== null && typeof body.details === "object" && !Array.isArray(body.details)
        ? body.details
        : undefined,
    references: body.references,
    references_truncated: body.references_truncated,
  };
}
