import { z } from "zod";
import { DomainError } from "../../../domain/errors.js";

const condition = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export function configurationCondition(
  meta: Record<string, unknown> | null | undefined,
): string | undefined {
  const value = meta?.["antnest.dev/configuration"];
  if (value === undefined) return undefined;
  const parsed = condition.safeParse(value);
  if (!parsed.success)
    throw new DomainError("invalid_request", "Invalid Bridge configuration condition");
  return parsed.data.expectedRevision;
}
