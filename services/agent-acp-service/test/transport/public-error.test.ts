import { describe, expect, it } from "vitest";
import catalog from "../../../../contracts/agent-acp/errors.json" with { type: "json" };
import type { ErrorSurface } from "../../src/domain/error-catalog.js";
import { DomainError } from "../../src/domain/errors.js";
import { RunRecoveryRequiredError } from "../../src/ports/acp-application.js";
import { publicError } from "../../src/transport/public-error.js";

type CatalogEntry = {
  readonly json_rpc_code: number | null;
  readonly http_status: number;
  readonly retryable: boolean;
  readonly retry_after_ms?: number;
  readonly message: string;
  readonly surfaces: readonly string[];
};

const definitions: [string, CatalogEntry][] = Object.entries(catalog.errors);
const surfaces = ["admission", "http", "skill_source"] as const satisfies readonly ErrorSurface[];
const privateMessage = "PRIVATE_DOMAIN_MESSAGE_NOT_FOR_THE_WIRE";
const privateCause = "postgres://PRIVATE_CREDENTIALS_AND_UPSTREAM_PAYLOAD";
const fallback = {
  jsonRpcCode: -32020,
  httpStatus: 500,
  message: "Agent request failed",
  data: { code: "internal_error", retryable: false },
};
const backoffCodes = new Set([
  "agent_busy",
  "session_busy",
  "configuration_not_ready",
  "agent_preparing",
  "recovery_pending",
]);

function expectedPublicError(code: string, entry: CatalogEntry) {
  return {
    jsonRpcCode: entry.json_rpc_code,
    httpStatus: entry.http_status,
    message: entry.message,
    data: {
      code,
      retryable: entry.retryable,
      ...(entry.retry_after_ms === undefined ? {} : { retry_after_ms: entry.retry_after_ms }),
    },
  };
}

function domainFailure(code: string) {
  return new DomainError(code, privateMessage);
}

describe("the shared public ACP error projection", () => {
  describe.each(definitions)("%s", (code, entry) => {
    it.each(surfaces)("projects only its canonical public fields for %s", (surface) => {
      const original = domainFailure(code);
      const projected = publicError(original, surface);
      const applicable = entry.surfaces.includes(surface);
      expect(projected).toStrictEqual(applicable ? expectedPublicError(code, entry) : fallback);
      expect(original.code).toBe(code);
      expect(original.message).toBe(privateMessage);
      expect(JSON.stringify(projected)).not.toContain(privateMessage);
      expect(JSON.stringify(projected)).not.toContain(privateCause);
      if (applicable && backoffCodes.has(code)) expect(projected.data.retry_after_ms).toBe(1000);
      else expect(Object.hasOwn(projected.data, "retry_after_ms")).toBe(false);
    });
  });

  it("returns the exact agent_busy public receipt with the fixed numeric code and delay", () => {
    expect(publicError(domainFailure("agent_busy"), "admission")).toStrictEqual({
      jsonRpcCode: -32030,
      httpStatus: 409,
      message: "Agent already has an active Run",
      data: { code: "agent_busy", retryable: true, retry_after_ms: 1000 },
    });
  });

  it("keeps the Runtime rebuild barrier distinct without inventing a delay", () => {
    const projected = publicError(domainFailure("runtime_barrier_required"), "admission");
    expect(projected).toStrictEqual({
      jsonRpcCode: -32036,
      httpStatus: 409,
      message: catalog.errors.runtime_barrier_required.message,
      data: { code: "runtime_barrier_required", retryable: true },
    });
    expect(Object.hasOwn(projected.data, "retry_after_ms")).toBe(false);
  });

  it.each(surfaces)(
    "projects uncertain persistence safely for %s without copying its cause",
    (surface) => {
      const cause = new Error(privateCause);
      const original = new RunRecoveryRequiredError(privateMessage, cause);
      const projected = publicError(original, surface);
      expect(projected).toStrictEqual(
        surface === "skill_source"
          ? fallback
          : {
              jsonRpcCode: -32603,
              httpStatus: 500,
              message: "A database operation requires service recovery",
              data: { code: "database_error", retryable: false },
            },
      );
      expect(original.message).toBe(privateMessage);
      expect(original.cause).toBe(cause);
      expect(Object.hasOwn(projected.data, "retry_after_ms")).toBe(false);
      expect(JSON.stringify(projected)).not.toContain(privateMessage);
      expect(JSON.stringify(projected)).not.toContain(privateCause);
    },
  );

  it.each(["not_registered", "toString", "__proto__", "constructor", "", "internal_error"])(
    "uses the safe fallback for DomainError code %j on every surface",
    (code) => {
      for (const surface of surfaces) {
        const projected = publicError(domainFailure(code), surface);
        expect(projected).toStrictEqual(fallback);
        expect(Object.hasOwn(projected.data, "retry_after_ms")).toBe(false);
      }
    },
  );

  const unclassified: { label: string; create: () => unknown }[] = [
    { label: "undefined", create: () => undefined },
    { label: "null", create: () => null },
    { label: "a string cause", create: () => privateCause },
    { label: "a number", create: () => 500 },
    { label: "a symbol", create: () => Symbol(privateCause) },
    {
      label: "an ordinary Error and its private cause",
      create: () => new Error(privateMessage, { cause: new Error(privateCause) }),
    },
    {
      label: "a forged code object",
      create: () => ({
        code: "agent_busy",
        message: privateMessage,
        retryable: true,
        cause: new Error(privateCause),
        details: { credential: privateCause },
      }),
    },
    {
      label: "an Error named DomainError with a forged code",
      create: () =>
        Object.assign(new Error(privateMessage), { name: "DomainError", code: "agent_busy" }),
    },
    {
      label: "an Error with a forged database_error code",
      create: () => Object.assign(new Error(privateMessage), { code: "database_error" }),
    },
  ];
  it.each(unclassified)(
    "does not classify $label from untrusted public-looking fields",
    ({ create }) => {
      for (const surface of surfaces) {
        const projected = publicError(create(), surface);
        expect(projected).toStrictEqual(fallback);
        expect(Object.hasOwn(projected.data, "retry_after_ms")).toBe(false);
        expect(JSON.stringify(projected)).not.toContain(privateMessage);
        expect(JSON.stringify(projected)).not.toContain(privateCause);
      }
    },
  );
});
