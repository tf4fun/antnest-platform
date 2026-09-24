import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionReplay } from "../src/bridge/session-replay.ts";
import { CompactTranscript, HistoryCapacityError } from "../src/bridge/compact-transcript.ts";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

const part = (sequence: number, partIndex = 0, partCount = 1) => ({
  kind: "part" as const,
  sequence,
  partIndex,
  partCount,
  runId: "run-1",
  messageId: `event-${sequence}`,
});

test("only a successfully sealed replay enables the live output limit", async () => {
  const sealed: string[] = [];
  const session = new SessionReplay<{ name: string }, string>({
    empty: () => ({ name: "candidate" }),
    apply: (view) => view,
    seal: (view) => sealed.push(view.name),
  });
  await assert.rejects(session.load(async () => { throw new Error("load failed"); }));
  assert.deepEqual(sealed, []);
  await session.load(async () => ({ sealedWatermark: 0, appendVersion: 1 }));
  assert.deepEqual(sealed, ["candidate"]);
});

test("limited replay summarizes later large parts without losing the delivery watermark", async () => {
  const session = new SessionReplay<{ limited: boolean; updates: string[] }, string>({
    empty: () => ({ limited: false, updates: [] }),
    apply: (view, batch) => {
      view.updates.push(...batch.updates);
      if (view.updates.length >= 1) view.limited = true;
      return view;
    },
    isLimited: (view) => view.limited,
    summarize: (update) => update.slice(-4),
  });
  await session.load(async () => ({ sealedWatermark: 0, appendVersion: 1 }));
  session.receive(part(1), "first");
  session.receive(part(2, 0, 2), "x".repeat(17 * 1024 * 1024));
  assert.ok(session.estimatedRetainedBytes < 256);
  assert.equal(session.snapshot().watermark, 1);
  session.receive(part(2, 1, 2), "last");
  assert.equal(session.snapshot().watermark, 2);
  assert.deepEqual(session.snapshot().view.updates, ["first", "xxxx", "last"]);
});

test("a sealed replay limits itself before an oversized first pending part is rejected", async () => {
  const session = new SessionReplay<{ limited: boolean; updates: string[] }, string>({
    empty: () => ({ limited: false, updates: [] }),
    apply: (view, batch) => { view.updates.push(...batch.updates); return view; },
    limit: (view) => { view.limited = true; return true; },
    isLimited: (view) => view.limited,
    summarize: (update) => update.slice(-4),
  });
  await session.load(async () => ({ sealedWatermark: 0, appendVersion: 1 }));
  session.receive(part(1), "x".repeat(17 * 1024 * 1024));
  assert.equal(session.snapshot().view.limited, true);
  assert.equal(session.snapshot().watermark, 1);
  assert.deepEqual(session.snapshot().view.updates, ["xxxx"]);
  assert.equal(session.snapshot().needsReconcile, false);
});

test("replacement of a sealed View may become limited when its fresh replay exceeds history budget", async () => {
  const session = new SessionReplay<CompactTranscript, SessionUpdate>({
    empty: () => new CompactTranscript(1024),
    apply: (view, batch) => view.apply(batch),
    seal: (view) => view.enableLiveLimit(),
    prepareReplacement: (view) => view.enableLiveLimit(),
    limit: (view) => view.limitLive(),
    isLimited: (view) => view.isLimited,
    summarize: (update) => update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
      ? { ...update, content: { type: "text", text: update.content.text.slice(-32) } }
      : undefined,
  });
  const update = (text: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk",
    messageId: "answer",
    content: { type: "text", text } });
  await session.load(async () => ({ sealedWatermark: 0, appendVersion: 1 }));
  await session.load(async () => {
    session.receive(part(1), update("a".repeat(600)));
    session.receive(part(2), update("b".repeat(600)));
    return { sealedWatermark: 2, appendVersion: 2 };
  });
  assert.equal(session.snapshot().view.isLimited, true);
  assert.equal(session.snapshot().watermark, 2);
  assert.equal(session.snapshot().needsReconcile, false);
  assert.equal(session.snapshot().view.limitedPreview.text, "b".repeat(600));
  const cold = new SessionReplay<CompactTranscript, SessionUpdate>({
    empty: () => new CompactTranscript(1024),
    apply: (view, batch) => view.apply(batch),
    seal: (view) => view.enableLiveLimit(),
    prepareReplacement: (view) => view.enableLiveLimit(),
  });
  await assert.rejects(cold.load(async () => {
    cold.receive(part(1), update("x".repeat(1200)));
    return { sealedWatermark: 1, appendVersion: 1 };
  }), HistoryCapacityError);
});

