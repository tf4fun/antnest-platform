import { describe, expect, it } from "vitest";

import { normalizeEmbeddedResource } from "../../src/domain/embedded-resource.js";

describe("embedded resources", () => {
  it("decodes UTF-8 textual blobs and preserves their URI", () => {
    expect(
      normalizeEmbeddedResource({
        uri: "attachment:///notes",
        mimeType: "application/json",
        blob: Buffer.from('{"name":"中文"}').toString("base64"),
      }),
    ).toEqual({
      uri: "attachment:///notes",
      mimeType: "application/json",
      text: '{"name":"中文"}',
    });
  });
  it.each([
    { mimeType: "application/pdf", blob: "JVBERg==" },
    { mimeType: "image/png", blob: "aGVsbG8=" },
    { mimeType: "text/plain", blob: "%%%" },
    { mimeType: "text/plain", blob: "/w==" },
    { mimeType: "text/plain;charset=gbk", blob: "aGVsbG8=" },
    { mimeType: "text/plain" },
  ])(
    "rejects unsupported or invalid blobs instead of pretending they are readable (%j)",
    (resource) => {
      expect(() => normalizeEmbeddedResource({ uri: "attachment:///file", ...resource })).toThrow(
        expect.objectContaining({ code: "unsupported_resource_content" }),
      );
    },
  );
});
