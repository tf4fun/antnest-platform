import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "./errors.js";
import type { ExecutionConfiguration } from "./execution-configuration.js";

const publicationSchema = z.strictObject({
  organization_id: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim() === value),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  authority_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type ExecutionPublication = Readonly<z.infer<typeof publicationSchema>>;

export function parseExecutionPublication(input: unknown): ExecutionPublication {
  const parsed = publicationSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("invalid_request", "Invalid execution publication");
  return Object.freeze(parsed.data);
}

/** The complete parsed private configuration, including credentials, identifies a publication. */
export function executionPublication(configuration: ExecutionConfiguration): ExecutionPublication {
  return Object.freeze({
    organization_id: configuration.organization_id,
    revision: configuration.revision,
    authority_sha256: createHash("sha256").update(canonical(configuration)).digest("hex"),
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) throw new TypeError("Execution authority is not JSON");
  return JSON.stringify(value);
}
