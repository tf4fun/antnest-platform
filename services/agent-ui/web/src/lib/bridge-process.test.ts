import assert from "node:assert/strict";
import test from "node:test";
import { loadBridgeProcessContent, loadBridgeProcessPage } from "./bridge-process.ts";

test("process page preserves bounded tool section indices", async () => {
  const page = await loadBridgeProcessPage({
    process: async () => ({ turnId: "turn", processVersion: 1,
      items: [{ id: "tool", kind: "tool", summary: "Read", status: "completed",
        content: [{ type: "text", text: 'Input: {"path":"notes.txt"}' }],
        contentCursor: "remaining", toolSections: { inputIndex: 0,
          outputIndex: 1, detailStartIndex: 2 } }], nextCursor: null }),
    processContent: async () => ({}),
  }, "agent", "session", "turn", 1, 1, new Set());
  assert.deepEqual(page.items[0]?.toolSections,
    { inputIndex: 0, outputIndex: 1, detailStartIndex: 2 });
});

test("process content follows every advancing page without a cumulative page quota", async () => {
  let index = 0;
  const item = await loadBridgeProcessContent({
    process: async () => { throw new Error("Unexpected process list request"); },
    processContent: async () => {
      index++;
      return { turnId: "turn", itemId: "tool", items: [{ type: "text", text: String(index) }],
        nextCursor: index === 1025 ? null : `cut-${index}`, complete: index === 1025 };
    },
  }, "agent", "session", "turn", { id: "tool", kind: "tool", summary: "Read",
    status: "completed", content: [], contentCursor: "cut-0" });
  assert.equal(item.content.length, 1025);
  assert.equal(item.contentCursor, null);
});
