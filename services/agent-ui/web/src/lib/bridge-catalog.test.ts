import assert from "node:assert/strict";
import test from "node:test";
import { BridgeSessionCatalog } from "./bridge-catalog.ts";

test("Bridge catalog keeps native pagination and merges known Session metadata", async () => {
  const cursors: (string | undefined)[] = [];
  const api = { sessions: async (_agentId: string, cursor?: string) => {
    cursors.push(cursor);
    return cursor === undefined
      ? { items: [{ sessionId: "s1", title: "First", updatedAt: "2026-09-22T00:00:00Z", activeOperationId: null }], nextCursor: "page-2" }
      : { items: [{ sessionId: "s2", title: "Second", updatedAt: null, activeOperationId: null }], nextCursor: null };
  } };
  const catalog = new BridgeSessionCatalog("agent-1", api);
  assert.equal((await catalog.loadPage()).hasMore, true);
  assert.equal((await catalog.loadPage()).hasMore, false);
  assert.deepEqual(cursors, [undefined, "page-2"]);
  assert.deepEqual(catalog.conversations.map((item) => item.id), ["s1", "s2"]);
  assert.equal(catalog.conversations[0]?.title, "First");
  assert.equal(catalog.conversations[1]?.title, "Second");
});

test("late catalog pages and older Views cannot roll back newer ACP metadata", async () => {
  let resolve!: (value: { items: { sessionId: string; title: string;
    updatedAt: string; activeOperationId: null }[]; nextCursor: null }) => void;
  const catalog = new BridgeSessionCatalog("agent-1", {
    sessions: () => new Promise((done) => { resolve = done; }),
  });
  const pending = catalog.loadPage();
  catalog.remember({ id: "s1", agentId: "agent-1", title: "New title",
    updatedAt: "2026-09-24T02:00:00Z", messages: [] });
  resolve({ items: [{ sessionId: "s1", title: "Old title",
    updatedAt: "2026-09-24T01:00:00Z", activeOperationId: null }], nextCursor: null });
  await pending;
  assert.equal(catalog.conversations[0]?.title, "New title");
  catalog.remember({ id: "s1", agentId: "agent-1", title: "Older View",
    updatedAt: "2026-09-24T01:30:00Z", messages: [] });
  assert.equal(catalog.conversations[0]?.title, "New title");
});

test("Bridge catalog rejects a cursor loop and duplicate Session identity", async () => {
  const looping = new BridgeSessionCatalog("agent-1", {
    sessions: async () => ({ items: [], nextCursor: "again" }),
  });
  await looping.loadPage();
  await assert.rejects(looping.loadPage(), /repeated cursor/u);
  const duplicate = new BridgeSessionCatalog("agent-1", {
    sessions: async () => ({ items: [
      { sessionId: "same", title: "One", updatedAt: null, activeOperationId: null },
      { sessionId: "same", title: "Two", updatedAt: null, activeOperationId: null },
    ], nextCursor: null }),
  });
  await assert.rejects(duplicate.loadPage(), /duplicate Session/u);
});

test("catalog metadata refresh retains an accepted limited View", async () => {
  const catalog = new BridgeSessionCatalog("agent-1", {
    sessions: async () => ({ items: [{ sessionId: "s1", title: "Updated",
      updatedAt: "2026-09-24T00:00:00Z", activeOperationId: null }], nextCursor: null }),
  });
  catalog.remember({ id: "s1", agentId: "agent-1", title: "Before", updatedAt: "now",
    messages: [], historyState: "view_limited",
    limitedPreview: { text: "recent", truncated: true } });
  await catalog.loadPage();
  assert.equal(catalog.conversations[0]?.title, "Updated");
  assert.equal(catalog.conversations[0]?.historyState, "view_limited");
  assert.equal(catalog.conversations[0]?.limitedPreview?.text, "recent");
});
