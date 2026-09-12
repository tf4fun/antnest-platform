import assert from "node:assert/strict";
import test from "node:test";
import { attachmentAccept, describeAttachment, inlineMediaURL, validateAttachmentCount } from "./attachments.ts";

test("file picker reflects each connection's independent negotiated capabilities", () => {
  for (const audio of [false, true]) for (const image of [false, true]) for (const embeddedContext of [false, true]) {
    const accepted = attachmentAccept({ audio, image, embeddedContext }).split(",");
    assert.ok(accepted.includes(".txt"));
    assert.equal(accepted.includes(".mp3"), audio);
    assert.equal(accepted.includes("image/png"), image);
    assert.equal(accepted.includes(".pdf"), embeddedContext);
    assert.equal(accepted.includes("audio/*"), false);
  }
  assert.equal(attachmentAccept(undefined), attachmentAccept({}));
});

test("metadata validation precedes allocation and handles browser MIME aliases", () => {
  const capabilities = { audio: true, image: true, embeddedContext: true };
  for (const mimeType of ["audio/x-wav", "audio/wave", "audio/wav", "audio/mp3", "audio/mpeg"]) {
    assert.equal(describeAttachment(new File(["a"], "sample", { type: mimeType }), capabilities).kind, "audio");
  }
  assert.deepEqual(describeAttachment(new File(["a"], "SAMPLE.MP3"), capabilities), { kind: "audio", mimeType: "audio/mpeg" });
  assert.throws(() => describeAttachment(new File([], "empty.mp3"), capabilities), /empty/);
  assert.throws(() => describeAttachment(new File(["a"], "note.txt", { type: "text/plain;charset=latin1" }), capabilities), /not supported/);
  validateAttachmentCount(6);
  assert.throws(() => validateAttachmentCount(7), /six/);
});

test("image and unnegotiated plain text retain their bounded 4 MiB path", () => {
  const bytes = new Uint8Array(4_194_304);
  assert.equal(describeAttachment(new File([bytes], "photo.png"), { image: true }).kind, "image");
  assert.equal(describeAttachment(new File([bytes], "notes.txt"), {}).kind, "text");
  assert.throws(() => describeAttachment(new File([bytes, "x"], "photo.png"), { image: true }), /4 MiB/);
});

test("inline previews are bounded allowlisted data, never an untrusted URL", () => {
  assert.equal(inlineMediaURL("image", "image/svg+xml", btoa("svg")), undefined);
  assert.equal(inlineMediaURL("audio", "audio/mpeg", "https://example.test"), undefined);
  assert.equal(inlineMediaURL("image", "image/png", "not-base64"), undefined);
  const audio = btoa("x".repeat(1_048_576));
  assert.equal(inlineMediaURL("audio", "audio/mpeg", audio), `data:audio/mpeg;base64,${audio}`);
  assert.ok(inlineMediaURL("audio", "audio/mpeg", btoa("x".repeat(1_048_577))) === undefined);
});
