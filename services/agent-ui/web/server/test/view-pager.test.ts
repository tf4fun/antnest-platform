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
  assert.equal(page.items[0]?.contentSection, null);
  assert.equal(page.olderTurnsCursor, null);
});

test("process-only updates reuse stable turn content without hiding later answers", () => {
  const value = transcript("question", "answer");
  const pager = new ViewPager({ transcript: value, context, key });
  const before = pager.recentTurns().items[0]!;
  value.apply({ sequence: 3, runId: "run-1", messageId: "tool-event",
    updates: [{ sessionUpdate: "tool_call_update", toolCallId: "tool-1",
      title: "Read", status: "in_progress", rawInput: { path: "a.txt" } }] });
  const process = pager.recentTurns().items[0]!;
  assert.strictEqual(process.prompt, before.prompt);
  assert.strictEqual(process.finalResponse, before.finalResponse);
  assert.equal(process.processVersion, 1);
  value.apply({ sequence: 4, runId: "run-1", messageId: "answer-next",
    updates: [{ sessionUpdate: "agent_message_chunk", messageId: "answer-1",
      content: { type: "text", text: " next" } }] });
  const answer = pager.recentTurns().items[0]!;
  assert.notStrictEqual(answer.finalResponse, before.finalResponse);
  assert.deepEqual(before.finalResponse, [{ type: "text", text: "answer" }]);
  assert.deepEqual(answer.finalResponse, [{ type: "text", text: "answer" },
    { type: "text", text: " next" }]);
  value.apply({ sequence: 5, runId: "run-1", messageId: "new-tool",
    updates: [{ sessionUpdate: "tool_call", toolCallId: "tool-2",
      title: "Edit", status: "pending" }] });
  const interim = pager.recentTurns().items[0]!;
  assert.deepEqual(interim.finalResponse, []);
  assert.deepEqual(answer.finalResponse, [{ type: "text", text: "answer" },
    { type: "text", text: " next" }]);
});

test("a new watermark reuses stable previews but reissues scoped content cursors", () => {
  const value = transcript("question", "x".repeat(4_000));
  const firstPager = new ViewPager({ transcript: value, context, key,
    inlineBytes: 128, pageBytes: 1024 });
  const first = firstPager.recentTurns().items[0]!;
  assert.ok(first.contentCursor);
  const nextPager = new ViewPager({ transcript: value,
    context: { ...context, watermark: context.watermark + 1 }, key,
    inlineBytes: 128, pageBytes: 1024,
    turnContentCache: firstPager.sharedTurnContentCache() });
  const next = nextPager.recentTurns().items[0]!;
  assert.strictEqual(next.prompt, first.prompt);
  assert.strictEqual(next.finalResponse, first.finalResponse);
  assert.notEqual(next.contentCursor, first.contentCursor);
  assert.throws(() => nextPager.contentPage(first.contentCursor!));
  assert.equal(nextPager.contentPage(next.contentCursor!).section, "finalResponse");
  const widePager = new ViewPager({ transcript: value, context, key,
    inlineBytes: 8_192, pageBytes: 16_384,
    turnContentCache: nextPager.sharedTurnContentCache() });
  const wide = widePager.recentTurns().items[0]!;
  assert.notStrictEqual(wide.finalResponse, first.finalResponse);
  assert.equal(wide.contentCursor, null);
});

test("running turn publishes changed process items without inlining historical process", () => {
  const value = new CompactTranscript();
  value.apply({ sequence: 1, runId: "run-1", messageId: "user-event",
    updates: [{ sessionUpdate: "user_message_chunk", messageId: "user-1",
      content: { type: "text", text: "question" } }] });
  value.setOutcome("run-1", "running");
  value.apply({ sequence: 2, runId: "run-1", messageId: "tool-start",
    updates: [{ sessionUpdate: "tool_call", toolCallId: "tool-1",
      title: "Read", status: "in_progress" }] });
  const pager = new ViewPager({ transcript: value, context, key });
  const live = pager.recentTurns().items[0]!;
  assert.deepEqual(live.liveProcessDelta?.items.map((change) => change.index), [0]);
  assert.equal(live.liveProcessDelta?.fromVersion, 0);
  assert.equal(live.liveProcessDelta?.items[0]?.item.kind, "tool");
  value.setOutcome("run-1", "completed");
  assert.equal(pager.recentTurns().items[0]?.liveProcessDelta, undefined);
});

