import assert from "node:assert/strict";
import test from "node:test";
import { BridgeSessionStore } from "./bridge-session-store.ts";

const view = (answer: string, cursor: string | null, revision: number) => ({
  sessionId: "session", bridgeEpoch: "epoch", incarnation: "incarnation",
  viewRevision: revision, historyState: "ready",
  turns: [{ turnId: "turn", outcome: "completed", prompt: [{ type: "text", text: "Question" }],
    finalResponse: [{ type: "text", text: answer }], contentCursor: cursor,
    processVersion: 0, processCount: 0 }],
  olderTurnsCursor: null, configOptions: [], usage: null,
});

test("limited View drops prior history, in-flight content, and pagination", async () => {
  let release!: (value: unknown) => void;
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => new Promise((resolve) => { release = resolve; }),
  });
  store.accept({ ...view("Partial", "cut", 1), olderTurnsCursor: "older" }, "now");
  const pending = store.loadMessageContent("turn:answer");
  const limited = { ...view("", null, 2), historyState: "view_limited",
    turns: [], olderTurnsCursor: null, historyToken: null, outputWatermark: 2,
    limitedPreview: { text: "recent output", truncated: true } };
  store.accept(limited, "later");
  release({ section: "finalResponse", items: [{ type: "text", text: " stale" }],
    nextCursor: null, complete: true });
  await pending;
  assert.deepEqual(store.conversation?.messages, []);
  assert.equal(store.conversation?.historyState, "view_limited");
  assert.equal(store.conversation?.limitedPreview?.text, "recent output");
  assert.equal(store.olderTurnsCursor, null);
  assert.equal(store.hasNewerTurns, false);
  await assert.rejects(store.loadMessageContent("turn:answer"), /does not belong/u);
  store.accept({ ...limited, outputWatermark: 3,
    limitedPreview: { text: "new output", truncated: true } }, "still later");
  assert.deepEqual(store.conversation?.messages, []);
  assert.equal(store.conversation?.limitedPreview?.text, "new output");
});

test("blocked View shows sealed messages but disables stale detail and pagination", async () => {
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => { throw new Error("must not fetch"); },
  });
  store.accept({ ...view("Saved", "cut", 1), olderTurnsCursor: "older" }, "now");
  const blocked = { ...view("Saved", "cut", 2), historyState: "blocked",
    historyToken: null, configurationToken: null, olderTurnsCursor: null,
    outputWatermark: 2 };
  store.accept(blocked, "later");
  assert.equal(store.conversation?.historyState, "blocked");
  assert.equal(store.conversation?.messages[1]?.content, "Saved");
  assert.equal(store.olderTurnsCursor, null);
  await assert.rejects(store.loadMessageContent("turn:answer"), /read-only/u);
  store.accept(view("Fresh", null, 3), "latest");
  assert.equal(store.conversation?.historyState, undefined);
  assert.equal(store.conversation?.messages[1]?.content, "Fresh");
});

test("selected Bridge Session loads full content on demand", async () => {
  const published: string[] = [];
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({ section: "finalResponse", items: [{ type: "text", text: " rest" }],
      nextCursor: null, complete: true }),
  }, (conversation) => published.push(conversation.messages[1]?.content ?? ""));
  store.accept(view("Partial", "cut", 1), "2026-09-23T00:00:00Z");
  await store.loadMessageContent("turn:answer");
  assert.equal(store.conversation?.messages[1]?.content, "Partial rest");
  assert.equal(store.conversation?.messages[1]?.contentIncomplete, false);
  assert.deepEqual(published, ["Partial", "Partial rest"]);
});

