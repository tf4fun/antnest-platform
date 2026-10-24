import { describe, expect, it, vi } from "vitest";
import { RuntimeControllerIncarnations } from "../../src/adapters/runtime-controller-incarnations.js";
import type { ServiceAuthentication } from "../../src/adapters/service-authentication.js";
import { OwnerIncarnationError } from "../../src/application/owner-incarnation.js";

type Cursor = { history_id: string; snapshot_revision: string; after_sequence: string };
type Input = { member_id: string; cursor: Cursor | null };
type Registration = { registration_id: string; member_id: string; incarnation_id: string };
type Page = {
  member_id: string;
  history_id: string;
  snapshot_revision: string;
  after_sequence: string;
  items: Array<{ sequence: string; registration: Registration }>;
  next_cursor: Cursor | null;
};
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Observed<T> = { settled: boolean; promise: Promise<Outcome<T>> };

const historyId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const otherId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const first: Input = { member_id: "acp-a", cursor: null };
const origin = "http://runtime-controller:8080";
const endpoint = `${origin}/internal/acp-incarnations/history`;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function observe<T>(promise: Promise<T>): Observed<T> {
  const tracked: Observed<T> = {
    settled: false,
    promise: undefined as unknown as Promise<Outcome<T>>,
  };
  tracked.promise = promise.then<Outcome<T>, Outcome<T>>(
    (value) => {
      tracked.settled = true;
      return { ok: true, value };
    },
    (error) => {
      tracked.settled = true;
      return { ok: false, error };
    },
  );
  return tracked;
}

function page(revision = 2n, after = 0n, count = 2): Page {
  const items = Array.from({ length: count }, (_, index) => {
    const sequence = after + BigInt(index) + 1n;
    const suffix = sequence.toString(16).padStart(12, "0").slice(-12);
    return {
      sequence: String(sequence),
      registration: {
        registration_id: `00000000-0000-4000-8000-${suffix}`,
        member_id: "acp-a",
        incarnation_id: `10000000-0000-4000-8000-${suffix}`,
      },
    };
  });
  const last = after + BigInt(count);
  return {
    member_id: "acp-a",
    history_id: historyId,
    snapshot_revision: String(revision),
    after_sequence: String(after),
    items,
    next_cursor:
      last < revision
        ? {
            history_id: historyId,
            snapshot_revision: String(revision),
            after_sequence: String(last),
          }
        : null,
  };
}