test("consecutive changes to one live process item cover skipped versions", () => {
  const value = new CompactTranscript();
  value.apply({ sequence: 1, runId: "run-1", messageId: "tool-start",
    updates: [{ sessionUpdate: "tool_call", toolCallId: "tool-1",
      title: "Read", status: "in_progress" }] });
  value.setOutcome("run-1", "running");
  value.apply({ sequence: 2, runId: "run-1", messageId: "tool-progress-1",
    updates: [{ sessionUpdate: "tool_call_update", toolCallId: "tool-1",
      title: "Read 50%", status: "in_progress" }] });
  value.apply({ sequence: 3, runId: "run-1", messageId: "tool-progress-2",
    updates: [{ sessionUpdate: "tool_call_update", toolCallId: "tool-1",
      title: "Read 100%", status: "completed" }] });
  const pager = new ViewPager({ transcript: value, context, key });
  const turn = pager.recentTurns().items[0]!;
  assert.equal(turn.processVersion, 3);
  assert.equal(turn.liveProcessDelta?.fromVersion, 0);
  assert.deepEqual(turn.liveProcessDelta?.items.map((change) => change.index), [0]);
  assert.equal(turn.liveProcessDelta?.items[0]?.item.summary, "Read 100%");
  value.apply({ sequence: 4, runId: "run-1", messageId: "other-tool",
    updates: [{ sessionUpdate: "tool_call", toolCallId: "tool-2",
      title: "Second", status: "in_progress" }] });
  const next = pager.recentTurns().items[0]!;
  assert.equal(next.liveProcessDelta?.fromVersion, 3);
  assert.deepEqual(next.liveProcessDelta?.items.map((change) => change.index), [1]);
});

test("small live tool updates do not rematerialize an unrelated large tool", () => {
  const value = new CompactTranscript();
  const large = "界\\\"\n" + "x".repeat(1024 * 1024);
  value.apply({ sequence: 1, runId: "run", messageId: "large", updates: [{
    sessionUpdate: "tool_call", toolCallId: "large", title: "Large",
    status: "in_progress", rawOutput: { text: large },
  }] });
  value.apply({ sequence: 2, runId: "run", messageId: "small", updates: [{
    sessionUpdate: "tool_call", toolCallId: "small", title: "Small",
    status: "in_progress", rawOutput: { text: "small" },
  }] });
  value.setOutcome("run", "running");
  const originalClone = globalThis.structuredClone;
  let largeClones = 0;
  globalThis.structuredClone = ((input: unknown, options?: StructuredSerializeOptions) => {
    if (Array.isArray(input) && input.some((block) =>
      typeof block === "object" && block !== null && "text" in block &&
      typeof block.text === "string" && block.text.length > 1024 * 1024))
      largeClones++;
    return originalClone(input, options);
  }) as typeof structuredClone;
  try {
    for (let step = 0; step < 8; step++) {
      value.apply({ sequence: step + 3, runId: "run", messageId: `small-${step}`,
        updates: [{ sessionUpdate: "tool_call_update", toolCallId: "small",
          title: `Small ${step}`, status: "in_progress" }] });
      const pager = new ViewPager({ transcript: value,
        context: { ...context, watermark: context.watermark + step }, key });
      const turn = pager.recentTurns().items[0]!;
      assert.ok(turn.liveProcessDelta &&
        turn.liveProcessDelta.fromVersion >= turn.processVersion - 8 &&
        turn.liveProcessDelta.fromVersion < turn.processVersion);
      assert.deepEqual(turn.liveProcessDelta?.items.map((change) => change.index), [1]);
    }
  } finally {
    globalThis.structuredClone = originalClone;
  }
  assert.equal(largeClones, 0);
  const retained = value.turns()[0]?.process[0]?.content[0];
  assert.equal(retained?.type, "text");
  if (retained?.type === "text")
    assert.equal(JSON.parse(retained.text.slice("Output: ".length)).text, large);
});

