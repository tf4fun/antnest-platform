import { describe, expect, it } from "vitest";
import catalog from "../../../../contracts/agent-acp/errors.json" with { type: "json" };
import type { ErrorSurface } from "../../src/domain/error-catalog.js";
import { DomainError } from "../../src/domain/errors.js";
import { ModelBudgetExceededError } from "../../src/domain/model-budget.js";
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
  "connection_quota_exceeded",
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

  describe("typed model budget details", () => {
    const largeUsed = "900719925474099312345678901234567890";
    const budgetCases = [
      { scope: "run_input", limit: "0", used: "1" },
      { scope: "run_output", limit: "10", used: "11" },
      { scope: "run_cost", limit: "1", used: largeUsed },
      { scope: "organization_daily", limit: "10", used: null },
      { scope: "organization_monthly", limit: null, used: largeUsed },
      { scope: "unknown_cost", limit: null, used: null },
    ] as const;

    it.each(budgetCases)(
      "projects only the validated $scope fact on catalog surfaces",
      (budget) => {
        const original = Object.assign(
          new ModelBudgetExceededError(budget.scope, budget.limit, budget.used),
          {
            message: privateMessage,
            cause: new Error(privateCause),
            credential: privateCause,
            details: { budget: { ...budget, secret: privateCause }, secret: privateMessage },
          },
        );
        for (const surface of surfaces) {
          const projected = publicError(original, surface);
          const applicable = catalog.errors.budget_exceeded.surfaces.includes(surface);
          const canonical = expectedPublicError("budget_exceeded", catalog.errors.budget_exceeded);
          expect(projected).toStrictEqual(
            applicable
              ? { ...canonical, data: { ...canonical.data, details: { budget } } }
              : fallback,
          );
          if (applicable) {
            expect(projected).toMatchObject({
              jsonRpcCode: -32043,
              httpStatus: 422,
              data: { code: "budget_exceeded", retryable: false },
            });
          }
          expect(JSON.stringify(projected)).not.toContain(privateMessage);
          expect(JSON.stringify(projected)).not.toContain(privateCause);
        }
        expect(original.scope).toBe(budget.scope);
        expect(original.limit).toBe(budget.limit);
        expect(original.used).toBe(budget.used);
        expect(original.message).toBe(privateMessage);
      },
    );

    it("does not trust budget-looking fields on an ordinary DomainError", () => {
      const original = Object.assign(domainFailure("budget_exceeded"), {
        scope: "run_cost",
        limit: "1",
        used: largeUsed,
        cause: new Error(privateCause),
        details: { budget: { scope: "run_cost", limit: "1", used: largeUsed } },
        credential: privateCause,
      });
      for (const surface of surfaces) {
        expect(publicError(original, surface)).toStrictEqual(
          catalog.errors.budget_exceeded.surfaces.includes(surface)
            ? expectedPublicError("budget_exceeded", catalog.errors.budget_exceeded)
            : fallback,
        );
      }
    });

    it.each([false, true])("does not classify a forged budget error (Error=%s)", (isError) => {
      const original = Object.assign(isError ? new Error(privateMessage) : {}, {
        name: "ModelBudgetExceededError",
        code: "budget_exceeded",
        scope: "run_cost",
        limit: "1",
        used: largeUsed,
        message: privateMessage,
        cause: new Error(privateCause),
        details: { budget: { scope: "run_cost", limit: "1", used: largeUsed } },
      });
      for (const surface of surfaces)
        expect(publicError(original, surface)).toStrictEqual(fallback);
    });

    const corruptions: { label: string; fields: Record<string, unknown> }[] = [
      { label: "unknown scope", fields: { scope: privateMessage } },
      { label: "scope with a trailing newline", fields: { scope: "run_cost\n" } },
      { label: "missing scope", fields: { scope: undefined } },
      { label: "missing limit", fields: { limit: undefined } },
      { label: "numeric limit", fields: { limit: 1 } },
      { label: "negative limit", fields: { limit: "-1" } },
      { label: "fractional limit", fields: { limit: "1.5" } },
      { label: "noncanonical limit", fields: { limit: "01" } },
      { label: "missing used", fields: { used: undefined } },
      { label: "unsafe numeric used", fields: { used: Number.MAX_SAFE_INTEGER + 1 } },
      { label: "exponent used", fields: { used: "1e3" } },
      { label: "used with a trailing newline", fields: { used: "2\n" } },
      { label: "object used", fields: { used: { secret: privateCause } } },
    ];
    it.each(corruptions)("omits details safely for a genuine error with $label", ({ fields }) => {
      const original = Object.assign(new ModelBudgetExceededError("run_cost", "1", "2"), {
        message: privateMessage,
        cause: new Error(privateCause),
        credential: privateCause,
        ...fields,
      });
      for (const surface of surfaces) {
        const projected = publicError(original, surface);
        expect(projected).toStrictEqual(
          catalog.errors.budget_exceeded.surfaces.includes(surface)
            ? expectedPublicError("budget_exceeded", catalog.errors.budget_exceeded)
            : fallback,
        );
        expect(JSON.stringify(projected)).not.toContain(privateMessage);
        expect(JSON.stringify(projected)).not.toContain(privateCause);
      }
    });

    it("freezes copied budget details independently of the mutable error", () => {
      const mutableBudget = { scope: "run_cost", limit: "1", used: largeUsed };
      const mutableDetails = { budget: mutableBudget };
      const original = Object.assign(new ModelBudgetExceededError("run_cost", "1", largeUsed), {
        details: mutableDetails,
      });
      const projected = publicError(original, "admission");
      const details: unknown = "details" in projected.data ? projected.data.details : undefined;
      expect(details).toStrictEqual({ budget: { scope: "run_cost", limit: "1", used: largeUsed } });
      if (typeof details !== "object" || details === null || !("budget" in details)) {
        throw new Error("Expected public budget details");
      }
      const budget: unknown = details.budget;
      expect(Object.isFrozen(details)).toBe(true);
      expect(Object.isFrozen(budget)).toBe(true);
      expect(details).not.toBe(mutableDetails);
      expect(budget).not.toBe(mutableBudget);
      expect(budget).not.toBe(original);
      Object.assign(original, { scope: "unknown_cost", limit: null, used: null });
      mutableBudget.used = "3";
      expect(details).toStrictEqual({ budget: { scope: "run_cost", limit: "1", used: largeUsed } });
    });
  });
});
