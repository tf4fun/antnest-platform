import assert from "node:assert/strict";
import { test } from "node:test";
import { CompactTranscript } from "../src/bridge/compact-transcript.ts";
import { ViewPager } from "../src/bridge/view-pager.ts";

const scope = {
  organizationId: "org-1",
  principalId: "user-1",
  agentId: "agent-1",
};
const context = {
  ...scope,
  sessionId: "session-1",
  epoch: "epoch-1",
  incarnation: "incarnation-1",
  watermark: 4,
};
const key = Buffer.alloc(32, 4);

function transcript(prompt: string, answer: string) {
  const value = new CompactTranscript();
  value.apply({
    sequence: 1,
    runId: "run-1",
    messageId: "user-event",
    updates: [
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: prompt },
      },
    ],
  });
  value.apply({
    sequence: 2,
    runId: "run-1",
    messageId: "answer-event",
    updates: [
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "answer-1",
        content: { type: "text", text: answer },
      },
    ],
  });
  return value;
}

test("small native blocks remain inline with no content cursor", () => {
  const pager = new ViewPager({
    transcript: transcript("question", "answer"),
    context,
    key,
    inlineBytes: 1024,
    pageBytes: 1024,
  });
  const page = pager.recentTurns();
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0]?.prompt, [{ type: "text", text: "question" }]);
  assert.deepEqual(page.items[0]?.finalResponse, [
    { type: "text", text: "answer" },
  ]);
  assert.equal(page.items[0]?.contentCursor, null);
  assert.equal(page.olderTurnsCursor, null);
});

test("oversized ACP block continues as exact base64 JSON fragments", () => {
  const answer = "x".repeat(4_000);
  const pager = new ViewPager({
    transcript: transcript("question", answer),
    context,
    key,
    inlineBytes: 128,
    pageBytes: 1024,
  });
  let cursor = pager.recentTurns().items[0]?.contentCursor;
  assert.ok(cursor);
  const chunks: Buffer[] = [];
  let pages = 0;
  while (cursor !== null && cursor !== undefined) {
    const page = pager.contentPage(cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024);
    assert.equal(page.section, "finalResponse");
    assert.deepEqual(page.items, []);
    assert.ok(page.fragment);
    chunks.push(Buffer.from(page.fragment.serializedBlockBase64, "base64"));
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages < 20);
  }
  assert.ok(pages > 1);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
    type: "text",
    text: answer,
  });
});

test("foreign and stale content cursors cannot read private history", () => {
  const value = transcript("question", "x".repeat(4_000));
  const original = new ViewPager({
    transcript: value,
    context,
    key,
    inlineBytes: 128,
    pageBytes: 1024,
  });
  const cursor = original.recentTurns().items[0]!.contentCursor!;
  assert.throws(() => original.contentPage(cursor, "another-turn"));
  for (const changed of [
    { principalId: "user-2" },
    { watermark: 5 },
    { incarnation: "incarnation-2" },
  ]) {
    const other = new ViewPager({
      transcript: value,
      context: { ...context, ...changed },
      key,
      inlineBytes: 128,
      pageBytes: 1024,
    });
    assert.throws(() => other.contentPage(cursor));
  }
  assert.throws(() => original.contentPage(`${cursor}x`));
});

test("continuation moves from omitted prompt blocks to the final response section", () => {
  const pager = new ViewPager({
    transcript: transcript("x".repeat(600), "answer"),
    context,
    key,
    inlineBytes: 128,
    pageBytes: 1024,
  });
  const cursor = pager.recentTurns().items[0]!.contentCursor!;
  let next: string | null = cursor;
  let promptPages = 0;
  while (next !== null) {
    const page = pager.contentPage(next);
    if (page.section === "finalResponse") break;
    assert.equal(page.section, "prompt");
    promptPages += 1;
    next = page.nextCursor;
  }
  assert.ok(promptPages > 0);
  assert.ok(next);
  const answerPage = pager.contentPage(next!);
  assert.equal(answerPage.section, "finalResponse");
  assert.deepEqual(answerPage.items, [{ type: "text", text: "answer" }]);
  assert.equal(answerPage.complete, true);
});

test("older-turn cursor is signed and bounded to its fixed view cut", () => {
  const value = new CompactTranscript();
  for (let index = 0; index < 25; index++)
    value.apply({
      sequence: index + 1,
      runId: `run-${index}`,
      messageId: `event-${index}`,
      updates: [
        {
          sessionUpdate: "user_message_chunk",
          messageId: `user-${index}`,
          content: { type: "text", text: String(index) },
        },
      ],
    });
  const pager = new ViewPager({ transcript: value, context, key });
  const recent = pager.recentTurns();
  assert.equal(recent.items[0]?.turnId, "run-5");
  const older = pager.turnsAt(recent.olderTurnsCursor!);
  assert.deepEqual(
    older.items.map((turn) => turn.turnId),
    ["run-0", "run-1", "run-2", "run-3", "run-4"],
  );
  assert.equal(older.olderTurnsCursor, null);
  const changed = new ViewPager({
    transcript: value,
    context: { ...context, watermark: 5 },
    key,
  });
  assert.throws(() => changed.turnsAt(recent.olderTurnsCursor!));
});

