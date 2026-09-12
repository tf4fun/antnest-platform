import type { ContentBlock } from "../../src/domain/types.js";

// Small synthetic envelopes for byte-preserving conversion tests, not recognition fixtures.
export const pdfData = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n").toString("base64");
export const audioData = Buffer.from("RIFF\x04\x00\x00\x00WAVE").toString("base64");
export const pdf: ContentBlock = {
  type: "resource",
  resource: { uri: "attachment:///report.pdf", mimeType: "application/pdf", blob: pdfData },
};
export const audio: ContentBlock = { type: "audio", mimeType: "audio/wav", data: audioData };
