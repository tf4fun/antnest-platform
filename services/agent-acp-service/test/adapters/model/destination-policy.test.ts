import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ModelTransportCleanupError } from "../../../src/ports/model.js";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderDestinationPolicy,
  providerAddressAllowed,
  providerBaseUrl,
} from "../../../src/adapters/model/destination-policy.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../contracts/platform/provider-destination-fixtures.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  address_vectors: {
    name: string;
    address: string;
    default_allowed: boolean;
    private_opt_in_allowed: boolean;
  }[];
  url_vectors: { name: string; url: string; syntax_allowed: boolean }[];
  dns_vectors: {
    name: string;
    answers: string[] | null;
    default_code: string;
    private_opt_in_code: string;
  }[];
};

describe("shared Provider destination policy", () => {
  it.each(["\u0000", "\u0001", "\u001f", "\u007f"])(
    "rejects raw control character %j before URL normalization",
    (control) => {
      expect(() => providerBaseUrl("https://provider.fixture/v1" + control)).toThrow(
        expect.objectContaining({ code: "provider_endpoint_forbidden" }),
      );
    },
  );
  it.each(fixtures.address_vectors)("matches both modes for $name", (vector) => {
    expect(providerAddressAllowed(vector.address, false)).toBe(vector.default_allowed);
    expect(providerAddressAllowed(vector.address, true)).toBe(vector.private_opt_in_allowed);
  });
  it.each(fixtures.url_vectors)("matches URL syntax for $name", (vector) => {
    if (vector.syntax_allowed) expect(providerBaseUrl(vector.url)).toBeInstanceOf(URL);
    else
      expect(() => providerBaseUrl(vector.url)).toThrow(
        expect.objectContaining({ code: "provider_endpoint_forbidden", retryable: false }),
      );
  });
  it.each(fixtures.dns_vectors)("checks all answers for $name", async (vector) => {
    for (const allowPrivateEndpoints of [false, true]) {
      const resolve = vi.fn(() =>
        vector.answers === null
          ? Promise.reject(new Error("private DNS details"))
          : Promise.resolve(vector.answers),
      );
      const policy = new ProviderDestinationPolicy({ allowPrivateEndpoints, resolve });
      const operation = policy.prepare("https://provider.fixture/v1", new AbortController().signal);
      const expected = allowPrivateEndpoints ? vector.private_opt_in_code : vector.default_code;
      if (expected === "allowed") expect((await operation).addresses.length).toBeGreaterThan(0);
      else await expect(operation).rejects.toMatchObject({ code: expected });
      expect(resolve).toHaveBeenCalledTimes(1);
    }
  });
  it("does not resolve a literal or accept an ambiguous mapped/reserved address", async () => {
    const resolve = vi.fn(() => Promise.resolve(["8.8.8.8"]));
    const policy = new ProviderDestinationPolicy({ resolve });
    const endpoint = await policy.prepare(
      "https://[::ffff:8.8.8.8]/v1",
      new AbortController().signal,
    );
    expect(endpoint.addresses).toEqual(["8.8.8.8"]);
    await expect(
      policy.prepare("http://[::ffff:0.0.0.0]/", new AbortController().signal),
    ).rejects.toMatchObject({ code: "provider_endpoint_forbidden" });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("revalidates each request and rejects later rebound answers", async () => {
    const resolve = vi.fn().mockResolvedValueOnce(["8.8.8.8"]).mockResolvedValueOnce(["127.0.0.1"]);
    const policy = new ProviderDestinationPolicy({ resolve });
    const first = await policy.prepare("https://provider.fixture/v1", new AbortController().signal);
    await expect(
      policy.prepare("https://provider.fixture/v1", new AbortController().signal),
    ).rejects.toMatchObject({ code: "provider_endpoint_forbidden" });
    expect(first.addresses).toEqual(["8.8.8.8"]);
    expect(Object.isFrozen(first.addresses)).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it.each([
    { mode: "deadline", late: "success" },
    { mode: "deadline", late: "failure" },
    { mode: "deadline", late: "cleanup failure" },
    { mode: "cancel", late: "success" },
    { mode: "cancel", late: "failure" },
    { mode: "cancel", late: "cleanup failure" },
  ] as const)(
    "joins the original DNS task after $mode before handling its late $late",
    async ({ mode, late }) => {
      const stop = new AbortController();
      const cancellation = new Error("original DNS cancellation");
      const entered = Promise.withResolvers<AbortSignal>();
      const aborted = Promise.withResolvers<void>();
      const addresses = Promise.withResolvers<string[]>();
      const failure = new Error("synthetic-key in private DNS details");
      const cleanup = new ModelTransportCleanupError(failure);
      let resolverTask: Promise<string[]> | undefined;
      let resolverSettled = false;
      const resolve = vi.fn((_host: string, signal: AbortSignal) => {
        const onAbort = () => aborted.resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        entered.resolve(signal);
        resolverTask = addresses.promise.finally(() => {
          resolverSettled = true;
          signal.removeEventListener("abort", onAbort);
        });
        void resolverTask.catch(() => undefined);
        return resolverTask;
      });
      let settled = false;
      const original = new ProviderDestinationPolicy({
        resolve,
        lookupTimeoutMs: mode === "deadline" ? 10 : 1000,
      })
        .prepare("https://provider.fixture/v1", stop.signal)
        .finally(() => {
          settled = true;
        });
      const observed = original.then(
        (endpoint) => ({ endpoint, error: undefined }),
        (error: unknown) => ({ endpoint: undefined, error }),
      );
      try {
        await Promise.race([entered.promise, original]);
        const signal = await entered.promise;
        if (mode === "cancel") stop.abort(cancellation);
        await aborted.promise;
        expect(signal.aborted).toBe(true);
        // Observe a complete event-loop turn after the real abort event. This
        // checks ownership of the held task, not elapsed DNS performance.
        await nextTurn();
        expect(resolverSettled).toBe(false);
        expect(settled).toBe(false);
        if (late === "success") addresses.resolve(["8.8.8.8"]);
        else addresses.reject(late === "cleanup failure" ? cleanup : failure);
        const outcome = await observed;
        expect(resolverSettled).toBe(true);
        expect(settled).toBe(true);
        expect(outcome.endpoint).toBeUndefined();
        const actual = outcome.error;
        if (!(actual instanceof Error)) throw new Error("Expected the joined DNS failure");
        if (late === "cleanup failure") {
          expect(actual).toBe(cleanup);
          expect(actual.cause).toBe(failure);
        } else {
          expect(actual).toMatchObject({
            code: "provider_endpoint_unavailable",
            retryable: true,
            message: "Provider endpoint is unavailable",
          });
          if (late === "failure") expect(actual.cause).toBe(failure);
        }
        expect(actual.message).not.toContain("synthetic-key");
        expect(actual.message).not.toContain("private DNS details");
        expect(resolve).toHaveBeenCalledOnce();
      } finally {
        stop.abort(cancellation);
        addresses.resolve(["8.8.8.8"]);
        await Promise.allSettled([
          addresses.promise,
          original,
          observed,
          ...(resolverTask === undefined ? [] : [resolverTask]),
        ]);
      }
    },
  );
});
