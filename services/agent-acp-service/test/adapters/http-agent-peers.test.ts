import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { HttpAgentPeers } from "../../src/adapters/http-agent-peers.js";

const source = { registration_id: randomUUID(), member_id: "acp-a", incarnation_id: randomUUID() };
const target = { registration_id: randomUUID(), member_id: "acp-b", incarnation_id: randomUUID() };
const membership = "a".repeat(64);
const identity = () => ({
  request_id: randomUUID(),
  deadline_at: new Date(Date.now() + 2000).toISOString(),
  membership_sha256: membership,
  source,
  target_member_id: "acp-b",
  challenge: "b".repeat(64),
});
function client(send: typeof fetch) {
  return new HttpAgentPeers({
    memberId: "acp-a",
    membership: {
      clusterId: randomUUID(),
      sha256: membership,
      members: [
        { member_id: "acp-a", origin: "http://acp-a.internal" },
        { member_id: "acp-b", origin: "http://acp-b.internal" },
      ],
    },
    fetchFor: () => send,
  });
}

it("pins endpoint and request identity and reads only a closed valid receipt", async () => {
  const request = identity();
  const receipt = {
    request_id: request.request_id,
    membership_sha256: membership,
    challenge: request.challenge,
    registration: target,
  };
  const send = vi.fn<typeof fetch>((_input, init) => {
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
    expect(JSON.parse(init.body)).toEqual(request);
    return Promise.resolve(Response.json(receipt));
  });
  expect(await client(send).identify("acp-b", request, new AbortController().signal)).toEqual(
    receipt,
  );
  expect(send.mock.calls[0]?.[0]).toBe("http://acp-b.internal/internal/acp-peer/identity");
});

it("rejects expired/extended deadlines and source/target/catalog substitutions before any request", async () => {
  const send = vi.fn<typeof fetch>();
  const peers = client(send);
  const original = identity();
  for (const request of [
    { ...original, deadline_at: new Date(Date.now() - 1).toISOString() },
    { ...original, deadline_at: new Date(Date.now() + 20000).toISOString() },
    { ...original, deadline_at: "2026-02-30T10:00:00Z" },
    { ...original, target_member_id: "acp-c" },
    { ...original, source: { ...source, member_id: "acp-c" } },
    { ...original, membership_sha256: "c".repeat(64) },
    { ...original, destination: "http://other.invalid" },
  ])
    await expect(peers.identify("acp-b", request, new AbortController().signal)).rejects.toThrow();
  await expect(peers.identify("acp-a", original, new AbortController().signal)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

it("rejects a receipt that finishes after the absolute deadline before the timer callback runs", async () => {
  const request = identity();
  const clock = vi.spyOn(Date, "now");
  const send: typeof fetch = () => {
    clock.mockReturnValue(Date.parse(request.deadline_at) + 1);
    return Promise.resolve(
      Response.json({
        request_id: request.request_id,
        membership_sha256: membership,
        challenge: request.challenge,
        registration: target,
      }),
    );
  };
  try {
    await expect(
      client(send).identify("acp-b", request, new AbortController().signal),
    ).rejects.toHaveProperty("code", "deadline_exceeded");
  } finally {
    clock.mockRestore();
  }
});

it("retains the original fetch after cancellation until a late response has actually closed", async () => {
  const entered = Promise.withResolvers<void>();
  const original = Promise.withResolvers<Response>();
  const close = Promise.withResolvers<void>();
  let cancelling = false;
  const caller = new AbortController();
  const send = vi.fn<typeof fetch>(async () => {
    entered.resolve();
    return original.promise;
  });
  let complete = false;
  const result = client(send)
    .identify("acp-b", identity(), caller.signal)
    .then(
      () => "success",
      () => "failed",
    )
    .finally(() => {
      complete = true;
    });
  const response = new Response(
    new ReadableStream({
      cancel: async () => {
        cancelling = true;
        await close.promise;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  try {
    await entered.promise;
    caller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(complete).toBe(false);
    original.resolve(response);
    await vi.waitFor(() => expect(cancelling).toBe(true));
    expect(complete).toBe(false);
    close.resolve();
    expect(await result).toBe("failed");
  } finally {
    caller.abort();
    original.resolve(response);
    close.resolve();
    await result;
  }
});

it("retains an independent cancellation failure even after a malformed response", async () => {
  const cleanup = new Error("independent cleanup failed");
  const send = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(new ReadableStream({ cancel: () => Promise.reject(cleanup) }), {
        headers: { "content-type": "text/plain" },
      }),
    ),
  );
  const error = await client(send)
    .identify("acp-b", identity(), new AbortController().signal)
    .catch((failure: unknown) => failure);
  expect(error).toHaveProperty("code", "configuration_unavailable");
  expect(error).toHaveProperty("cause");
  expect((error as Error).cause).toBeInstanceOf(AggregateError);
  expect(((error as Error).cause as AggregateError).errors).toContain(cleanup);
});

it("waits for and preserves a late cleanup failure after the parent has aborted", async () => {
  const reading = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const failure = new Error("late original cleanup failed");
  const caller = new AbortController();
  const send: typeof fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          pull: () => {
            reading.resolve();
          },
          cancel: () => {
            cancelled.resolve();
            return cleanup.promise;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  let completed = false;
  const result = client(send)
    .identify("acp-b", identity(), caller.signal)
    .catch((error: unknown) => error)
    .finally(() => {
      completed = true;
    });
  try {
    await reading.promise;
    caller.abort();
    await cancelled.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    cleanup.reject(failure);
    const error = await result;
    expect(error).toHaveProperty("code", "deadline_exceeded");
    expect(((error as Error).cause as AggregateError).errors).toContain(failure);
  } finally {
    caller.abort();
    cleanup.resolve();
    await result;
  }
});

it.each([
  () => new Response("{}", { status: 302, headers: { location: "http://other.invalid" } }),
  () => new Response("{}", { headers: { "content-type": "text/plain" } }),
  () =>
    new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "9000" },
    }),
  () => new Response(" ".repeat(8193), { headers: { "content-type": "application/json" } }),
  () =>
    new Response('{"request_id":"a","request_id":"b"}', {
      headers: { "content-type": "application/json" },
    }),
])("rejects invalid status/media/size or duplicate JSON keys", async (response) => {
  await expect(
    client(() => Promise.resolve(response())).identify(
      "acp-b",
      identity(),
      new AbortController().signal,
    ),
  ).rejects.toHaveProperty("code", "configuration_unavailable");
});
