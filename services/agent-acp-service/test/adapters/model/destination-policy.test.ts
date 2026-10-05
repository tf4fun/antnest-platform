import { readFileSync } from "node:fs";
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
  it.each(["deadline", "cancel"])(
    "bounds pending DNS by %s without exposing errors",
    async (mode) => {
      const stop = new AbortController();
      let stopped = false;
      const resolve = vi.fn(
        (_host: string, signal: AbortSignal) =>
          new Promise<string[]>((_done, fail) => {
            signal.addEventListener(
              "abort",
              () => {
                stopped = true;
                fail(new Error("synthetic-key in private DNS details"));
              },
              { once: true },
            );
          }),
      );
      const operation = new ProviderDestinationPolicy({
        resolve,
        lookupTimeoutMs: mode === "deadline" ? 10 : 1000,
      }).prepare("https://provider.fixture/v1", stop.signal);
      if (mode === "cancel") stop.abort();
      await expect(operation).rejects.toMatchObject({
        code: "provider_endpoint_unavailable",
        retryable: true,
        message: "Provider endpoint is unavailable",
      });
      expect(stopped).toBe(true);
    },
  );
});