function json(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fixture(send: typeof fetch) {
  const fetcher = vi.fn<typeof fetch>(send);
  const fetchFor = vi.fn(() => fetcher);
  const authentication = { fetchFor } as unknown as ServiceAuthentication;
  const client = new RuntimeControllerIncarnations({ origin, authentication });
  return { client, fetcher, fetchFor };
}

function unavailable(error: unknown, cleanupFailed = false) {
  expect(error).toBeInstanceOf(OwnerIncarnationError);
  expect(error).toMatchObject({ code: "acp_registry_unavailable" });
  if (cleanupFailed) expect(error).toMatchObject({ cleanupFailed: true, retryable: false });
}

describe("Runtime Controller member history adapter", () => {
  it("accepts a complete 64-entry page larger than 8KiB and sends only the fixed private request", async () => {
    const expected = page(65n, 0n, 64);
    expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(8192);
    expect(Buffer.byteLength(JSON.stringify(expected))).toBeLessThan(32768);
    const { client, fetcher, fetchFor } = fixture(() =>
      Promise.resolve().then(() => json(expected)),
    );
    const input = structuredClone(first);
    expect(await client.history(input, new AbortController().signal)).toEqual(expected);
    expect(input).toEqual(first);
    expect(fetchFor).toHaveBeenCalledTimes(1);
    expect(fetchFor).toHaveBeenCalledWith("runtime-controller", origin);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    const body = init?.body;
    if (typeof body !== "string") throw new TypeError("Expected a JSON history request body");
    expect(JSON.parse(body)).toEqual({ member_id: "acp-a", cursor: null });
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("captures the original continuation before a caller mutates it during the original fetch", async () => {
    const entered = gate(),
      release = gate();
    const expected = page(65n, 64n, 1);
    const input: Input = {
      member_id: "acp-a",
      cursor: { history_id: historyId, snapshot_revision: "65", after_sequence: "64" },
    };
    const original = structuredClone(input);
    const { client, fetcher } = fixture(async () => {
      entered.release();
      await release.promise;
      return json(expected);
    });
    const pending = observe(client.history(input, new AbortController().signal));
    try {
      await entered.promise;
      input.member_id = "acp-foreign";
      input.cursor!.history_id = otherId;
      input.cursor!.snapshot_revision = "66";
      input.cursor!.after_sequence = "0";
      expect(pending.settled).toBe(false);
      release.release();
      expect(await pending.promise).toEqual({ ok: true, value: expected });
      const body = fetcher.mock.calls[0]![1]?.body;
      if (typeof body !== "string") throw new TypeError("Expected a JSON history request body");
      expect(JSON.parse(body)).toEqual(original);
      expect(input.member_id).toBe("acp-foreign");
      expect(input.cursor!.history_id).toBe(otherId);
    } finally {
      release.release();
      await pending.promise;
    }
  });

  it("retains empty revision zero and the signed-int64 maximum without numeric rounding", async () => {
    const maximum = 9223372036854775807n;
    const empty = page(0n, 0n, 0);
    const last = page(maximum, maximum - 1n, 1);
    const { client, fetcher } = fixture(() => Promise.resolve().then(() => json(empty)));
    expect(await client.history(first, new AbortController().signal)).toEqual(empty);
    fetcher.mockResolvedValueOnce(json(last));
    expect(
      await client.history(
        {
          member_id: "acp-a",
          cursor: {
            history_id: historyId,
            snapshot_revision: String(maximum),
            after_sequence: String(maximum - 1n),
          },
        },
        new AbortController().signal,
      ),
    ).toEqual(last);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts exactly 32KiB including legal trailing whitespace", async () => {
    const expected = page(64n, 0n, 64);
    const encoded = JSON.stringify(expected);
    const raw = encoded + " ".repeat(32768 - Buffer.byteLength(encoded));
    const { client } = fixture(() =>
      Promise.resolve().then(
        () =>
          new Response(raw, {
            headers: { "Content-Type": "application/json", "Content-Length": "32768" },
          }),
      ),
    );
    expect(await client.history(first, new AbortController().signal)).toEqual(expected);
  });

  it.each(["declared", "actual"] as const)(
    "rejects an oversized %s response without retry",
    async (mode) => {
      const encoded = JSON.stringify(page());
      const raw =
        mode === "actual" ? encoded + " ".repeat(32769 - Buffer.byteLength(encoded)) : encoded;
      const { client, fetcher } = fixture(() =>
        Promise.resolve().then(
          () =>
            new Response(raw, {
              headers: {
                "Content-Type": "application/json",
                ...(mode === "declared" ? { "Content-Length": "32769" } : {}),
              },
            }),
        ),
      );
      const result = await observe(client.history(first, new AbortController().signal)).promise;
      expect(result.ok).toBe(false);
      if (!result.ok) unavailable(result.error);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  const invalidPages: Array<{
    name: string;
    change(value: Page): unknown;
    continuation?: boolean;
  }> = [
    { name: "foreign member", change: (value) => ({ ...value, member_id: "acp-b" }) },
    {
      name: "foreign tuple",
      change: (value) => {
        value.items[0]!.registration.member_id = "acp-b";
        return value;
      },
    },
    {
      name: "invalid registration",
      change: (value) => {
        value.items[0]!.registration.registration_id = "not-a-registration";
        return value;
      },
    },
    {
      name: "duplicate tuple",
      change: (value) => {
        value.items[1]!.registration = value.items[0]!.registration;
        return value;
      },
    },
    {
      name: "duplicate sequence",
      change: (value) => {
        value.items[1]!.sequence = "1";
        return value;
      },
    },
    {
      name: "sequence gap",
      change: (value) => {
        value.items[1]!.sequence = "3";
        return value;
      },
    },
    {
      name: "missing entry",
      change: (value) => {
        value.items.pop();
        return value;
      },
    },
    { name: "more than 64 entries", change: () => page(65n, 0n, 65) },
    { name: "noncanonical revision", change: (value) => ({ ...value, snapshot_revision: "02" }) },
    { name: "revision newline", change: (value) => ({ ...value, snapshot_revision: "2\n" }) },
    { name: "position newline", change: (value) => ({ ...value, after_sequence: "0\n" }) },
    {
      name: "revision overflow",
      change: (value) => ({ ...value, snapshot_revision: "9223372036854775808" }),
    },
    {
      name: "sequence overflow",
      change: (value) => {
        value.items[0]!.sequence = "9223372036854775808";
        return value;
      },
    },
    {
      name: "after overflow",
      change: (value) => ({ ...value, after_sequence: "9223372036854775808" }),
    },
    { name: "first page starts late", change: () => page(3n, 1n, 2) },
    {
      name: "continuation changes history",
      continuation: true,
      change: (value) => ({ ...value, history_id: otherId }),
    },
    {
      name: "continuation changes revision",
      continuation: true,
      change: (value) => ({ ...value, snapshot_revision: "66" }),
    },
    {
      name: "continuation changes after",
      continuation: true,
      change: (value) => ({ ...value, after_sequence: "63" }),
    },
    {
      name: "terminal next cursor",
      change: (value) => ({
        ...value,
        next_cursor: { history_id: historyId, snapshot_revision: "2", after_sequence: "2" },
      }),
    },
    { name: "unknown page field", change: (value) => ({ ...value, stop_receipt: {} }) },
    {
      name: "unknown tuple field",
      change: (value) => {
        Object.assign(value.items[0]!.registration, { scope: "foreign" });
        return value;
      },
    },
  ];
  it.each(invalidPages)(
    "rejects $name rather than returning a partial or foreign history",
    async (scenario) => {
      const { continuation } = scenario;
      const input: Input = continuation
        ? {
            member_id: "acp-a",
            cursor: {
              history_id: historyId,
              snapshot_revision: "65",
              after_sequence: "64",
            },
          }
        : first;
      const { client, fetcher } = fixture(() =>
        Promise.resolve().then(() =>
          json(scenario.change(continuation ? page(65n, 64n, 1) : page())),
        ),
      );
      const result = await observe(client.history(input, new AbortController().signal)).promise;
      expect(result.ok).toBe(false);
      if (!result.ok) unavailable(result.error);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["missing", "foreign-history", "changed-revision", "wrong-position"] as const)(
    "rejects a %s nonterminal next cursor",
    async (kind) => {
      const value = page(65n, 0n, 64);
      if (kind === "missing") value.next_cursor = null;
      else if (kind === "foreign-history") value.next_cursor!.history_id = otherId;
      else if (kind === "changed-revision") value.next_cursor!.snapshot_revision = "66";
      else value.next_cursor!.after_sequence = "63";
      const { client } = fixture(() => Promise.resolve().then(() => json(value)));
      const result = await observe(client.history(first, new AbortController().signal)).promise;
      expect(result.ok).toBe(false);
      if (!result.ok) unavailable(result.error);
    },
  );

  it.each([
    { member_id: "ACP-A", cursor: null },
    { member_id: "acp-a\n", cursor: null },
    { member_id: "acp-a" },
    { ...first, scope: "foreign" },
    {
      member_id: "acp-a",
      cursor: { history_id: historyId, snapshot_revision: "01", after_sequence: "0" },
    },
    {
      member_id: "acp-a",
      cursor: {
        history_id: historyId,
        snapshot_revision: "9223372036854775808",
        after_sequence: "0",
      },
    },
    {
      member_id: "acp-a",
      cursor: { history_id: historyId, snapshot_revision: "1", after_sequence: "1" },
    },
  ])("rejects invalid input before opening a request: %j", async (input) => {
    const { client, fetcher } = fixture(() => Promise.resolve().then(() => json(page())));
    await expect(
      client.history(input as Input, new AbortController().signal),
    ).rejects.toBeInstanceOf(OwnerIncarnationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a 403 terminal and makes exactly one original attempt", async () => {
    const { client, fetcher } = fixture(() =>
      Promise.resolve().then(
        () =>
          new Response(
            JSON.stringify({
              code: "acp_member_not_allowed",
              message: "ACP incarnation request did not complete",
              retryable: false,
            }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const result = await observe(client.history(first, new AbortController().signal)).promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      unavailable(result.error);
      expect(result.error).toMatchObject({ retryable: false });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("joins an original fetch that returns its body only after cancellation", async () => {
    const entered = gate(),
      aborted = gate(),
      release = gate();
    const body = trackedBody("cancel");
    const parent = new AbortController();
    const { client, fetcher } = fixture(async (_url, init) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => aborted.release(), { once: true });
      entered.release();
      await release.promise;
      return body.response;
    });
    const pending = observe(client.history(first, parent.signal));
    try {
      await entered.promise;
      parent.abort(new Error("cancel original history request"));
      await aborted.promise;
      expect(pending.settled).toBe(false);
      release.release();
      await body.cancelEntered.promise;
      await body.originalClosed.promise;
      expect(pending.settled).toBe(false);
      body.release();
      const result = await pending.promise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: "deadline_exceeded" });
      body.expectJoined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      parent.abort();
      release.release();
      body.release();
      await pending.promise;
    }
  });

  it.each(["cancel", "closed"] as const)(
    "does not return a successful page before the original %s receipt joins",
    async (stage) => {
      const body = trackedBody(stage);
      const { client } = fixture(() => Promise.resolve(body.response));
      const pending = observe(client.history(first, new AbortController().signal));
      try {
        await body.cancelEntered.promise;
        await body.closedEntered.promise;
        expect(pending.settled).toBe(false);
        expect(body.lockReleased).toBe(false);
        body.release();
        expect(await pending.promise).toEqual({ ok: true, value: page() });
        body.expectJoined();
      } finally {
        body.release();
        await pending.promise;
      }
    },
  );

  it("joins the original pending read and retains an independent cancellation cleanup failure", async () => {
    const body = trackedBody("cancel", { leaveOpen: true, failCleanup: true });
    const parent = new AbortController();
    const { client, fetcher } = fixture(() => Promise.resolve(body.response));
    const pending = observe(client.history(first, parent.signal));
    try {
      await body.pendingRead.promise;
      parent.abort(new Error("history consumer cancelled"));
      await body.cancelEntered.promise;
      await body.originalClosed.promise;
      await Promise.all(body.reads.map((read) => read.promise));
      expect(pending.settled).toBe(false);
      expect(body.lockReleased).toBe(false);
      body.release();
      const result = await pending.promise;
      expect(result.ok).toBe(false);
      if (!result.ok) unavailable(result.error, true);
      body.expectJoined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      parent.abort();
      body.release();
      await pending.promise;
    }
  });
});

// Real stream operations remain the originals. Gates delay only their returned
// cleanup receipts; releasing a gate never pretends that a read or close finished.
function trackedBody(
  stage: "cancel" | "closed",
  options: { leaveOpen?: boolean; failCleanup?: boolean } = {},
) {
  const held = gate(),
    cancelEntered = gate(),
    closedEntered = gate(),
    pendingRead = gate();
  const sentinel = new Error("PRIVATE_HISTORY_CLEANUP_FAILURE");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(page())));
      if (!options.leaveOpen) controller.close();
    },
  });
  const response = new Response(stream, { headers: { "Content-Type": "application/json" } });
  const getReader = stream.getReader.bind(stream);
  const reads: Array<Observed<ReadableStreamReadResult<Uint8Array>>> = [];
  const cancels: Array<Observed<void>> = [];
  const receipts: Array<Observed<void>> = [];
  const closed = gate();
  const record = {
    response,
    reads,
    cancels,
    cancelEntered,
    closedEntered,
    pendingRead,
    originalClosed: closed,
    lockReleased: false,
    release: held.release,
    expectJoined() {
      expect(record.lockReleased).toBe(true);
      expect(reads.length).toBeGreaterThanOrEqual(options.leaveOpen ? 2 : 0);
      expect(reads.every((read) => read.settled)).toBe(true);
      expect(cancels.length).toBeGreaterThan(0);
      expect(cancels.every((cancel) => cancel.settled)).toBe(true);
      expect(receipts.every((receipt) => receipt.settled)).toBe(true);
    },
  };
  Object.defineProperty(stream, "getReader", {
    configurable: true,
    value: () => {
      const reader = getReader();
      const originalRead = reader.read.bind(reader);
      const originalCancel = reader.cancel.bind(reader);
      const originalRelease = reader.releaseLock.bind(reader);
      const actualClosed = reader.closed;
      void actualClosed.then(closed.release, closed.release);
      const closedReceipt = actualClosed.then(async () => {
        closedEntered.release();
        if (stage === "closed") await held.promise;
      });
      receipts.push(observe(closedReceipt));
      Object.defineProperty(reader, "closed", { configurable: true, value: closedReceipt });
      Object.defineProperty(reader, "read", {
        configurable: true,
        value: () => {
          const original = originalRead();
          reads.push(observe(original));
          if (reads.length === 2) pendingRead.release();
          return original;
        },
      });
      Object.defineProperty(reader, "cancel", {
        configurable: true,
        value: (reason?: unknown) => {
          const original = originalCancel(reason);
          cancels.push(observe(original));
          const receipt = original.then(async () => {
            await actualClosed;
            cancelEntered.release();
            if (stage === "cancel") await held.promise;
            if (options.failCleanup) throw sentinel;
          });
          receipts.push(observe(receipt));
          return receipt;
        },
      });
      Object.defineProperty(reader, "releaseLock", {
        configurable: true,
        value: () => {
          expect(
            reads.every((read) => read.settled),
            "released before the original read joined",
          ).toBe(true);
          expect(
            cancels.every((cancel) => cancel.settled),
            "released before the original cancellation joined",
          ).toBe(true);
          expect(
            receipts.every((receipt) => receipt.settled),
            "released before returned cleanup receipts joined",
          ).toBe(true);
          originalRelease();
          record.lockReleased = true;
        },
      });
      return reader;
    },
  });
  return record;
}
