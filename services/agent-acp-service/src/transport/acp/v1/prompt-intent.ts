import { z } from "zod";
import { DomainError } from "../../../domain/errors.js";

const intent = z
  .object({
    intentId: z.string().min(1).max(200),
    expectedAppendVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export function promptBridgeIntent(
  meta: Record<string, unknown> | null | undefined,
): { intentId: string; expectedAppendVersion: number } | undefined {
  const value = meta?.["antnest.dev/intent"];
  if (value === undefined) return undefined;
  const parsed = intent.safeParse(value);
  if (!parsed.success) throw new DomainError("invalid_request", "Invalid Bridge prompt intent");
  return parsed.data;
}
