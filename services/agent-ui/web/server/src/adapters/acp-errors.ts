import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RequestError } from "@agentclientprotocol/sdk";
import { z } from "zod";

type Rule = {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, Rule>;
  items?: Rule;
  anyOf?: Rule[];
  allOf?: Array<{ if: Rule; then: Rule }>;
};
type CatalogSchema = {
  properties: Record<string, Rule>;
  $defs: Record<string, Rule>;
};

function readContract(name: string): unknown {
  const paths = [
    "../../../contracts/agent-acp/",
    "../../../../../../contracts/agent-acp/",
  ];
  for (const [index, base] of paths.entries()) {
    try {
      return JSON.parse(
        readFileSync(new URL(base + name, import.meta.url), "utf8"),
      );
    } catch (error) {
      if (
        index === paths.length - 1 ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }
  throw new Error("ACP error contract is unavailable");
}

function property(rule: Rule, name: string): Rule {
  const result = rule.properties?.[name];
  assert(result, "Unsupported ACP error schema");
  return result;
}

function strings(rule: Rule): string[] {
  assert(
    Array.isArray(rule.enum) && rule.enum.length > 0,
    "Unsupported ACP error schema",
  );
  assert(
    rule.enum.every((value) => typeof value === "string"),
    "Unsupported ACP error schema",
  );
  return rule.enum as string[];
}

function numberConstant(rule: Rule): number {
  assert(
    typeof rule.const === "number" && Number.isSafeInteger(rule.const),
    "Unsupported ACP error schema",
  );
  return rule.const;
}

function stringConstant(rule: Rule): string {
  assert(typeof rule.const === "string", "Unsupported ACP error schema");
  return rule.const;
}

function numericRule(value: number | null, rule: Rule): boolean {
  if (rule.anyOf)
    return rule.anyOf.some((candidate) => numericRule(value, candidate));
  if (Object.hasOwn(rule, "const") && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.type === "null") return value === null;
  if (
    rule.type === "integer" &&
    (typeof value !== "number" || !Number.isSafeInteger(value))
  )
    return false;
  if (rule.minimum !== undefined && (value === null || value < rule.minimum))
    return false;
  if (rule.maximum !== undefined && (value === null || value > rule.maximum))
    return false;
  return true;
}

// The shared schema supplies scalar bounds, allowed recovery modes and reserved
// numeric ranges. The consumer does not maintain another error-code table.
const schema = readContract("errors.schema.json") as CatalogSchema;
const codeRule = schema.$defs.code;
const messageRule = schema.$defs.message;
const delayRule = schema.$defs.retryAfterMs;
assert(
  Number.isSafeInteger(codeRule.minLength) &&
    Number.isSafeInteger(codeRule.maxLength) &&
    typeof codeRule.pattern === "string" &&
    Number.isSafeInteger(messageRule.minLength) &&
    Number.isSafeInteger(messageRule.maxLength) &&
    Number.isSafeInteger(delayRule.minimum) &&
    Number.isSafeInteger(delayRule.maximum),
  "Unsupported ACP error schema",
);
const publicCode = z
  .string()
  .min(codeRule.minLength!)
  .max(codeRule.maxLength!)
  .regex(new RegExp(codeRule.pattern, "u"));
const publicMessage = z
  .string()
  .min(messageRule.minLength!)
  .max(messageRule.maxLength!);
const retryDelay = z
  .number()
  .int()
  .min(delayRule.minimum!)
  .max(delayRule.maximum!);
const entryRule = schema.$defs.catalogEntry;
const httpRule = property(entryRule, "http_status");
const surfaceRule = property(entryRule, "surfaces").items;
assert(surfaceRule && entryRule.allOf, "Unsupported ACP error schema");
const entry = z
  .strictObject({
    class: z.enum(strings(property(entryRule, "class"))),
    json_rpc_code: z.number().int().nullable(),
    http_status: z.number().int().min(httpRule.minimum!).max(httpRule.maximum!),
    retryable: z.boolean(),
    retry_after_ms: retryDelay.optional(),
    recovery: z.enum(strings(property(entryRule, "recovery"))),
    message: publicMessage,
    surfaces: z
      .array(z.enum(strings(surfaceRule)))
      .min(1)
      .refine((values) => new Set(values).size === values.length),
  })
  .superRefine((value, context) => {
    const invalid = () =>
      context.addIssue({
        code: "custom",
        message: "Invalid ACP catalog entry",
      });
    if (!numericRule(value.json_rpc_code, property(entryRule, "json_rpc_code")))
      invalid();
    for (const constraint of entryRule.allOf!) {
      const selected = constraint.if.properties?.class;
      if (!selected) continue;
      if (
        (Object.hasOwn(selected, "const") && selected.const !== value.class) ||
        (selected.enum && !selected.enum.includes(value.class))
      )
        continue;
      const numeric = constraint.then.properties?.json_rpc_code;
      if (numeric && !numericRule(value.json_rpc_code, numeric)) invalid();
    }
    if (value.surfaces.includes("admission") && value.json_rpc_code === null)
      invalid();
    if (
      value.retry_after_ms !== undefined &&
      (!value.retryable || value.recovery !== "backoff")
    )
      invalid();
  });

const fallbackRule = schema.properties.fallback;
assert(
  property(fallbackRule, "retryable").const === false,
  "Unsupported ACP error schema",
);
const terminalRule = schema.properties.terminal_outcomes;
const terminalDataCodeRule = schema.$defs.terminalDataCode;
const terminalSurface = schema.$defs.terminalSurfaces.items;
assert(terminalSurface, "Unsupported ACP error schema");
function terminal(name: string) {
  const rule = property(terminalRule, name);
  assert(
    property(rule, "retryable").const === false,
    "Unsupported ACP error schema",
  );
  return z.strictObject({
    json_rpc_code: z.literal(numberConstant(property(rule, "json_rpc_code"))),
    retryable: z.literal(false),
    message: publicMessage,
    surfaces: z.array(z.literal(stringConstant(terminalSurface!))).length(1),
    data_code: z.strictObject({
      vocabulary: z.literal(
        stringConstant(property(terminalDataCodeRule, "vocabulary")),
      ),
      meaning: z
        .string()
        .min(property(terminalDataCodeRule, "meaning").minLength!),
    }),
  });
}
const catalog = z
  .strictObject({
    schema_version: z.literal(1),
    capability: z.strictObject({
      name: z.literal("antnest.dev/errors"),
      version: z.literal(1),
    }),
    errors: z
      .record(publicCode, entry)
      .refine((values) => Object.keys(values).length > 0),
    fallback: z.strictObject({
      json_rpc_code: z.literal(
        numberConstant(property(fallbackRule, "json_rpc_code")),
      ),
      http_status: z.literal(
        numberConstant(property(fallbackRule, "http_status")),
      ),
      data_code: z.literal(stringConstant(property(fallbackRule, "data_code"))),
      retryable: z.literal(false),
      recovery: z.literal(stringConstant(property(fallbackRule, "recovery"))),
      message: z.literal(stringConstant(property(fallbackRule, "message"))),
    }),
    terminal_outcomes: z.strictObject({
      failed: terminal("failed"),
      unresolved: terminal("unresolved"),
    }),
  })
  .parse(readContract("errors.json"));

const errorData = z.strictObject({
  code: publicCode,
  retryable: z.boolean(),
  retry_after_ms: retryDelay.optional(),
  details: z.strictObject({}).optional(),
});
const errorDataKeys = new Set([
  "code",
  "retryable",
  "retry_after_ms",
  "details",
]);
const terminalDefinitions = Object.values(catalog.terminal_outcomes);

export type AcpErrorCapability = 1 | null;
export type AcpErrorClassification = Readonly<{
  kind: "admission" | "terminal" | "unknown";
  code: string;
  message: string;
  retryable: boolean;
  retryDirective: string;
  retryAfterMs?: number;
  // Prompt/Run callers query their original identity before considering another
  // admission. This marker does not assert that a Session/load request has a Run.
  requiresRunQuery: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readAcpErrorCapability(meta: unknown): AcpErrorCapability {
  if (!isRecord(meta) || !Object.hasOwn(meta, catalog.capability.name))
    return null;
  const value = meta[catalog.capability.name];
  return isRecord(value) &&
    Object.hasOwn(value, "version") &&
    value.version === catalog.capability.version
    ? 1
    : null;
}

function unknown(): AcpErrorClassification {
  return Object.freeze({
    kind: "unknown",
    code: catalog.fallback.data_code,
    message: catalog.fallback.message,
    retryable: false,
    retryDirective: catalog.fallback.recovery,
    requiresRunQuery: true,
  });
}

export function classifyAcpError(
  cause: unknown,
  capability: AcpErrorCapability,
): AcpErrorClassification {
  if (
    capability !== catalog.capability.version ||
    !(cause instanceof RequestError)
  )
    return unknown();
  try {
    // SDK 1.5's public serializer preserves the actual code/message/data. Use
    // those fields, never formatted exception text or arbitrary local objects.
    const response = cause.toErrorResponse();
    if (!Number.isSafeInteger(response.code) || !isRecord(response.data))
      return unknown();
    if (
      !Reflect.ownKeys(response.data).every(
        (key) => typeof key === "string" && errorDataKeys.has(key),
      )
    )
      return unknown();
    const parsed = errorData.safeParse(response.data);
    if (!parsed.success) return unknown();
    const data = parsed.data;
    const hasDelay = Object.hasOwn(response.data, "retry_after_ms");
    if (hasDelay && data.retry_after_ms === undefined) return unknown();
    if (Object.hasOwn(response.data, "details")) {
      const details = response.data.details;
      if (!isRecord(details) || Reflect.ownKeys(details).length !== 0)
        return unknown();
    }
    const outcome = terminalDefinitions.find(
      (value) => value.json_rpc_code === response.code,
    );
    if (outcome) {
      if (response.message !== outcome.message || data.retryable || hasDelay)
        return unknown();
      return Object.freeze({
        kind: "terminal",
        code: data.code,
        message: outcome.message,
        retryable: false,
        retryDirective: "none",
        requiresRunQuery: true,
      });
    }
    const definition = Object.hasOwn(catalog.errors, data.code)
      ? catalog.errors[data.code]
      : undefined;
    if (
      !definition ||
      !definition.surfaces.includes("admission") ||
      definition.json_rpc_code !== response.code ||
      response.message !== definition.message ||
      data.retryable !== definition.retryable ||
      (hasDelay && (!data.retryable || definition.recovery !== "backoff"))
    )
      return unknown();
    return Object.freeze({
      kind: "admission",
      code: data.code,
      message: definition.message,
      retryable: definition.retryable,
      retryDirective: definition.recovery,
      ...(hasDelay ? { retryAfterMs: data.retry_after_ms } : {}),
      requiresRunQuery: definition.recovery === "query_intent",
    });
  } catch {
    // A malformed exception must not authorize replay or expose its raw cause.
    return unknown();
  }
}