test("same completed turn reset retains loaded full content but changed preview invalidates it", async () => {
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({ section: "finalResponse",
      items: [{ type: "text", text: " rest" }], nextCursor: null, complete: true }),
  });
  store.accept(view("Partial", "cut", 1), "now");
  await store.loadMessageContent("turn:answer");
  store.accept(view("Partial", "cut", 2), "later");
  assert.equal(store.conversation?.messages[1]?.content, "Partial rest");
  assert.equal(store.conversation?.messages[1]?.contentIncomplete, false);
  store.accept(view("Different", "new-cut", 3), "later still");
  assert.equal(store.conversation?.messages[1]?.content, "Different");
  assert.equal(store.conversation?.messages[1]?.contentIncomplete, true);
});

test("stale content response cannot overwrite a newer Session View", async () => {
  let release!: (value: unknown) => void;
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => new Promise((resolve) => { release = resolve; }),
  });
  store.accept(view("Old", "old-cut", 1), "2026-09-23T00:00:00Z");
  const pending = store.loadMessageContent("turn:answer");
  store.accept(view("New", null, 2), "2026-09-23T00:00:01Z");
  release({ section: "finalResponse", items: [{ type: "text", text: " stale" }],
    nextCursor: null, complete: true });
  await pending;
  assert.equal(store.conversation?.messages[1]?.content, "New");
});

test("older turn page prepends history once and keeps the continuation cursor", async () => {
  const cursors: string[] = [];
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}),
    turns: async (_agent, _session, cursor) => {
      cursors.push(cursor!);
      return { items: [{ turnId: "older", outcome: "completed",
        prompt: [{ type: "text", text: "Earlier" }],
        finalResponse: [{ type: "text", text: "Earlier answer" }],
        contentCursor: null, processVersion: 0, processCount: 0 }],
        nextCursor: null, newerCursor: "latest" };
    },
  });
  store.accept({ ...view("Current", null, 1), olderTurnsCursor: "before-1" },
    "2026-09-23T00:00:00Z");
  await store.loadOlderTurns();
  assert.deepEqual(cursors, ["before-1"]);
  assert.deepEqual(store.conversation?.messages.map((item) => item.content),
    ["Earlier", "Earlier answer", "Question", "Current"]);
  assert.equal(store.olderTurnsCursor, null);
});

test("deep history retains only the current page and latest View, then navigates forward", async () => {
  const seen: string[] = [];
  const turn = (index: number) => ({ turnId: `turn-${index}`, outcome: "completed",
    prompt: [{ type: "text", text: `Question ${index}` }], finalResponse: [],
    contentCursor: null, processVersion: 0, processCount: 0 });
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}),
    turns: async (_agent, _session, cursor) => {
      seen.push(cursor!);
      const edge = Number(cursor!.split("-").at(-1));
      const start = cursor!.startsWith("older-") ? edge - 20 : edge;
      return { items: Array.from({ length: 20 }, (_, offset) => turn(start + offset)),
        nextCursor: start === 0 ? null : `older-${start}`,
        newerCursor: start + 20 === 100 ? null : `newer-${start + 20}` };
    },
  });
  store.accept({ ...view("", null, 1), turns: Array.from({ length: 20 },
    (_, offset) => turn(80 + offset)), olderTurnsCursor: "older-80",
    outputWatermark: 100 }, "now");
  for (let index = 0; index < 4; index++) await store.loadOlderTurns();
  assert.ok(store.conversation!.messages.length <= 40);
  assert.equal(store.conversation!.messages[0]?.content, "Question 0");
  assert.equal(store.conversation!.messages.at(-1)?.content, "Question 99");
  assert.equal(store.hasHistoryGap, true);
  assert.equal(store.olderTurnsCursor, null);
  await store.loadNewerTurns();
  assert.equal(store.conversation!.messages[0]?.content, "Question 20");
  assert.ok(store.conversation!.messages.length <= 40);
  assert.equal(store.hasHistoryGap, true);
  await store.loadNewerTurns();
  await store.loadNewerTurns();
  assert.equal(store.hasHistoryGap, false);
  assert.equal(store.conversation!.messages[0]?.content, "Question 60");
  store.showLatestTurns();
  assert.equal(store.conversation!.messages[0]?.content, "Question 80");
  assert.deepEqual(seen, ["older-80", "older-60", "older-40", "older-20",
    "newer-20", "newer-40", "newer-60"]);
});

