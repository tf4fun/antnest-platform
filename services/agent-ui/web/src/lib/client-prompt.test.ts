import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptBlocks } from "./prompt.ts";

test("builds baseline text prompts and bounded text-file content", async () => {
  const file = new File(["alpha\nbeta"], "notes.md", { type: "text/markdown" });
  const blocks = await buildPromptBlocks("Review this", [{
    id: "attachment-1",
    name: file.name,
    kind: "file",
    sizeLabel: "10 B",
    mimeType: file.type,
    file,
  }], undefined);

  assert.deepEqual(blocks, [
    { type: "text", text: "Review this" },
    { type: "text", text: "\n\nAttachment: notes.md\n\nalpha\nbeta" },
  ]);
});

test("requires the Agent image capability before encoding an image", async () => {
  const file = new File([new Uint8Array([1, 2, 3])], "pixel.png", { type: "image/png" });
  const attachment = {
    id: "attachment-1",
    name: file.name,
    kind: "image" as const,
    sizeLabel: "3 B",
    mimeType: file.type,
    file,
  };

  await assert.rejects(() => buildPromptBlocks("", [attachment], undefined), /does not accept image/);
  assert.deepEqual(await buildPromptBlocks("", [attachment], { image: true }), [{
    type: "image",
    data: "AQID",
    mimeType: "image/png",
  }]);
});
