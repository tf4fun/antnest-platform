import { describe, expect, it } from "vitest";
import catalog from "../../../../contracts/agent-acp/errors.json" with { type: "json" };
import { DomainError } from "../../src/domain/errors.js";
import { errorCapability, resolveErrorDefinition } from "../../src/domain/error-catalog.js";
import type { ErrorSurface } from "../../src/domain/error-catalog.js";

type CatalogEntry = {
  readonly class: string;
  readonly json_rpc_code: number | null;
  readonly http_status: number;
  readonly retryable: boolean;
  readonly retry_after_ms?: number;
  readonly recovery: string;
  readonly message: string;
  readonly surfaces: readonly string[];
};

const definitions: [string, CatalogEntry][] = Object.entries(catalog.errors);
const surfaces = ["admission", "http", "skill_source"] as const satisfies readonly ErrorSurface[];
const backoffCodes = [
  "agent_busy",
  "session_busy",
  "configuration_not_ready",
  "agent_preparing",
  "recovery_pending",
];
const fallback = {
  code: "internal_error",
  errorClass: "internal",
  jsonRpcCode: -32020,
  httpStatus: 500,
  retryable: false,
  recovery: "contact_operator",
  message: "Agent request failed",
};

function expectedDefinition(code: string, entry: CatalogEntry) {
  return {
    code,
    errorClass: entry.class,
    jsonRpcCode: entry.json_rpc_code,
    httpStatus: entry.http_status,
    retryable: entry.retryable,
    ...(entry.retry_after_ms === undefined ? {} : { retryAfterMs: entry.retry_after_ms }),
    recovery: entry.recovery,
    message: entry.message,
  };
}

describe("the canonical ACP error catalog", () => {
  it("covers all 71 registered codes and exports the canonical capability version", () => {
    expect(definitions).toHaveLength(71);
    expect(catalog.capability.name).toBe("antnest.dev/errors");
    expect(errorCapability).toStrictEqual({ version: catalog.capability.version });
    expect(errorCapability).toStrictEqual({ version: 1 });
  });

  describe.each(definitions)("%s", (code, entry) => {
    it("resolves its complete canonical definition without a surface filter", () => {
      const definition = resolveErrorDefinition(code);
      expect(definition).toStrictEqual(expectedDefinition(code, entry));
      if (entry.retry_after_ms === undefined)
        expect(Object.hasOwn(definition, "retryAfterMs")).toBe(false);
    });

    it("supplies DomainError defaults while retaining the original internal code and message", () => {
      const message = `PRIVATE_DOMAIN_MESSAGE:${code}`;
      const error = new DomainError(code, message);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("DomainError");
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(error.errorClass).toBe(entry.class);
      expect(error.retryable).toBe(entry.retryable);
      expect(error.retryAfterMs).toBe(entry.retry_after_ms);
      expect(error.recovery).toBe(entry.recovery);
    });

    it.each(surfaces)("restricts the %s surface to its registered entries", (surface) => {
      const definition = resolveErrorDefinition(code, surface);
      expect(definition).toStrictEqual(
        entry.surfaces.includes(surface) ? expectedDefinition(code, entry) : fallback,
      );
      if (!entry.surfaces.includes(surface) || entry.retry_after_ms === undefined)
        expect(Object.hasOwn(definition, "retryAfterMs")).toBe(false);
    });
  });

  it("freezes agent_busy at -32030, HTTP 409 and a 1000ms backoff", () => {
    expect(resolveErrorDefinition("agent_busy", "admission")).toStrictEqual({
      code: "agent_busy",
      errorClass: "availability",
      jsonRpcCode: -32030,
      httpStatus: 409,
      retryable: true,
      retryAfterMs: 1000,
      recovery: "backoff",
      message: "Agent already has an active Run",
    });
  });

  it("keeps runtime_barrier_required at -32036 and HTTP 409 without a retry delay", () => {
    const definition = resolveErrorDefinition("runtime_barrier_required", "admission");
    expect(definition).toMatchObject({
      code: "runtime_barrier_required",
      errorClass: "availability",
      jsonRpcCode: -32036,
      httpStatus: 409,
      retryable: true,
      recovery: "wait_rebuild",
    });
    expect(Object.hasOwn(definition, "retryAfterMs")).toBe(false);
  });

  it("keeps database_error at -32603 without suggesting replay", () => {
    const definition = resolveErrorDefinition("database_error", "admission");
    expect(definition).toMatchObject({
      code: "database_error",
      errorClass: "internal",
      jsonRpcCode: -32603,
      httpStatus: 500,
      retryable: false,
      recovery: "query_intent",
    });
    expect(Object.hasOwn(definition, "retryAfterMs")).toBe(false);
  });

  it("only supplies the five canonical backoff defaults and never invents another delay", () => {
    const delayed = definitions
      .filter(([code]) => Object.hasOwn(resolveErrorDefinition(code), "retryAfterMs"))
      .map(([code]) => code)
      .sort();
    expect(delayed).toStrictEqual([...backoffCodes].sort());
    for (const code of backoffCodes)
      expect(resolveErrorDefinition(code)).toMatchObject({
        retryable: true,
        retryAfterMs: 1000,
        recovery: "backoff",
      });
  });

  describe.each(["not_registered", "toString", "__proto__", "constructor", "", "internal_error"])(
    "unknown code %j",
    (code) => {
      it.each([undefined, ...surfaces])("uses the fixed fallback for surface %s", (surface) => {
        const definition = resolveErrorDefinition(code, surface);
        expect(definition).toStrictEqual(fallback);
        expect(Object.hasOwn(definition, "retryAfterMs")).toBe(false);
      });

      it("retains internal DomainError identity while applying non-retryable fallback defaults", () => {
        const message = "PRIVATE_UNKNOWN_DOMAIN_MESSAGE";
        const error = new DomainError(code, message);
        expect(error.code).toBe(code);
        expect(error.message).toBe(message);
        expect(error.errorClass).toBe("internal");
        expect(error.retryable).toBe(false);
        expect(error.retryAfterMs).toBeUndefined();
        expect(error.recovery).toBe("contact_operator");
      });
    },
  );
});