test("same-epoch reset keeps loaded older history and its next cursor", async () => {
  const cursors: string[] = [];
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}),
    turns: async (_agent, _session, cursor) => {
      cursors.push(cursor!);
      if (cursor === "before-1") return { items: [{ turnId: "older", outcome: "completed",
        prompt: [{ type: "text", text: "Earlier" }],
        finalResponse: [{ type: "text", text: "Earlier answer" }],
        contentCursor: null, processVersion: 0, processCount: 0 }],
        nextCursor: "before-2", newerCursor: "latest" };
      return { items: [{ turnId: "oldest", outcome: "completed",
        prompt: [{ type: "text", text: "Oldest" }], finalResponse: [],
        contentCursor: null, processVersion: 0, processCount: 0 }],
        nextCursor: null, newerCursor: "before-1" };
    },
  });
  store.accept({ ...view("Current", null, 1), olderTurnsCursor: "before-1" }, "now");
  await store.loadOlderTurns();
  store.accept({ ...view("Updated", null, 2), olderTurnsCursor: "before-1" }, "later");
  assert.deepEqual(store.conversation?.messages.map((item) => item.content),
    ["Earlier", "Earlier answer", "Question", "Updated"]);
  assert.equal(store.olderTurnsCursor, "before-2");
  await store.loadOlderTurns();
  assert.deepEqual(cursors, ["before-1", "before-2"]);
});

test("new output watermark keeps read history and rebases the older cursor", async () => {
  const cursors: string[] = [];
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}),
    turns: async (_agent, _session, cursor) => {
      cursors.push(cursor!);
      if (cursor === "before-new")
        return { items: [{ turnId: "older", outcome: "completed",
          prompt: [{ type: "text", text: "before-old" }], finalResponse: [],
          contentCursor: null, processVersion: 0, processCount: 0 }],
          nextCursor: "before-new-2", newerCursor: "latest" };
      return { items: [{ turnId: cursor === "before-new-2" ? "oldest" : "older",
        outcome: "completed", prompt: [{ type: "text", text: cursor }],
        finalResponse: [], contentCursor: null, processVersion: 0, processCount: 0 }],
        nextCursor: cursor === "before-old" ? "before-old-2" : null,
        newerCursor: cursor === "before-new-2" ? "before-new" : "latest" };
    },
  });
  store.accept({ ...view("Current", null, 1), outputWatermark: 5,
    olderTurnsCursor: "before-old" }, "now");
  await store.loadOlderTurns();
  assert.equal(store.conversation?.messages[0]?.content, "before-old");
  store.accept({ ...view("Updated", null, 2), outputWatermark: 6,
    olderTurnsCursor: "before-new" }, "later");
  assert.deepEqual(store.conversation?.messages.map((item) => item.content),
    ["before-old", "Question", "Updated"]);
  assert.equal(store.olderTurnsCursor, "before-new");
  await store.loadOlderTurns();
  assert.deepEqual(cursors, ["before-old", "before-new", "before-new-2"]);
  assert.deepEqual(store.conversation?.messages.map((item) => item.content),
    ["before-new-2", "Question", "Updated"]);
  assert.equal(store.hasHistoryGap, true);
  await store.loadNewerTurns();
  assert.deepEqual(store.conversation?.messages.map((item) => item.content),
    ["before-old", "Question", "Updated"]);
});