test("signed turn cursors fetch adjacent older and newer pages without gaps", () => {
  const value = new CompactTranscript();
  for (let index = 0; index < 45; index++)
    value.apply({ sequence: index + 1, runId: `run-${index}`,
      messageId: `event-${index}`, updates: [{ sessionUpdate: "user_message_chunk",
        messageId: `user-${index}`, content: { type: "text", text: String(index) } }] });
  const pager = new ViewPager({ transcript: value, context: { ...context, watermark: 45 }, key });
  const latest = pager.recentTurns();
  assert.equal(latest.newerTurnsCursor, null);
  const middle = pager.turnsAt(latest.olderTurnsCursor!);
  assert.deepEqual(middle.items.map((turn) => turn.turnId),
    Array.from({ length: 20 }, (_, offset) => `run-${offset + 5}`));
  assert.ok(middle.olderTurnsCursor);
  assert.ok(middle.newerTurnsCursor);
  const oldest = pager.turnsAt(middle.olderTurnsCursor!);
  assert.deepEqual(oldest.items.map((turn) => turn.turnId),
    ["run-0", "run-1", "run-2", "run-3", "run-4"]);
  assert.equal(oldest.olderTurnsCursor, null);
  assert.deepEqual(pager.turnsAt(oldest.newerTurnsCursor!).items.map((turn) => turn.turnId),
    middle.items.map((turn) => turn.turnId));
  assert.deepEqual(pager.turnsAt(middle.newerTurnsCursor!).items.map((turn) => turn.turnId),
    latest.items.map((turn) => turn.turnId));
  const changed = new ViewPager({ transcript: value,
    context: { ...context, watermark: 46 }, key });
  assert.throws(() => changed.turnsAt(middle.newerTurnsCursor!));
});

test("process pages stay bounded to ten items and a fixed process version", () => {
  const value = new CompactTranscript();
  for (let index = 0; index < 15; index++)
    value.apply({
      sequence: index + 1,
      runId: "run-1",
      messageId: `event-${index}`,
      updates: [
        {
          sessionUpdate: "tool_call",
          toolCallId: `tool-${index}`,
          title: `Tool ${index}`,
          status: "completed",
        },
      ],
    });
  const pager = new ViewPager({
    transcript: value,
    context: { ...context, watermark: 15 },
    key,
  });
  const first = pager.processPage("run-1");
  assert.equal(first.items.length, 10);
  assert.ok(first.nextCursor);
  const second = pager.processPage("run-1", first.nextCursor);
  assert.equal(second.items.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(first.processVersion, second.processVersion);
  assert.throws(() => pager.processPage("another-run", first.nextCursor));
  const changed = new ViewPager({
    transcript: value,
    context: { ...context, watermark: 16 },
    key,
  });
  assert.throws(() => changed.processPage("run-1", first.nextCursor));
});

test("large process item content continues as exact serialized block fragments", () => {
  const value = new CompactTranscript();
  value.apply({
    sequence: 1,
    runId: "run-1",
    messageId: "tool-event",
    updates: [
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read",
        status: "completed",
        rawInput: { text: "x".repeat(5_000) },
      },
    ],
  });
  const pager = new ViewPager({
    transcript: value,
    context,
    key,
    inlineBytes: 128,
    pageBytes: 1024,
  });
  const process = pager.processPage("run-1");
  assert.ok(Buffer.byteLength(JSON.stringify(process)) <= 1024);
  assert.equal(process.items[0]?.content.length, 0);
  let cursor = process.items[0]?.contentCursor;
  assert.ok(cursor);
  const parts: Buffer[] = [];
  let count = 0;
  while (cursor !== null && cursor !== undefined) {
    const page = pager.processContentPage(
      cursor,
      "run-1",
      process.items[0]!.id,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024);
    assert.equal(page.itemId, process.items[0]?.id);
    assert.ok(page.fragment);
    parts.push(Buffer.from(page.fragment.serializedBlockBase64, "base64"));
    cursor = page.nextCursor;
    count += 1;
    assert.ok(count < 30);
  }
  assert.ok(count > 1);
  const full = JSON.parse(Buffer.concat(parts).toString("utf8"));
  assert.equal(
    full.text,
    `Input: ${JSON.stringify({ text: "x".repeat(5_000) })}`,
  );
});
