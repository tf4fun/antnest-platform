import { ERROR_METADATA } from "../errors.gen.js";
import { z } from "zod";

const denialLegacy = z.strictObject({
  code: z.enum(["runtime_unauthorized", "caller_not_allowed", "host_not_allowed"]),
  message: z.literal("Runtime request rejected"),
  retryable: z.literal(false),
});
const denialCommon = z.strictObject({
  code: z.enum(["runtime_unauthorized", "caller_not_allowed", "host_not_allowed"]),
  category: z.enum(["unauthenticated", "forbidden"]),
  message: z.literal("Runtime request rejected"),
  retryable: z.literal(false),
  request_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
});
const denial = z.union([denialLegacy, denialCommon]);

/** Native whole-mount admission rejects before a Skill operation is dispatched.
 * This proves only this HTTP attempt, never an earlier unknown effect. */
export function runtimeAdmissionDenial(response: Response, body: unknown): string | null {
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return null;
  const parsed = denial.safeParse(body);
  if (!parsed.success) return null;
  if (Object.hasOwn(body as object, "category")) {
    const data = parsed.data as {
      category?: string;
      request_id?: string;
      retryable?: boolean;
      code: string;
    };
    const meta = Object.hasOwn(ERROR_METADATA, data.code) ? ERROR_METADATA[data.code] : undefined;
    if (meta === undefined || data.category !== meta.category) return null;
    if (data.retryable !== meta.retryable) return null;
    if (response.headers.get("x-request-id") !== data.request_id) return null;
  }
  if (
    response.status === 401 &&
    parsed.data.code === "runtime_unauthorized" &&
    response.headers.get("www-authenticate") === 'Bearer realm="antnest-service"'
  )
    return parsed.data.code;
  if (response.status === 403 && parsed.data.code !== "runtime_unauthorized")
    return parsed.data.code;
  return null;
}
