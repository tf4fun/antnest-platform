import { describe, expect, it, vi } from "vitest";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import {
  createLegacyRunRepositories,
  createOwnedRunRepositories,
} from "../../../src/adapters/postgres/run-repositories.js";

const incarnation = "11111111-1111-4111-8111-111111111111";
const registration = {
  registration_id: "22222222-2222-4222-8222-222222222222",
  member_id: "acp-a",
  incarnation_id: incarnation,
};
const fence = {
  organizationId: "organization-1",
  agentId: "agent-1",
  ownerInstanceId: incarnation,
  epoch: "1",
};

describe("explicit Run repository authority", () => {
  it.each([
    undefined,
    null,
    {},
    { fence },
    { registration },
    { fence: { ...fence, epoch: "0" }, registration },
    ...["\n", "\r", "\u2028", "\u2029"].map((suffix) => ({
      fence: { ...fence, epoch: `1${suffix}` },
      registration,
    })),
    { fence: { ...fence, epoch: "9223372036854775808" }, registration },
    { fence: { ...fence, agentId: "" }, registration },
    { fence: { ...fence, ownerInstanceId: "other-incarnation" }, registration },
    { fence, registration: { ...registration, registration_id: "not-a-registration" } },
    { fence, registration: { ...registration, member_id: "https://untrusted.invalid" } },
  ])("rejects incomplete or inconsistent owner authority before database access (%#)", (input) => {
    const query = vi.fn();
    const transaction = vi.fn();
    const kernel = { query, transaction } as unknown as PostgresKernel;
    expect(() => createOwnedRunRepositories(kernel, input as never)).toThrow(
      "Invalid Run ownership authority",
    );
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("requires an explicit legacy worker ownership signal", () => {
    const kernel = {} as PostgresKernel;
    expect(() => createLegacyRunRepositories(kernel, undefined as never)).toThrow();
  });

  it("joins no new legacy write after its worker ownership is lost", async () => {
    const transaction = vi.fn();
    const kernel = { transaction } as unknown as PostgresKernel;
    const worker = new AbortController();
    const repositories = createLegacyRunRepositories(kernel, worker.signal);
    const loss = new Error("worker ownership lost");
    worker.abort(loss);
    await expect(repositories.runs.requestCancellation("run-1", new Date())).rejects.toBe(loss);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "joins the original legacy transaction after loss and retains its failure (%s)",
    async (rollbackFails) => {
      const original = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const transaction = vi.fn(() => {
        entered.resolve();
        return original.promise;
      });
      const worker = new AbortController();
      const repositories = createLegacyRunRepositories(
        { transaction } as unknown as PostgresKernel,
        worker.signal,
      );
      const loss = new Error("worker ownership lost");
      const rollback = new Error("original transaction rollback failed");
      let settled = false;
      const pending = repositories.runs
        .requestCancellation("run-1", new Date())
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await entered.promise;
        worker.abort(loss);
        await nextTurn();
        expect(settled).toBe(false);
        if (rollbackFails) original.reject(rollback);
        else original.resolve();
        const result = await pending;
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Lost worker accepted a transaction result");
        if (rollbackFails) {
          expect(result.error).toBeInstanceOf(AggregateError);
          expect((result.error as AggregateError).errors).toEqual([rollback, loss]);
        } else expect(result.error).toBe(loss);
      } finally {
        original.resolve();
        await pending;
      }
    },
  );
});
