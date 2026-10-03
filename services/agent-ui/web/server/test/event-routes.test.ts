import { TestRequest as Request } from "./support/auth-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventHandler } from "../src/http/event-routes.ts";
import { StreamCapacityError, StreamJournal } from "../src/bridge/stream-journal.ts";
import { SessionNotFoundError } from "../src/adapters/acp-http.ts";

const path =
  "http://localhost/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1&cursor=initial";
const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-agent-id": "agent-1",
};

test("missing selected Session event stream returns permanent absence", async () => {
  const handler = createEventHandler({
    async subscribe() { throw new SessionNotFoundError(); },
  });
  const response = await handler(new Request(path, { headers }));
  assert.equal(response?.status, 404);
  assert.deepEqual(((await response?.json()) as { code: string; retryable: boolean }).code,
    "session_not_found");
});

test("EventSource reconnect prefers Last-Event-ID and releases its owner lease on cancel", async () => {
  let seenCursor: string | null = null;
  let seenSessionId: string | null = null;
  let released = 0;
  const handler = createEventHandler({
    async subscribe(_scope, sessionId, cursor) {
      seenSessionId = sessionId;
      seenCursor = cursor;
      async function* events() {
        yield {
          type: "reset" as const,
          agentId: "agent-1",
          bridgeEpoch: "epoch-1",
          projectionId: "projection-1",
          fromStreamRevision: 0,
          toStreamRevision: 0,
          cursor: "next",
          view: { streamCursor: "next" },
        };
      }
      return {
        events: events(),
        release: () => {
          released += 1;
        },
      };
    },
  });
  assert.equal((await handler(new Request(path)))?.status, 401);
  assert.equal(
    (
      await handler(
        new Request(path, {
          headers: { ...headers, "x-antnest-agent-id": "agent-2" },
        }),
      )
    )?.status,
    403,
  );
  const response = await handler(
    new Request(path, {
      headers: { ...headers, "last-event-id": "reconnect" },
    }),
  );
  assert.equal(seenCursor, "reconnect");
  const reader = response!.body!.getReader();
  const frame = new TextDecoder().decode((await reader.read()).value);
  assert.match(frame, /^id: next\nevent: reset\ndata: /u);
  await reader.cancel();
  assert.equal(released, 1);
  const agentOnly = await handler(new Request(path.split("?")[0]!, { headers }));
  assert.equal(agentOnly?.status, 200);
  assert.equal(seenSessionId, null);
  await agentOnly?.body?.cancel();
});

test("EventSource reports stream capacity before opening a response", async () => {
  const handler = createEventHandler({
    async subscribe() { throw new StreamCapacityError(); },
  });
  const response = await handler(new Request(path, { headers }));
  assert.equal(response?.status, 429);
  assert.equal((await response?.json()).code, "stream_capacity_exceeded");
});

test("SSE reuses the journal's encoded event across HTTP delivery", async () => {
  const journal = new StreamJournal({ scope: { organizationId: "org-1",
    principalId: "user-1", agentId: "agent-1" }, sessionId: "session-1",
    epoch: "epoch-1", projectionId: "projection-1", key: Buffer.alloc(32, 7) });
  const cut = journal.snapshot((cursor) => ({ streamCursor: cursor }));
  const handler = createEventHandler({ async subscribe(_scope, _sessionId, cursor) {
    return { events: journal.subscribe(cursor, (next) => ({ streamCursor: next })),
      release() {} };
  } });
  const response = await handler(new Request(path, { headers: {
    ...headers, "last-event-id": cut.cursor } }));
  assert.equal(response?.status, 200);
  const reader = response!.body!.getReader();
  const stringify = JSON.stringify;
  let encodings = 0;
  JSON.stringify = ((value: unknown, ...options: unknown[]) => {
    if (value && typeof value === "object" && "operation" in value &&
      "toStreamRevision" in value) encodings++;
    return (stringify as (...args: unknown[]) => string | undefined)(value, ...options);
  }) as typeof JSON.stringify;
  try {
    const event = journal.publish({ type: "operation",
      operation: { operationId: "intent-1" } });
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.match(frame, /"operationId":"intent-1"/u);
    assert.equal(JSON.parse(frame.split("data: ")[1]!.trim()).cursor, event.cursor);
    assert.equal(encodings, 1);
  } finally { JSON.stringify = stringify; await reader.cancel(); journal.close(); }
});

test("concurrent HTTP observers share one encoded SSE frame", async () => {
  const journal = new StreamJournal({ scope: { organizationId: "org-1",
    principalId: "user-1", agentId: "agent-1" }, sessionId: "session-1",
    epoch: "epoch-1", projectionId: "projection-1", key: Buffer.alloc(32, 7),
    maxSubscribers: 4 });
  const cut = journal.snapshot((cursor) => ({ streamCursor: cursor }));
  const handler = createEventHandler({ async subscribe(_scope, _sessionId, cursor) {
    return { events: journal.subscribe(cursor, (next) => ({ streamCursor: next })),
      release() {} };
  } });
  const readers = [];
  try {
    for (let index = 0; index < 4; index++) {
      const response = await handler(new Request(path, { headers: {
        ...headers, "last-event-id": cut.cursor } }));
      assert.equal(response?.status, 200);
      readers.push(response!.body!.getReader());
    }
    const event = journal.publish({ type: "operation",
      operation: { operationId: "intent-1", note: "x".repeat(8192) } });
    const chunks = await Promise.all(readers.map(async (reader) => (await reader.read()).value));
    assert.ok(chunks.every((chunk) => chunk instanceof Uint8Array));
    assert.ok(chunks.every((chunk) => chunk === chunks[0]),
      "One event must reuse the same UTF-8 frame across observers");
    const frame = new TextDecoder().decode(chunks[0]);
    assert.match(frame, new RegExp(`^id: ${event.cursor}\\nevent: operation\\ndata: `, "u"));
    assert.equal(JSON.parse(frame.split("data: ")[1]!.trim()).operation.note.length, 8192);
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel()));
    journal.close();
  }
});
