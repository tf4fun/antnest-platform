import { z } from "zod";
import { DomainError } from "../../domain/errors.js";
import type { RuntimeInformation } from "../../domain/runtime-information.js";

export const RUNTIME_INFORMATION_URI = "antnest://runtime/info";
const MAX_RESOURCE_BYTES = 1024 * 1024;
const pathSchema = z
  .object({ root: z.enum(["workspace", "system_skills"]), path: z.string().min(1).max(4096) })
  .strict();
const informationSchema = z
  .object({
    execution_id: z.string().min(1).max(128),
    environment: z
      .object({
        os: z.string().min(1).max(64),
        arch: z.string().min(1).max(64),
        home: z.string().min(1).max(4096),
        workspace: z.string().min(1).max(4096),
      })
      .strict(),
    instructions: z
      .object({ path: pathSchema, content: z.string().max(16384), truncated: z.boolean() })
      .strict()
      .nullable(),
    skills: z
      .array(
        z
          .object({
            source: z.enum(["system", "personal"]),
            name: z.string().min(1).max(128),
            description: z.string().min(1).max(512),
            path: pathSchema,
          })
          .strict(),
      )
      .max(64),
    warnings: z
      .array(
        z
          .object({
            path: pathSchema,
            code: z.enum([
              "unreadable",
              "invalid_utf8",
              "invalid_skill",
              "too_large",
              "scan_limit",
              "skill_limit",
            ]),
          })
          .strict(),
      )
      .max(67),
    truncated: z.boolean(),
  })
  .strict();
const resourceSchema = z.object({
  contents: z
    .array(
      z.object({
        uri: z.literal(RUNTIME_INFORMATION_URI),
        mimeType: z.literal("application/json"),
        text: z.string(),
      }),
    )
    .length(1),
});

export function parseRuntimeInformation(
  resource: unknown,
  executionId: string,
): RuntimeInformation {
  const envelope = resourceSchema.safeParse(resource);
  const text = envelope.success ? envelope.data.contents[0]?.text : undefined;
  if (text === undefined || Buffer.byteLength(text) > MAX_RESOURCE_BYTES)
    throw invalidInformation();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw invalidInformation();
  }
  const parsed = informationSchema.safeParse(decoded);
  if (!parsed.success) throw invalidInformation();
  if (parsed.data.execution_id !== executionId)
    throw new DomainError(
      "runtime_execution_mismatch",
      "Runtime information does not match the admitted execution",
    );
  const { execution_id: admittedExecutionId, ...information } = parsed.data;
  return { executionId: admittedExecutionId, ...information };
}

function invalidInformation(): DomainError {
  return new DomainError(
    "invalid_runtime_information",
    "Runtime information violates the resource contract",
  );
}