test("a changed watermark without any turn overlap does not invent continuous history", async () => {
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}),
    turns: async () => ({ items: [{ turnId: "older", outcome: "completed",
      prompt: [{ type: "text", text: "Earlier" }], finalResponse: [],
      contentCursor: null, processVersion: 0, processCount: 0 }],
      nextCursor: null, newerCursor: "latest" }),
  });
  store.accept({ ...view("Current", null, 1), outputWatermark: 5,
    olderTurnsCursor: "before-old" }, "now");
  await store.loadOlderTurns();
  const fresh = { ...view("New answer", null, 2), outputWatermark: 100,
    olderTurnsCursor: "before-new", turns: [{ ...view("New answer", null, 2).turns[0],
      turnId: "new-turn", prompt: [{ type: "text", text: "New question" }] }] };
  store.accept(fresh, "later");
  assert.deepEqual(store.conversation?.messages.map((item) => item.content),
    ["New question", "New answer"]);
  assert.equal(store.olderTurnsCursor, "before-new");
});

test("same-epoch View update retries an interrupted older-page request", async () => {
  const cursors: string[] = [];
  const page = { items: [{ turnId: "older", outcome: "completed",
    prompt: [{ type: "text", text: "Earlier" }],
    finalResponse: [{ type: "text", text: "Earlier answer" }],
    contentCursor: null, processVersion: 0, processCount: 0 }],
    nextCursor: null, newerCursor: "latest" };
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}),
    turns: async (_agent, _session, cursor, signal) => {
      cursors.push(cursor!);
      if (cursors.length > 1) return page;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("View changed")), { once: true });
      });
    },
  });
  store.accept({ ...view("Current", null, 1), olderTurnsCursor: "before-1" }, "now");
  const pending = store.loadOlderTurns();
  store.accept({ ...view("Updated", null, 2), olderTurnsCursor: "before-1" }, "later");
  await pending;
  assert.deepEqual(cursors, ["before-1", "before-1"]);
  assert.deepEqual(store.conversation?.messages.map((item) => item.content),
    ["Earlier", "Earlier answer", "Question", "Updated"]);
});

test("an interrupted older-page request restarts from the new output watermark", async () => {
  const cursors: string[] = [];
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}),
    turns: async (_agent, _session, cursor, signal) => {
      cursors.push(cursor!);
      if (cursor === "current-page")
        return { items: [{ turnId: "fresh", outcome: "completed",
          prompt: [{ type: "text", text: "Fresh" }], finalResponse: [],
          contentCursor: null, processVersion: 0, processCount: 0 }],
          nextCursor: null, newerCursor: "latest" };
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Watermark changed")), { once: true });
      });
    },
  });
  store.accept({ ...view("Current", null, 1), outputWatermark: 1,
    olderTurnsCursor: "stale-page" }, "now");
  const pending = store.loadOlderTurns();
  store.accept({ ...view("Updated", null, 2), outputWatermark: 2,
    olderTurnsCursor: "current-page" }, "later");
  await pending;
  assert.deepEqual(cursors, ["stale-page", "current-page"]);
  assert.deepEqual(store.conversation?.messages.map((item) => item.content),
    ["Fresh", "Question", "Updated"]);
});

test("new Bridge epoch discards loaded older history and cursor", async () => {
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}),
    turns: async () => ({ items: [{ turnId: "older", outcome: "completed",
      prompt: [{ type: "text", text: "Earlier" }], finalResponse: [],
      contentCursor: null, processVersion: 0, processCount: 0 }],
      nextCursor: null, newerCursor: "latest" }),
  });
  store.accept({ ...view("Current", null, 1), olderTurnsCursor: "before-1" }, "now");
  await store.loadOlderTurns();
  store.accept({ ...view("New", null, 2), bridgeEpoch: "different",
    olderTurnsCursor: "new-before" }, "later");
  assert.deepEqual(store.conversation?.messages.map((item) => item.content), ["Question", "New"]);
  assert.equal(store.olderTurnsCursor, "new-before");
});

test("late older page cannot prepend into a replaced Session View", async () => {
  let release!: (value: unknown) => void;
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}),
    turns: async () => new Promise((resolve) => { release = resolve; }),
  });
  store.accept({ ...view("Old", null, 1), olderTurnsCursor: "before-1" }, "now");
  const pending = store.loadOlderTurns();
  store.accept(view("New", null, 2), "later");
  release({ items: [{ turnId: "older", outcome: "completed", prompt: [], finalResponse: [],
    contentCursor: null, processVersion: 0, processCount: 0 }],
  nextCursor: null, newerCursor: "latest" });
  await pending;
  assert.deepEqual(store.conversation?.messages.map((item) => item.content), ["Question", "New"]);
});

