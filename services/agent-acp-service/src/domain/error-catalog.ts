import { readFileSync } from "node:fs";

export type ErrorSurface = "admission" | "http" | "skill_source";

type CatalogEntry = Readonly<{
  class: string;
  json_rpc_code: number | null;
  http_status: number;
  retryable: boolean;
  retry_after_ms?: number;
  recovery: string;
  message: string;
  surfaces: readonly ErrorSurface[];
}>;

type ErrorCatalog = Readonly<{
  schema_version: number;
  capability: Readonly<{ name: string; version: number }>;
  errors: Readonly<Record<string, CatalogEntry>>;
  fallback: Readonly<{
    json_rpc_code: number;
    http_status: number;
    data_code: string;
    retryable: boolean;
    recovery: string;
    message: string;
  }>;
}>;

type ErrorDefinition = Readonly<{
  code: string;
  errorClass: string;
  jsonRpcCode: number | null;
  httpStatus: number;
  retryable: boolean;
  retryAfterMs?: number;
  recovery: string;
  message: string;
}>;

function readCatalog(): string {
  try {
    return readFileSync(new URL("../contracts/agent-acp/errors.json", import.meta.url), "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  return readFileSync(
    new URL("../../../../contracts/agent-acp/errors.json", import.meta.url),
    "utf8",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The shared contract gate validates entries against the complete schema.
// Loading checks only the supported version and the catalog's root structure.
function isCatalog(value: unknown): value is ErrorCatalog {
  if (!isRecord(value)) return false;
  const capability = value.capability;
  return (
    value.schema_version === 1 &&
    isRecord(capability) &&
    capability.name === "antnest.dev/errors" &&
    capability.version === 1 &&
    isRecord(value.errors) &&
    Object.keys(value.errors).length > 0 &&
    isRecord(value.fallback)
  );
}

const parsed: unknown = JSON.parse(readCatalog());
if (!isCatalog(parsed)) throw new Error("Unsupported ACP error catalog");
const catalog = parsed;

export const errorCapability = Object.freeze({ version: catalog.capability.version });

const fallbackDefinition: ErrorDefinition = Object.freeze({
  code: catalog.fallback.data_code,
  errorClass: "internal",
  jsonRpcCode: catalog.fallback.json_rpc_code,
  httpStatus: catalog.fallback.http_status,
  retryable: catalog.fallback.retryable,
  recovery: catalog.fallback.recovery,
  message: catalog.fallback.message,
});

export function resolveErrorDefinition(code: string, surface?: ErrorSurface): ErrorDefinition {
  const entry = Object.hasOwn(catalog.errors, code) ? catalog.errors[code] : undefined;
  if (entry === undefined || (surface !== undefined && !entry.surfaces.includes(surface)))
    return fallbackDefinition;
  return Object.freeze({
    code,
    errorClass: entry.class,
    jsonRpcCode: entry.json_rpc_code,
    httpStatus: entry.http_status,
    retryable: entry.retryable,
    ...(entry.retry_after_ms === undefined ? {} : { retryAfterMs: entry.retry_after_ms }),
    recovery: entry.recovery,
    message: entry.message,
  });
}
