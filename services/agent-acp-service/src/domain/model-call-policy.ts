import { z } from "zod";

const retryCount = z.number().int().min(0).max(8);
const delay = z.number().int().min(1).max(30_000);

export const modelRetryConfigurationSchema = z
  .strictObject({ max: retryCount, base_ms: delay, cap_ms: delay })
  .refine((value) => value.base_ms <= value.cap_ms, "Retry base exceeds cap");

export const modelRetrySchema = z
  .strictObject({ max: retryCount, baseMs: delay, capMs: delay })
  .refine((value) => value.baseMs <= value.capMs, "Retry base exceeds cap");

export type ModelRetry = z.infer<typeof modelRetrySchema>;

export const modelFailoverSchema = z.enum(["never", "before_output"]);
export type ModelFailover = z.infer<typeof modelFailoverSchema>;