test("process history is fetched only on demand and its truncated content remains explicit", async () => {
  const cursors: (string | undefined)[] = [];
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}), turns: async () => ({}),
    process: async (_agent, _session, _turn, cursor) => {
      cursors.push(cursor);
      return cursor === undefined
        ? { turnId: "turn", processVersion: 2, items: [{ id: "tool-1", kind: "tool",
          summary: "Read file", status: "completed", content: [{ type: "text", text: "preview" }],
          contentCursor: "content-cut" }], nextCursor: "page-2" }
        : { turnId: "turn", processVersion: 2, items: [{ id: "thought-1", kind: "thought",
          summary: "Consider result", status: "completed", content: [], contentCursor: null }],
          nextCursor: null };
    },
    processContent: async () => ({ turnId: "turn", itemId: "tool-1",
      items: [{ type: "text", text: " rest" }], nextCursor: null, complete: true }),
  });
  store.accept({ ...view("Done", null, 1), turns: [{ ...view("Done", null, 1).turns[0],
    processVersion: 2, processCount: 2 }] }, "now");
  assert.deepEqual(cursors, []);
  assert.equal(store.conversation?.messages[0]?.processCount, 2);
  await store.loadProcess("turn");
  assert.deepEqual(cursors, [undefined]);
  assert.equal(store.conversation?.messages[0]?.processHasMore, true);
  assert.equal(store.conversation?.messages.some((item) => item.id === "turn:process:thought-1"), false);
  await store.loadProcess("turn");
  assert.deepEqual(cursors, [undefined, "page-2"]);
  assert.equal(store.conversation?.messages[0]?.processHasMore, false);
  const tool = store.conversation?.messages.find((item) => item.id === "turn:process:tool-1");
  assert.equal(tool?.contentIncomplete, true);
  assert.match(tool?.content ?? "", /preview/u);
  await store.loadMessageContent("turn:process:tool-1");
  const complete = store.conversation?.messages.find((item) => item.id === "turn:process:tool-1");
  assert.equal(complete?.contentIncomplete, false);
  assert.match(complete?.content ?? "", /preview rest/u);
});

test("same-version reset retains the process continuation instead of refetching the first page", async () => {
  const cursors: (string | undefined)[] = [];
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}), turns: async () => ({}),
    process: async (_agent, _session, _turn, cursor) => {
      cursors.push(cursor);
      return { turnId: "turn", processVersion: 1,
        items: [{ id: cursor ? "second" : "first", kind: "thought",
          summary: "Step", status: "completed", content: [], contentCursor: null }],
        nextCursor: cursor ? null : "next" };
    }, processContent: async () => ({}),
  });
  const processView = { ...view("Done", null, 1), turns: [{ ...view("Done", null, 1).turns[0],
    processVersion: 1, processCount: 2 }] };
  store.accept(processView, "now");
  await store.loadProcess("turn");
  store.accept({ ...processView, viewRevision: 2 }, "later");
  await store.loadProcess("turn");
  assert.deepEqual(cursors, [undefined, "next"]);
  assert.equal(store.conversation?.messages[0]?.processHasMore, false);
});

test("matching Session reset retains loaded process without another fetch", async () => {
  let calls = 0;
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}), turns: async () => ({}),
    process: async () => { calls += 1; return { turnId: "turn", processVersion: 1,
      items: [{ id: "notice", kind: "notice", summary: "Started", status: "completed",
        content: [], contentCursor: null }], nextCursor: null }; },
    processContent: async () => ({}),
  });
  const processView = { ...view("Done", null, 1), turns: [{ ...view("Done", null, 1).turns[0],
    processVersion: 1, processCount: 1 }] };
  store.accept(processView, "now");
  await store.loadProcess("turn");
  store.accept({ ...processView, viewRevision: 2 }, "later");
  assert.equal(store.conversation?.messages[0]?.processLoaded, true);
  assert.equal(store.conversation?.messages.some((item) => item.id === "turn:process:notice"), true);
  await store.loadProcess("turn");
  assert.equal(calls, 1);
});

