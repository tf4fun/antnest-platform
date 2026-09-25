import assert from "node:assert/strict";
import test from "node:test";
import { appendBridgeContentPage, initialBridgeContent, loadBridgeTurnContent } from "./bridge-content.ts";

test("continued prompt and final answer blocks keep their sections and exact order", () => {
  let state = initialBridgeContent(
    [{ type: "text", text: "prompt 1" }],
    [{ type: "text", text: "answer 1" }],
    "cut-1",
  );
  state = appendBridgeContentPage(state, {
    section: "prompt", items: [{ type: "text", text: "prompt 2" }],
    nextCursor: "cut-2", complete: false,
  });
  state = appendBridgeContentPage(state, {
    section: "finalResponse", items: [{ type: "text", text: "answer 2" }],
    nextCursor: null, complete: true,
  });
  assert.deepEqual(state.prompt.map((block) => block.text), ["prompt 1", "prompt 2"]);
  assert.deepEqual(state.finalResponse.map((block) => block.text), ["answer 1", "answer 2"]);
  assert.equal(state.complete, true);
  assert.equal(state.cursor, null);
});

test("fragmented UTF-8 JSON block is published only after every byte arrives", () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ type: "text", text: "你好世界" }));
  const split = 20;
  let state = initialBridgeContent([], [], "cut-1");
  state = appendBridgeContentPage(state, {
    section: "finalResponse", items: [], fragment: {
      blockIndex: 0, byteOffset: 0, totalBytes: encoded.length,
      serializedBlockBase64: Buffer.from(encoded.subarray(0, split)).toString("base64"),
    }, nextCursor: "cut-2", complete: false,
  });
  assert.equal(state.finalResponse.length, 0);
  state = appendBridgeContentPage(state, {
    section: "finalResponse", items: [], fragment: {
      blockIndex: 0, byteOffset: split, totalBytes: encoded.length,
      serializedBlockBase64: Buffer.from(encoded.subarray(split)).toString("base64"),
    }, nextCursor: null, complete: true,
  });
  assert.deepEqual(state.finalResponse, [{ type: "text", text: "你好世界" }]);
});

test("out-of-order or mismatched fragments fail without changing the prior content", () => {
  const state = initialBridgeContent([], [], "cut-1");
  assert.throws(() => appendBridgeContentPage(state, {
    section: "finalResponse", items: [], fragment: {
      blockIndex: 0, byteOffset: 4, totalBytes: 10, serializedBlockBase64: "YQ==",
    }, nextCursor: "cut-2", complete: false,
  }), /fragment/u);
  assert.equal(state.finalResponse.length, 0);
  assert.equal(state.cursor, "cut-1");
});

test("turn content loader follows opaque cursors without skipping a split block", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ type: "text", text: "answer" }));
  const calls: string[] = [];
  const pages = new Map<string, unknown>([
    ["cut-1", { section: "finalResponse", items: [], fragment: {
      blockIndex: 0, byteOffset: 0, totalBytes: encoded.length,
      serializedBlockBase64: Buffer.from(encoded.subarray(0, 8)).toString("base64"),
    }, nextCursor: "cut-2", complete: false }],
    ["cut-2", { section: "finalResponse", items: [], fragment: {
      blockIndex: 0, byteOffset: 8, totalBytes: encoded.length,
      serializedBlockBase64: Buffer.from(encoded.subarray(8)).toString("base64"),
    }, nextCursor: null, complete: true }],
  ]);
  const complete = await loadBridgeTurnContent({
    turnContent: async (_agent, _session, _turn, cursor) => {
      calls.push(cursor);
      return pages.get(cursor);
    },
  }, "agent", "session", "turn", initialBridgeContent([], [], "cut-1"));
  assert.deepEqual(calls, ["cut-1", "cut-2"]);
  assert.deepEqual(complete.finalResponse, [{ type: "text", text: "answer" }]);
  assert.equal(complete.complete, true);
});

test("turn content loader rejects a repeated cursor", async () => {
  await assert.rejects(loadBridgeTurnContent({
    turnContent: async () => ({ section: "prompt", items: [{ type: "text", text: "x" }],
      nextCursor: "cut-1", complete: false }),
  }, "agent", "session", "turn", initialBridgeContent([], [], "cut-1")), /cursor did not advance/u);
});

test("a large valid content block is not rejected by a cumulative byte quota", () => {
  const state = appendBridgeContentPage(initialBridgeContent([], [], "cut-1"), {
    section: "finalResponse", items: [], fragment: {
      blockIndex: 0, byteOffset: 0, totalBytes: 65 * 1024 * 1024,
      serializedBlockBase64: "ew==",
    }, nextCursor: "cut-2", complete: false,
  });
  assert.equal(state.complete, false);
  assert.equal(state.fragment?.totalBytes, 65 * 1024 * 1024);
});

test("complete content follows more than 1024 advancing pages", async () => {
  let index = 0;
  const complete = await loadBridgeTurnContent({ turnContent: async () => {
    index++;
    return { section: "finalResponse", items: [{ type: "text", text: String(index) }],
      nextCursor: index === 1025 ? null : `cut-${index}`, complete: index === 1025 };
  } }, "agent", "session", "turn", initialBridgeContent([], [], "cut-0"));
  assert.equal(complete.finalResponse.length, 1025);
  assert.equal(complete.complete, true);
});
