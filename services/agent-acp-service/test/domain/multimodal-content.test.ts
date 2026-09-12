import { describe, expect, it } from "vitest";
import { normalizePromptResources } from "../../src/domain/embedded-resource.js";
import { audio, audioData, pdf, pdfData } from "../fixtures/multimodal.js";

describe("standard Prompt attachments", () => {
  it("preserves native binary content and annotations while decoding textual resources", () => {
    const annotations = { audience: ["assistant"], priority: 0.5 };
    expect(
      normalizePromptResources([
        { ...pdf, annotations },
        audio,
        {
          type: "resource",
          resource: { uri: "attachment:///notes.txt", mimeType: "text/plain", blob: "aGk=" },
        },
      ]),
    ).toEqual([
      { ...pdf, annotations },
      audio,
      {
        type: "resource",
        resource: { uri: "attachment:///notes.txt", mimeType: "text/plain", text: "hi" },
      },
    ]);
  });

  it.each(["audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3"])(
    "accepts the configured native audio MIME family %s",
    (mimeType) => {
      expect(normalizePromptResources([{ ...audio, mimeType }])).toEqual([{ ...audio, mimeType }]);
    },
  );

  it.each([
    { mimeType: "audio/ogg", data: audioData },
    { mimeType: "audio/wav", data: "%%%" },
    { mimeType: "audio/wav", data: "" },
    { mimeType: "audio/wav", data: "aGk" },
    { mimeType: "audio/wav", data: 42 },
    { data: audioData },
    { mimeType: "audio/wav", data: Buffer.alloc(1_048_577).toString("base64") },
  ])("rejects malformed, unsupported or oversized audio without echoing its body", (input) => {
    expect(() => normalizePromptResources([{ type: "audio", ...input }])).toThrowError(
      expect.objectContaining({ code: "unsupported_audio_content" }),
    );
  });

  it.each([
    { mimeType: "application/pdf", blob: "aGk=" },
    { mimeType: "application/pdf", blob: pdfData, text: "ambiguous" },
    { mimeType: "application/zip", blob: pdfData },
    { mimeType: "application/pdf", blob: "" },
    { mimeType: "application/pdf", blob: Buffer.alloc(1_048_577).toString("base64") },
    { mimeType: "text/plain", text: "a".repeat(1_048_577) },
    { mimeType: "text/plain", text: "a", blob: "Yg==" },
  ])("rejects invalid/ambiguous documents before admission", (resource) => {
    expect(() =>
      normalizePromptResources([
        { type: "resource", resource: { uri: "attachment:///input", ...resource } },
      ]),
    ).toThrowError(expect.objectContaining({ code: "unsupported_resource_content" }));
  });
});