test("folded process can release cached items and fetch them again when reopened", async () => {
  let calls = 0;
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}), turns: async () => ({}),
    process: async () => { calls += 1; return { turnId: "turn", processVersion: 1,
      items: [{ id: "tool", kind: "tool", summary: "Read", status: "completed",
        content: [{ type: "text", text: "large output" }], contentCursor: null }],
      nextCursor: null }; },
    processContent: async () => ({}),
  });
  store.accept({ ...view("Done", null, 1), turns: [{ ...view("Done", null, 1).turns[0],
    processVersion: 1, processCount: 1 }] }, "now");
  await store.loadProcess("turn");
  assert.equal(store.conversation?.messages.some((item) => item.id === "turn:process:tool"), true);
  store.unloadProcess("turn");
  assert.equal(store.conversation?.messages[0]?.processLoaded, false);
  assert.equal(store.conversation?.messages.some((item) => item.id === "turn:process:tool"), false);
  await store.loadProcess("turn");
  assert.equal(calls, 2);
});

test("unloading a folded process rejects a late page without reviving cached content", async () => {
  let release!: (value: unknown) => void;
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}), turns: async () => ({}),
    process: async () => new Promise((resolve) => { release = resolve; }),
    processContent: async () => ({}),
  });
  store.accept({ ...view("Done", null, 1), turns: [{ ...view("Done", null, 1).turns[0],
    processVersion: 1, processCount: 1 }] }, "now");
  const pending = store.loadProcess("turn");
  store.unloadProcess("turn");
  release({ turnId: "turn", processVersion: 1, items: [{ id: "late", kind: "thought",
    summary: "Late", status: "completed", content: [], contentCursor: null }],
    nextCursor: null });
  await pending;
  assert.equal(store.conversation?.messages.some((item) => item.id === "turn:process:late"), false);
});

test("history page replacement retries a retained turn's interrupted process load", async () => {
  let releaseFirst!: (value: unknown) => void;
  let calls = 0;
  const store = new BridgeSessionStore("agent", "session", {
    turnContent: async () => ({}),
    turns: async () => ({ items: [{ turnId: "earlier", outcome: "completed",
      prompt: [{ type: "text", text: "Earlier" }], finalResponse: [],
      contentCursor: null, processVersion: 0, processCount: 0 }],
      nextCursor: null, newerCursor: "latest" }),
    process: async () => {
      calls++;
      if (calls === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      return { turnId: "turn", processVersion: 1,
        items: [{ id: "fresh", kind: "notice", summary: "Fresh",
          status: "completed", content: [], contentCursor: null }], nextCursor: null };
    },
    processContent: async () => ({}),
  });
  store.accept({ ...view("Done", null, 1), olderTurnsCursor: "before-1",
    turns: [{ ...view("Done", null, 1).turns[0], processVersion: 1,
      processCount: 1 }] }, "now");
  const interrupted = store.loadProcess("turn");
  await store.loadOlderTurns();
  const retried = store.loadProcess("turn");
  const callCount = calls;
  releaseFirst({ turnId: "turn", processVersion: 1,
    items: [{ id: "stale", kind: "notice", summary: "Stale",
      status: "completed", content: [], contentCursor: null }], nextCursor: null });
  await Promise.all([interrupted, retried]);
  assert.equal(callCount, 2);
  assert.equal(store.conversation?.messages.some((item) =>
    item.id === "turn:process:fresh"), true);
  assert.equal(store.conversation?.messages.some((item) =>
    item.id === "turn:process:stale"), false);
});
