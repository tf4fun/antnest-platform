import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatibleModel } from "../../../src/adapters/model/openai-compatible.js";
import {
  ModelError,
  ModelTransportCleanupError,
  type AuthenticatedModelRequest,
} from "../../../src/ports/model.js";
import { snapshot } from "../../support/fixtures.js";
import { syntheticProviderDestination } from "../../support/model-network.js";

const now = Date.parse("2026-10-25T00:00:00.000Z");

function request(): AuthenticatedModelRequest {
  return {
    snapshot: snapshot(),
    credential: "synthetic",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  };
}

function adapter(response: Response) {
  return new OpenAICompatibleModel({
    destination: syntheticProviderDestination,
    fetchFn: () => Promise.resolve(response),
  });
}

async function httpFailure(status: number, retryAfter?: string): Promise<ModelError> {
  const response = new Response(null, {
    status,
    headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
  });
  const error: unknown = await adapter(response)
    .complete(request())
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ModelError);
  if (!(error instanceof ModelError)) throw new Error("Expected the original HTTP ModelError");
  expect(error).toMatchObject({ code: "model_http_error", status });
  return error;
}

function causes(error: unknown): unknown[] {
  return [
    error,
    ...(error instanceof AggregateError ? error.errors.flatMap(causes) : []),
    ...(error instanceof Error && Object.hasOwn(error, "cause") ? causes(error.cause) : []),
  ];
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => vi.restoreAllMocks());

describe("HTTP model attempt Retry-After propagation", () => {
  it.each([
    { status: 429, header: "2", milliseconds: 2000 },
    { status: 429, header: "0", milliseconds: 0 },
    { status: 503, header: new Date(now + 2000).toUTCString(), milliseconds: 2000 },
    { status: 503, header: new Date(now - 2000).toUTCString(), milliseconds: 0 },
    { status: 503, header: "Sunday, 25-Oct-26 00:00:02 GMT", milliseconds: 2000 },
    { status: 503, header: "Sun Oct 25 00:00:02 2026", milliseconds: 2000 },
    { status: 503, header: "Sunday, 25-Oct-65 00:00:02 GMT", milliseconds: 30000 },
    { status: 503, header: "Sunday, 25-Oct-80 00:00:02 GMT", milliseconds: 0 },
    { status: 429, header: "9".repeat(400), milliseconds: 30000 },
  ])(
    "retains bounded delay for HTTP $status: $header",
    async ({ status, header, milliseconds }) => {
      const error = await httpFailure(status, header);
      expect(error.retryable).toBe(true);
      expect(error.retryAfterMs).toBe(milliseconds);
      expect(Number.isSafeInteger(error.retryAfterMs)).toBe(true);
    },
  );

  it.each(["not-a-date", "-1", "1.5", "0.5", "", undefined])(
    "ignores malformed or absent Retry-After: %s",
    async (header) => {
      const error = await httpFailure(429, header);
      expect(error.retryable).toBe(true);
      expect(error.retryAfterMs).toBeUndefined();
    },
  );

  it.each([400, 401])(
    "does not make HTTP %i retryable because it has a Retry-After header",
    async (status) => {
      const error = await httpFailure(status, "2");
      expect(error.retryable).toBe(false);
    },
  );

  it("does not copy the header onto an invalid successful completion", async () => {
    const error: unknown = await adapter(
      Response.json({ choices: [] }, { headers: { "retry-after": "2" } }),
    )
      .complete(request())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    if (!(error instanceof ModelError)) throw new Error("Expected an invalid completion error");
    expect(error.code).toBe("model_invalid_response");
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("joins original error-body cancellation before rejecting with the HTTP delay", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancel = vi.fn(() => {
      entered.resolve();
      return release.promise;
    });
    const body = new ReadableStream<Uint8Array>({ cancel });
    let completed = false;
    const original = adapter(new Response(body, { status: 429, headers: { "retry-after": "2" } }))
      .complete(request())
      .finally(() => {
        completed = true;
      });
    const joined = original.catch(() => undefined);
    try {
      await Promise.race([
        entered.promise,
        original.then(() => {
          throw new Error("The original body cancellation was bypassed");
        }),
      ]);
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce();
      expect(completed).toBe(false);
      release.resolve();
      await expect(original).rejects.toMatchObject({
        code: "model_http_error",
        status: 429,
        retryable: true,
        retryAfterMs: 2000,
      });
    } finally {
      release.resolve();
      await joined;
    }
  });

  it("retains an independent original body cancellation failure as non-retryable cleanup", async () => {
    const failure = new Error("original HTTP error body cancellation failed");
    const cancel = vi.fn(() => Promise.reject(failure));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const error: unknown = await adapter(
      new Response(body, { status: 429, headers: { "retry-after": "2" } }),
    )
      .complete(request())
      .catch((caught: unknown) => caught);
    expect(cancel).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(ModelTransportCleanupError);
    expect(error).toMatchObject({ retryable: false, outputStarted: false });
    const originalErrors = causes(error);
    expect(originalErrors).toContain(failure);
    const originalHttpError = originalErrors.find(
      (original) => original instanceof ModelError && original.code === "model_http_error",
    );
    expect(originalHttpError).toBeInstanceOf(ModelError);
    expect(originalHttpError).toMatchObject({ status: 429, retryable: true, retryAfterMs: 2000 });
  });
});
