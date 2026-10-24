import { describe, expect, it, vi } from "vitest";
import {
  replayPublicationOnce,
  type PublicationResponse,
} from "./publication-replay.js";

const unavailable = (): PublicationResponse => ({
  status: 503,
  body: { code: "configuration_unavailable", retryable: true },
});

describe("one bounded publication replay", () => {
  it("returns the original successful response without another request", async () => {
    const response = { status: 200, body: { applied_revision: 1 } };
    const signal = new AbortController().signal;
    const request = vi.fn(() => Promise.resolve(response));
    await expect(replayPublicationOnce(request, signal)).resolves.toBe(
      response,
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(signal);
  });

  it("replays only a completed retryable configuration failure with the same original signal", async () => {
    const first = unavailable();
    const second = { status: 200, body: { applied_revision: 1 } };
    const receipts: PublicationResponse[] = [];
    const signal = new AbortController().signal;
    const request = vi.fn<
      (signal: AbortSignal) => Promise<PublicationResponse>
    >(() => {
      const response = receipts.length === 0 ? first : second;
      receipts.push(response);
      return Promise.resolve(response);
    });
    await expect(replayPublicationOnce(request, signal)).resolves.toBe(second);
    expect(request.mock.calls).toEqual([[signal], [signal]]);
    expect(request.mock.calls[0]?.[0]).toBe(signal);
    expect(request.mock.calls[1]?.[0]).toBe(signal);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toBe(first);
    expect(receipts[1]).toBe(second);
  });

  it.each([
    {
      status: 502,
      body: { code: "configuration_unavailable", retryable: true },
    },
    { status: 503, body: { code: "dependency_unavailable", retryable: true } },
    {
      status: 503,
      body: { code: "configuration_unavailable", retryable: false },
    },
    { status: 503, body: { code: "configuration_unavailable", retryable: 1 } },
    { status: 503, body: null },
    { status: 503, body: "configuration_unavailable" },
  ])("does not replay an ineligible response: %j", async (response) => {
    const signal = new AbortController().signal;
    const request = vi.fn(() => Promise.resolve(response));
    await expect(replayPublicationOnce(request, signal)).resolves.toBe(
      response,
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(signal);
  });

  it("returns the second original failure without a third request", async () => {
    const first = unavailable();
    const second = unavailable();
    const signal = new AbortController().signal;
    const request = vi
      .fn<(signal: AbortSignal) => Promise<PublicationResponse>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    await expect(replayPublicationOnce(request, signal)).resolves.toBe(second);
    expect(request.mock.calls).toEqual([[signal], [signal]]);
  });

  it("joins the first request's original response cleanup before issuing the replay", async () => {
    const first = unavailable();
    const second = { status: 200, body: { applied_revision: 1 } };
    const entered = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const signal = new AbortController().signal;
    const request = vi
      .fn<(signal: AbortSignal) => Promise<PublicationResponse>>()
      .mockImplementationOnce(async () => {
        entered.resolve();
        await cleanup.promise;
        return first;
      })
      .mockResolvedValue(second);
    let completed = false;
    const original = replayPublicationOnce(request, signal).finally(() => {
      completed = true;
    });
    const joined = original.catch(() => undefined);
    try {
      await Promise.race([
        entered.promise,
        original.then(() => {
          throw new Error("The original held request was bypassed");
        }),
      ]);
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(request).toHaveBeenCalledOnce();
      cleanup.resolve();
      await expect(original).resolves.toBe(second);
      expect(request.mock.calls).toEqual([[signal], [signal]]);
    } finally {
      cleanup.resolve();
      await joined;
    }
  });

  it.each([1, 2])(
    "joins original attempt %i after abort and never dispatches another request",
    async (heldAttempt) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const abort = new AbortController();
      const reason = new Error("original publication deadline expired");
      const first = unavailable();
      const second = { status: 200, body: { applied_revision: 1 } };
      let calls = 0;
      const request = vi.fn<
        (signal: AbortSignal) => Promise<PublicationResponse>
      >(async () => {
        calls++;
        if (calls === heldAttempt) {
          entered.resolve();
          await release.promise;
        }
        return calls === 1 ? first : second;
      });
      let completed = false;
      const original = replayPublicationOnce(request, abort.signal).finally(
        () => {
          completed = true;
        },
      );
      const joined = original.catch(() => undefined);
      try {
        await Promise.race([
          entered.promise,
          original.then(() => {
            throw new Error("The original held request was bypassed");
          }),
        ]);
        abort.abort(reason);
        await Promise.resolve();
        expect(completed).toBe(false);
        expect(request).toHaveBeenCalledTimes(heldAttempt);
        release.resolve();
        await expect(original).rejects.toBe(reason);
        expect(request.mock.calls).toEqual(
          Array.from({ length: heldAttempt }, () => [abort.signal]),
        );
        for (const [received] of request.mock.calls)
          expect(received).toBe(abort.signal);
      } finally {
        abort.abort(reason);
        release.resolve();
        await joined;
      }
    },
  );

  it.each([1, 2])(
    "preserves an original request or cleanup failure from attempt %i",
    async (failedAttempt) => {
      const failure = new Error("original request, parse or cleanup failed");
      const signal = new AbortController().signal;
      const request =
        vi.fn<(signal: AbortSignal) => Promise<PublicationResponse>>();
      if (failedAttempt === 2) request.mockResolvedValueOnce(unavailable());
      request.mockRejectedValue(failure);
      await expect(replayPublicationOnce(request, signal)).rejects.toBe(
        failure,
      );
      expect(request.mock.calls).toEqual(
        Array.from({ length: failedAttempt }, () => [signal]),
      );
    },
  );
});
