import { z } from "zod";

export const boundedCursorSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 4096);
