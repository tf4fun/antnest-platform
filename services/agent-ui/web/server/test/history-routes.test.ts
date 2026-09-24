import assert from "node:assert/strict";
import { test } from "node:test";
import { CompactTranscript } from "../src/bridge/compact-transcript.ts";
import { ViewPager } from "../src/bridge/view-pager.ts";
import { createHistoryHandler } from "../src/http/history-routes.ts";
import { HistoryCapacityError } from "../src/bridge/compact-transcript.ts";

const scope = {
  organizationId: "org-1",
  principalId: "user-1",
  agentId: "agent-1",
};
const base =
  "http://localhost/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns";
const headers = {
  "x-antnest-organization-id": scope.organizationId,
  "x-antnest-principal-id": scope.principalId,
  "x-antnest-agent-id": scope.agentId,
};

function fixture() {
  const transcript = new CompactTranscript();
  transcript.apply({
    sequence: 1,
    runId: "run-1",
    messageId: "answer-event",
    updates: [
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "answer-1",
        content: { type: "text", text: "x".repeat(4000) },
      },
    ],
  });
  const pager = new ViewPager({
    transcript,
    context: {
      ...scope,
      sessionId: "session-1",
      epoch: "epoch-1",
      incarnation: "incarnation-1",
      watermark: 1,
    },
    key: Buffer.alloc(32, 6),
    inlineBytes: 128,
    pageBytes: 1024,
  });
  let authorizations = 0;
  let releases = 0;
  const handler = createHistoryHandler({
    async authorize(identity, sessionId) {
      authorizations += 1;
      assert.deepEqual(identity, scope);
      assert.equal(sessionId, "session-1");
      return {
        pager,
        release() {
          releases += 1;
        },
      };
    },
  });
  return { handler, counts: () => ({ authorizations, releases }) };
}

test("turn and content HTTP pages reauthorize and retain exact continuation", async () => {
  const { handler, counts } = fixture();
  const turns = await handler(new Request(base, { headers }));
  assert.equal(turns?.status, 200);
  const turnPage = await turns?.json();
  assert.equal(turnPage.items[0].turnId, "run-1");
  assert.equal(turnPage.nextCursor, null);
  assert.equal(turnPage.newerCursor, null);
  assert.ok(turnPage.items[0].contentCursor);
  const content = await handler(
    new Request(
      `${base}/run-1/content?cursor=${encodeURIComponent(turnPage.items[0].contentCursor)}`,
      { headers },
    ),
  );
  assert.equal(content?.status, 200);
  assert.equal((await content?.json()).section, "finalResponse");
  assert.deepEqual(counts(), { authorizations: 2, releases: 2 });
});

test("a content cursor for another path turn fails and still releases access lease", async () => {
  const { handler, counts } = fixture();
  const turnPage = await (
    await handler(new Request(base, { headers }))
  )?.json();
  const cursor = encodeURIComponent(turnPage.items[0].contentCursor);
  const response = await handler(
    new Request(`${base}/other-run/content?cursor=${cursor}`, { headers }),
  );
  assert.equal(response?.status, 409);
  assert.deepEqual(counts(), { authorizations: 2, releases: 2 });
});

test("foreign Agent header and absent trusted identity cannot read a cached page", async () => {
  const { handler, counts } = fixture();
  assert.equal((await handler(new Request(base)))?.status, 401);
  assert.equal(
    (
      await handler(
        new Request(base, {
          headers: { ...headers, "x-antnest-agent-id": "agent-2" },
        }),
      )
    )?.status,
    403,
  );
  assert.deepEqual(counts(), { authorizations: 0, releases: 0 });
});

test("history capacity failure has an explicit recoverable code", async () => {
  const handler = createHistoryHandler({
    async authorize() {
      throw new HistoryCapacityError();
    },
  });
  const response = await handler(new Request(base, { headers }));
  assert.equal(response?.status, 429);
  assert.equal((await response?.json()).code, "history_capacity_exceeded");
});

test("process HTTP pages reauthorize and bind content cursors to the path item", async () => {
  const transcript = new CompactTranscript();
  transcript.apply({
    sequence: 1,
    runId: "run-1",
    messageId: "tool-event",
    updates: [
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read",
        status: "completed",
        rawInput: { data: "x".repeat(4000) },
      },
    ],
  });
  const pager = new ViewPager({
    transcript,
    context: {
      ...scope,
      sessionId: "session-1",
      epoch: "epoch-1",
      incarnation: "incarnation-1",
      watermark: 1,
    },
    key: Buffer.alloc(32, 6),
    inlineBytes: 128,
    pageBytes: 1024,
  });
  let checks = 0;
  const handler = createHistoryHandler({
    async authorize() {
      checks += 1;
      return { pager, release() {} };
    },
  });
  const process = await handler(
    new Request(`${base}/run-1/process`, { headers }),
  );
  assert.equal(process?.status, 200);
  const page = await process?.json();
  const item = page.items[0];
  assert.ok(item.contentCursor);
  const url = `${base}/run-1/process/${encodeURIComponent(item.id)}/content?cursor=${encodeURIComponent(item.contentCursor)}`;
  const content = await handler(new Request(url, { headers }));
  assert.equal(content?.status, 200);
  assert.equal((await content?.json()).itemId, item.id);
  const wrong = await handler(
    new Request(
      `${base}/run-1/process/other/content?cursor=${encodeURIComponent(item.contentCursor)}`,
      { headers },
    ),
  );
  assert.equal(wrong?.status, 409);
  assert.equal(checks, 3);
});
