import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptBlocks } from "./prompt.ts";
import type { Attachment } from "./types.ts";

const capabilities = { audio: true, image: true, embeddedContext: true };
function attachment(name: string, type: string, body: BlobPart): Attachment {
  const file = new File([body], name, { type });
  return { id: name, name, kind: type.startsWith("image/") ? "image" : "file", sizeLabel: String(file.size), file };
}

test("WAV and MP3 use standard audio blocks and preserve exact bytes/order", async () => {
  const wav = attachment("recording.wav", "audio/wav", "RIFF audio bytes");
  const mp3 = attachment("voice.mp3", "audio/mpeg", "ID3 audio bytes");
  assert.deepEqual(await buildPromptBlocks(" Listen ", [wav, mp3], capabilities), [
    { type: "text", text: "Listen" },
    { type: "audio", mimeType: "audio/wav", data: btoa("RIFF audio bytes") },
    { type: "audio", mimeType: "audio/mpeg", data: btoa("ID3 audio bytes") },
  ]);
});

test("PDF with missing browser MIME is normalized and embedded, not read as text", async () => {
  assert.deepEqual(await buildPromptBlocks("", [attachment("report.pdf", "", "%PDF-1.7\nreport")], capabilities), [
    { type: "resource", resource: { uri: "attachment:///report.pdf", mimeType: "application/pdf", blob: btoa("%PDF-1.7\nreport") } },
  ]);
});

test("negotiated capability does not allow arbitrary binary or unsupported audio", async () => {
  for (const file of [attachment("data.zip", "application/zip", "zip"), attachment("recording.ogg", "audio/ogg", "ogg")]) {
    await assert.rejects(buildPromptBlocks("", [file], capabilities), /not supported/i);
  }
  for (const caps of [undefined, {}, { audio: false, image: false, embeddedContext: false }]) {
    await assert.rejects(buildPromptBlocks("", [attachment("voice.mp3", "audio/mpeg", "ID3")], caps), /audio/i);
    await assert.rejects(buildPromptBlocks("", [attachment("report.pdf", "application/pdf", "%PDF-")], caps), /PDF/i);
    await assert.rejects(buildPromptBlocks("", [attachment("photo.png", "image/png", "png")], caps), /image/i);
  }
});

test("native attachments enforce 1 MiB before file reading and allow the exact boundary", async () => {
  for (const [name, type] of [["voice.mp3", "audio/mpeg"], ["report.pdf", "application/pdf"], ["notes.txt", "text/plain"]]) {
    const file = attachment(name!, type!, new Uint8Array(1_048_577));
    file.file!.arrayBuffer = async () => { throw new Error("must not read oversized file"); };
    await assert.rejects(buildPromptBlocks("", [file], capabilities), /1 MiB/);
  }
  const result = await buildPromptBlocks("", [attachment("voice.mp3", "audio/mpeg", new Uint8Array(1_048_576))], capabilities);
  assert.equal(result[0]?.type, "audio");
});

test("explicit unsupported MIME cannot masquerade as text by changing the filename", async () => {
  await assert.rejects(buildPromptBlocks("", [attachment("archive.md", "application/zip", "binary")], capabilities), /not supported/i);
});

test("UTF-8 documents preserve names and content with optional fallback to plain text", async () => {
  const file = attachment("会议.md", "text/markdown", "会议资料");
  assert.deepEqual(await buildPromptBlocks("", [file], capabilities), [
    { type: "resource", resource: { uri: `attachment:///${encodeURIComponent(file.name)}`, mimeType: "text/markdown", text: "会议资料" } },
  ]);
  assert.deepEqual(await buildPromptBlocks("", [file], {}), [
    { type: "text", text: "\n\nAttachment: 会议.md\n\n会议资料" },
  ]);
  await assert.rejects(buildPromptBlocks("", [attachment("invalid.txt", "text/plain", new Uint8Array([255]))], capabilities), /UTF-8/);
});

test("selection count, empty input, missing file and invalid PDF are explicit errors", async () => {
  await assert.rejects(buildPromptBlocks("", Array.from({ length: 7 }, (_, i) => attachment(`${i}.txt`, "text/plain", "ok")), capabilities), /six/i);
  await assert.rejects(buildPromptBlocks(" ", [], capabilities), /Enter a message/);
  await assert.rejects(buildPromptBlocks("", [{ id: "x", name: "x", kind: "file", sizeLabel: "1 B" }], capabilities), /no longer available/);
  await assert.rejects(buildPromptBlocks("", [attachment("bad.pdf", "application/pdf", "not pdf")], capabilities), /PDF/);
  assert.deepEqual(await buildPromptBlocks(" hello ", [], undefined), [{ type: "text", text: "hello" }]);
});
