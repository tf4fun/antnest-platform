import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventHandler } from "../src/http/event-routes.ts";
import { StreamCapacityError } from "../src/bridge/stream-journal.ts";

const path =
  "http://localhost/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1&cursor=initial";
const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-agent-id": "agent-1",
};

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
