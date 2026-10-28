import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function endpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return undefined;
    return url.href.replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

export const providerTokenLimitsSchema = z
  .strictObject({
    source: z.literal("models"),
    source_revision: positive,
    binding: z.strictObject({
      organization_id: id,
      connection_id: id,
      provider_key: z.enum(["deepseek", "openrouter", "openai_compatible"]),
      request_protocol: z.literal("openai_chat_completions"),
      base_url: z
        .string()
        .refine((value) => endpoint(value) !== undefined, "Invalid Provider limit endpoint"),
      model: z.string().min(1).max(200),
      credential_revision: id,
    }),
    context_tokens: positive.optional(),
    max_output_tokens: positive.optional(),
    context_includes_media: z.boolean().optional(),
    output_includes_reasoning: z.boolean().optional(),
  })
  .refine(
    (value) => value.context_tokens !== undefined || value.max_output_tokens !== undefined,
    "Provider token limits require an observed dimension",
  );

export type ProviderTokenLimits = z.infer<typeof providerTokenLimitsSchema>;

export function matchingProviderTokenLimits(
  limits: ProviderTokenLimits | undefined,
  current: {
    organization_id: string;
    connection_id: string;
    provider_key: string;
    request_protocol: string;
    base_url: string;
    model: string;
    credential_revision: string;
  },
): ProviderTokenLimits | undefined {
  if (limits === undefined) return undefined;
  const original = limits.binding;
  const originalEndpoint = endpoint(original.base_url);
  if (originalEndpoint === undefined || originalEndpoint !== endpoint(current.base_url))
    return undefined;
  for (const key of [
    "organization_id",
    "connection_id",
    "provider_key",
    "request_protocol",
    "model",
    "credential_revision",
  ] as const) {
    if (original[key] !== current[key]) return undefined;
  }
  return limits;
}
