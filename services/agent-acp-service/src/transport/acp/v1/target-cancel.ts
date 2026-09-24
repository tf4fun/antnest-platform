import { z } from "zod";
import { DomainError } from "../../../domain/errors.js";

const target = z.object({ expectedRunId: z.string().min(1).max(200) }).strict();

export function targetCancelRunId(
  meta: Record<string, unknown> | null | undefined,
): string | undefined {
  const value = meta?.["antnest.dev/target-cancel"];
  if (value === undefined) return undefined;
  const parsed = target.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("invalid_request", "Invalid target cancellation metadata");
  }
  return parsed.data.expectedRunId;
}