test("replay keeps the old view readable and replaces it only after a sealed cut", async () => {
  let finish!: (value: {
    sealedWatermark: number;
    appendVersion: number;
  }) => void;
  const requested = new Promise<{
    sealedWatermark: number;
    appendVersion: number;
  }>((resolve) => {
    finish = resolve;
  });
  const session = new SessionReplay<string[], string>({
    empty: () => [],
    apply: (view, batch) => [...view, ...batch.updates],
  });
  session.receive(part(1), "old");
  assert.deepEqual(session.snapshot().view, ["old"]);
  const loading = session.load(() => requested);
  session.receive(part(1, 0, 2), "new first");
  session.receive(part(1, 1, 2), "new second");
  session.receive({ kind: "checkpoint", sequence: 2 });
  assert.deepEqual(session.snapshot().view, ["old"]);
  assert.equal(session.snapshot().loading, true);
  finish({ sealedWatermark: 2, appendVersion: 3 });
  await loading;
  assert.deepEqual(session.snapshot(), {
    view: ["new first", "new second"],
    watermark: 2,
    appendVersion: 3,
    loading: false,
    needsReconcile: false,
  });
});

test("load waits for notifications that arrive after the sealed response", async () => {
  const session = new SessionReplay<string[], string>({
    empty: () => [], apply: (view, batch) => [...view, ...batch.updates],
  }, { sealWaitMs: 1_000 });
  const loading = session.load(async () => ({ sealedWatermark: 2, appendVersion: 4 }));
  const settled = loading.then(() => "resolved", () => "rejected");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.snapshot().loading, true);
  assert.deepEqual(session.snapshot().view, []);
  session.receive(part(1), "late answer");
  session.receive({ kind: "checkpoint", sequence: 2 });
  assert.equal(await settled, "resolved");
  assert.equal(session.snapshot().appendVersion, 4);
  assert.deepEqual(session.snapshot().view, ["late answer"]);
});

test("a capacity failure interrupts the seal wait and preserves the previous view", async () => {
  const session = new SessionReplay<string[], string>({
    empty: () => [], apply: (view, batch) => [...view, ...batch.updates],
  }, { sealWaitMs: 1_000 });
  session.receive(part(1), "old");
  const loading = session.load(async () => ({ sealedWatermark: 3, appendVersion: 2 }));
  await new Promise((resolve) => setImmediate(resolve));
  session.invalidate(new Error("history capacity"));
  await assert.rejects(loading, /history capacity/);
  assert.deepEqual(session.snapshot().view, ["old"]);
  assert.equal(session.snapshot().needsReconcile, true);
});

test("failed replay ignores later parts instead of replacing the original failure", async () => {
  const session = new SessionReplay<string[], string>({
    empty: () => [], apply: (view, batch) => [...view, ...batch.updates],
  });
  const loading = session.load(async () => {
    session.receive(part(1), "first");
    session.invalidate(new Error("history capacity"));
    assert.doesNotThrow(() => session.receive(part(1), "conflicting late part"));
    return { sealedWatermark: 1, appendVersion: 1 };
  });
  await assert.rejects(loading, /history capacity/);
  assert.deepEqual(session.snapshot().view, []);
});

