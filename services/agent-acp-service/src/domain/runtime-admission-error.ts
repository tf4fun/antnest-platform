import { z } from "zod";

const denial = z.strictObject({
  code: z.enum(["runtime_unauthorized", "caller_not_allowed", "host_not_allowed"]),
  message: z.literal("Runtime request rejected"),
  retryable: z.literal(false),
});

/** Native whole-mount admission rejects before a Skill operation is dispatched.
 * This proves only this HTTP attempt, never an earlier unknown effect. */
export function runtimeAdmissionDenial(response: Response, body: unknown): string | null {
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return null;
  const parsed = denial.safeParse(body);
  if (!parsed.success) return null;
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