test("small answer chunks do not republish an unchanged large live tool", () => {
  const value = new CompactTranscript();
  value.apply({ sequence: 1, runId: "run", messageId: "large", updates: [{
    sessionUpdate: "tool_call", toolCallId: "large", title: "Large",
    status: "in_progress", rawOutput: { text: "x".repeat(1024 * 1024) },
  }] });
  value.setOutcome("run", "running");
  const originalClone = globalThis.structuredClone;
  let largeClones = 0;
  globalThis.structuredClone = ((input: unknown, options?: StructuredSerializeOptions) => {
    if (Array.isArray(input) && input.some((block) =>
      typeof block === "object" && block !== null && "text" in block &&
      typeof block.text === "string" && block.text.length > 1024 * 1024))
      largeClones++;
    return originalClone(input, options);
  }) as typeof structuredClone;
  try {
    for (let step = 0; step < 8; step++) {
      value.apply({ sequence: step + 2, runId: "run", messageId: `answer-${step}`,
        updates: [{ sessionUpdate: "agent_message_chunk", messageId: "answer",
          content: { type: "text", text: `part ${step}` } }] });
      const pager = new ViewPager({ transcript: value,
        context: { ...context, watermark: context.watermark + step }, key });
      assert.equal(pager.recentTurns().items[0]?.liveProcessDelta, undefined);
    }
  } finally {
    globalThis.structuredClone = originalClone;
  }
  assert.equal(largeClones, 0);
  assert.equal(value.turns()[0]?.finalResponse.length, 8);
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
  assert.equal(pager.recentTurns().items[0]?.contentSection, "finalResponse");
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

test("oversized prompt assigns its continuation to the user message", () => {
  const pager = new ViewPager({ transcript: transcript("q".repeat(4_000), "answer"),
    context, key, inlineBytes: 128, pageBytes: 1024 });
  const turn = pager.recentTurns().items[0]!;
  assert.ok(turn.contentCursor);
  assert.equal(turn.contentSection, "prompt");
  assert.deepEqual(turn.finalResponse, []);
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
  assert.deepEqual(process.items[0]?.toolSections,
    { inputIndex: 0, detailStartIndex: 1 });
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

test("large process content materializes its tool output once across pages", () => {
  const value = new CompactTranscript();
  const largeResult = "x".repeat(1024 * 1024);
  value.apply({ sequence: 1, runId: "run-1", messageId: "tool-event", updates: [{
    sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read",
    status: "completed", rawOutput: { largeResult },
  }] });
  const pager = new ViewPager({ transcript: value, context, key,
    inlineBytes: 128, pageBytes: 64 * 1024 });
  const process = pager.processPage("run-1");
  let cursor = process.items[0]?.contentCursor;
  assert.ok(cursor);
  const stringify = JSON.stringify;
  let outputEncodings = 0;
  let pages = 0;
  JSON.stringify = ((input: unknown, ...options: unknown[]) => {
    if (input && typeof input === "object" && "largeResult" in input) outputEncodings++;
    return (stringify as (...args: unknown[]) => string | undefined)(input, ...options);
  }) as typeof JSON.stringify;
  try {
    while (cursor) {
      const page = pager.processContentPage(cursor, "run-1", process.items[0]!.id);
      assert.ok(Buffer.byteLength(stringify(page)) <= 64 * 1024);
      cursor = page.nextCursor;
      pages++;
      assert.ok(pages < 40);
    }
    assert.ok(pages > 10);
    assert.equal(outputEncodings, 1);
    pager.processContentPage(process.items[0]!.contentCursor!, "run-1", process.items[0]!.id);
    assert.equal(outputEncodings, 2, "completed paging releases its temporary materialization");
  } finally { JSON.stringify = stringify; }
});

test("idle process and answer content materializations are released without losing signed cursors", () => {
  let now = 0;
  const answer = "a".repeat(500_000);
  const largeResult = "x".repeat(1024 * 1024);
  const value = new CompactTranscript();
  value.apply({ sequence: 1, runId: "run-1", messageId: "user-event", updates: [{
    sessionUpdate: "user_message_chunk", messageId: "user-1",
    content: { type: "text", text: "question" },
  }] });
  value.apply({ sequence: 2, runId: "run-1", messageId: "tool-event", updates: [{
    sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read",
    status: "completed", rawOutput: { largeResult },
  }] });
  value.apply({ sequence: 3, runId: "run-1", messageId: "answer-event", updates: [{
    sessionUpdate: "agent_message_chunk", messageId: "answer-1",
    content: { type: "text", text: answer },
  }] });
  const pager = new ViewPager({ transcript: value, context, key, now: () => now });
  const turnCursor = pager.recentTurns().items[0]!.contentCursor!;
  const tool = pager.processPage("run-1").items[0]!;
  const stringify = JSON.stringify;
  let encodings = 0;
  JSON.stringify = ((input: unknown, ...options: unknown[]) => {
    if (input && typeof input === "object" &&
      (("largeResult" in input) || ("text" in input && input.text === answer)))
      encodings++;
    return (stringify as (...args: unknown[]) => string | undefined)(input, ...options);
  }) as typeof JSON.stringify;
  try {
    const firstAnswer = pager.contentPage(turnCursor, "run-1");
    const firstTool = pager.processContentPage(tool.contentCursor!, "run-1", tool.id);
    assert.ok(firstAnswer.nextCursor && firstTool.nextCursor);
    assert.equal(encodings, 2);
    now = 29_000;
    pager.releaseIdleContentCaches();
    pager.contentPage(turnCursor, "run-1");
    pager.processContentPage(tool.contentCursor!, "run-1", tool.id);
    assert.equal(encodings, 2, "Active page sequences reuse their materialization");
    now = 60_000;
    pager.releaseIdleContentCaches();
    pager.contentPage(firstAnswer.nextCursor, "run-1");
    pager.processContentPage(firstTool.nextCursor, "run-1", tool.id);
    assert.equal(encodings, 4, "Idle buffers are rebuilt from the unchanged transcript");
  } finally { JSON.stringify = stringify; }
});

test("collapsed turn pages never serialize unrelated tool result bodies", () => {
  const history = transcript("question", "answer");
  const largeResult = "x".repeat(1024 * 1024);
  history.apply({ sequence: 3, runId: "run-1", messageId: "tool-event", updates: [{
    sessionUpdate: "tool_call", toolCallId: "tool", title: "Tool", status: "completed",
    rawOutput: { largeResult },
  }] });
  const stringify = JSON.stringify;
  let encodedResults = 0;
  JSON.stringify = ((value: unknown, ...options: unknown[]) => {
    if (value && typeof value === "object" && "largeResult" in value) encodedResults++;
    return (stringify as (...args: unknown[]) => string | undefined)(value, ...options);
  }) as typeof JSON.stringify;
  try {
    const pager = new ViewPager({ transcript: history, context, key });
    assert.equal(pager.recentTurns().items[0]?.processCount, 2);
    assert.equal(encodedResults, 0, "Tool result is only formatted when process detail is requested");
    pager.processPage("run-1");
    assert.equal(encodedResults, 1);
  } finally { JSON.stringify = stringify; }
});

test("collapsed conversation projection does not clone or serialize hidden large text", () => {
  const answer = "x".repeat(1024 * 1024);
  const history = transcript("question", answer);
  const clone = globalThis.structuredClone;
  const stringify = JSON.stringify;
  let largeCopies = 0;
  let largeEncodings = 0;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    if (Array.isArray(value) && value.some((block) => block?.text === answer)) largeCopies++;
    return clone(value, options);
  }) as typeof structuredClone;
  JSON.stringify = ((value: unknown, ...options: unknown[]) => {
    if (value && typeof value === "object" && "text" in value && value.text === answer) largeEncodings++;
    return (stringify as (...args: unknown[]) => string | undefined)(value, ...options);
  }) as typeof JSON.stringify;
  try {
    const pager = new ViewPager({ transcript: history, context, key });
    const turn = pager.recentTurns().items[0]!;
    assert.deepEqual(turn.finalResponse, []);
    assert.ok(turn.contentCursor);
    assert.equal(largeCopies, 0);
    assert.equal(largeEncodings, 0);
  } finally {
    globalThis.structuredClone = clone;
    JSON.stringify = stringify;
  }
});

test("large answer fragments include long signed cursors in the response byte bound", () => {
  const answer = "answer:" + "界".repeat(150_000);
  const history = transcript("question", answer);
  const pager = new ViewPager({ transcript: history, key,
    context: { ...context, organizationId: "o".repeat(200), principalId: "p".repeat(200),
      agentId: "a".repeat(200), sessionId: "s".repeat(200) } });
  let cursor = pager.recentTurns().items[0]!.contentCursor;
  const chunks: Buffer[] = [];
  while (cursor) {
    const page = pager.contentPage(cursor, "run-1");
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 262144);
    assert.ok(page.fragment);
    chunks.push(Buffer.from(page.fragment.serializedBlockBase64, "base64"));
    cursor = page.nextCursor;
  }
  assert.equal(JSON.parse(Buffer.concat(chunks).toString("utf8")).text, answer);
});

test("fragment paging serializes the requested large block once per sealed view", () => {
  const answer = "x".repeat(500_000);
  const history = transcript("question", answer);
  const pager = new ViewPager({ transcript: history, context, key });
  let cursor = pager.recentTurns().items[0]!.contentCursor;
  const stringify = JSON.stringify;
  let encoded = 0;
  JSON.stringify = ((value: unknown, ...options: unknown[]) => {
    if (value && typeof value === "object" && "text" in value && value.text === answer) encoded++;
    return (stringify as (...args: unknown[]) => string | undefined)(value, ...options);
  }) as typeof JSON.stringify;
  try {
    const firstCursor = cursor!;
    while (cursor) cursor = pager.contentPage(cursor, "run-1").nextCursor;
    assert.equal(encoded, 1);
    pager.contentPage(firstCursor, "run-1");
    assert.equal(encoded, 2, "Completed answer paging releases its temporary materialization");
  } finally { JSON.stringify = stringify; }
});