test("failed replay preserves the old view and a later attempt may recover", async () => {
  const session = new SessionReplay<string[], string>({
    empty: () => [],
    apply: (view, batch) => [...view, ...batch.updates],
  });
  session.receive(part(1), "old");
  await assert.rejects(
    session.load(async () => {
      session.receive(part(1), "candidate");
      throw new Error("ACP disconnected");
    }),
    /ACP disconnected/,
  );
  assert.deepEqual(session.snapshot(), {
    view: ["old"],
    watermark: 1,
    appendVersion: null,
    loading: false,
    needsReconcile: true,
  });
  await session.load(async () => {
    session.receive(part(1), "recovered");
    session.receive({ kind: "checkpoint", sequence: 2 });
    return { sealedWatermark: 2, appendVersion: 1 };
  });
  assert.deepEqual(session.snapshot().view, ["recovered"]);
  assert.equal(session.snapshot().needsReconcile, false);
});

test("an incomplete batch cannot replace a previous view even if load returns success", async () => {
  const session = new SessionReplay<string[], string>({
    empty: () => [],
    apply: (view, batch) => [...view, ...batch.updates],
  }, { sealWaitMs: 5 });
  session.receive(part(1), "old");
  await assert.rejects(
    session.load(async () => {
      session.receive(part(1, 0, 2), "half");
      session.receive({ kind: "checkpoint", sequence: 1 });
      return { sealedWatermark: 1, appendVersion: 2 };
    }),
  );
  assert.deepEqual(session.snapshot().view, ["old"]);
  assert.equal(session.snapshot().needsReconcile, true);
});

test("terminal output is not complete until the delivered watermark catches up", () => {
  const session = new SessionReplay<string[], string>({
    empty: () => [],
    apply: (view, batch) => [...view, ...batch.updates],
  });
  session.receive(part(1), "answer");
  assert.equal(session.hasCompleteOutput(2), false);
  session.receive({ kind: "checkpoint", sequence: 2 });
  assert.equal(session.hasCompleteOutput(2), true);
});

test("load seeds only its candidate view before the sealed cut replaces current state", async () => {
  const session = new SessionReplay<{ label: string }, string>({
    empty: () => ({ label: "empty" }),
    apply: (view) => view,
  });
  let finish!: (cut: {
    sealedWatermark: number;
    appendVersion: number;
  }) => void;
  const cut = new Promise<{ sealedWatermark: number; appendVersion: number }>(
    (resolve) => {
      finish = resolve;
    },
  );
  const loading = session.load(async (candidate) => {
    candidate.label = "from load";
    return cut;
  });
  assert.equal(session.snapshot().view.label, "empty");
  finish({ sealedWatermark: 0, appendVersion: 1 });
  await loading;
  assert.equal(session.snapshot().view.label, "from load");
});

test("replay accounting includes both views and releases a failed candidate", async () => {
  const session = new SessionReplay<string[], string>({
    empty: () => [],
    apply: (view, batch) => [...view, ...batch.updates],
    estimate: (view) => view.reduce((sum, item) => sum + item.length, 0),
  });
  session.receive(part(1), "old");
  assert.equal(session.estimatedRetainedBytes, 3);
  await assert.rejects(
    session.load(async () => {
      session.receive(part(1), "candidate");
      assert.equal(session.estimatedRetainedBytes, 12);
      throw new Error("load failed");
    }),
    /load failed/,
  );
  assert.equal(session.estimatedRetainedBytes, 3);
  await session.load(async () => {
    session.receive(part(1), "new");
    return { sealedWatermark: 1, appendVersion: 2 };
  });
  assert.equal(session.estimatedRetainedBytes, 3);
});

test("replay accounting includes incomplete delivery parts", () => {
  const session = new SessionReplay<string[], string>({
    empty: () => [],
    apply: (view, batch) => [...view, ...batch.updates],
    estimate: (view) => view.reduce((sum, item) => sum + item.length, 0),
  });
  session.receive(part(1, 0, 2), "partial");
  assert.ok(session.estimatedRetainedBytes > 0);
  session.receive(part(1, 1, 2), "complete");
  assert.equal(session.estimatedRetainedBytes, "partialcomplete".length);
});
