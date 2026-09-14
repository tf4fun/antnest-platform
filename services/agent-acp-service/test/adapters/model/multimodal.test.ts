import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModel } from "../../../src/adapters/model/openai-compatible.js";
import type { AuthenticatedModelRequest } from "../../../src/ports/model.js";
import { snapshot } from "../../support/fixtures.js";
import { audio, audioData, pdf, pdfData } from "../../fixtures/multimodal.js";

function harness() {
  const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(
      Response.json({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "consumed" } }],
      }),
    ),
  );
  const request: AuthenticatedModelRequest = {
    snapshot: snapshot(),
    credential: "synthetic-secret",
    tools: [],
    messages: [{ role: "user", content: [] }],
    signal: AbortSignal.timeout(5000),
  };
  request.snapshot.executionSpec.model = {
    ...request.snapshot.executionSpec.model,
    supportsImages: true,
    supportsAudio: true,
    supportsPdf: true,
  };
  const model = new OpenAICompatibleModel({ fetchFn });
  const body = () => {
    const value = fetchFn.mock.calls[0]?.[1].body;
    if (typeof value !== "string") throw new Error("No model request");
    return JSON.parse(value) as {
      messages: Array<{ role: string; content: unknown }>;
      modalities?: string[];
    };
  };
  return { model, request, fetchFn, body };
}

describe("native standard Prompt conversion", () => {
  it("sends exact native bytes in mixed content order without uploads or extra credentials", async () => {
    const h = harness();
    h.request.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these" },
          audio,
          pdf,
          {
            type: "resource",
            resource: { uri: "attachment:///notes.txt", mimeType: "text/plain", blob: "aGk=" },
          },
          { type: "image", mimeType: "image/png", data: "aGk=" },
          { type: "resource_link", uri: "https://never-fetch.invalid/private", name: "Reference" },
        ],
      },
    ];
    await expect(h.model.complete(h.request)).resolves.toMatchObject({ kind: "message" });
    expect(h.body().messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these" },
          { type: "input_audio", input_audio: { data: audioData, format: "wav" } },
          { type: "text", text: "Embedded resource: attachment:///report.pdf" },
          {
            type: "file",
            file: {
              filename: "attachment.pdf",
              file_data: `data:application/pdf;base64,${pdfData}`,
            },
          },
          { type: "text", text: "Embedded resource: attachment:///notes.txt\nhi" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
          { type: "text", text: "Resource: Reference\nURI: https://never-fetch.invalid/private" },
        ],
      },
    ]);
    expect(h.body().modalities).toEqual(["text"]);
    expect(h.fetchFn).toHaveBeenCalledExactlyOnceWith(
      `${h.request.snapshot.executionSpec.model.baseUrl}/chat/completions`,
      expect.objectContaining({
        signal: h.request.signal,
      }),
    );
    expect(new Headers(h.fetchFn.mock.calls[0]?.[1].headers).get("authorization")).toBe(
      "Bearer synthetic-secret",
    );
  });

  it.each(["audio/mpeg", "audio/mp3"])("maps %s to native MP3 input", async (mimeType) => {
    const h = harness();
    h.request.messages = [{ role: "user", content: [{ ...audio, mimeType }] }];
    await h.model.complete(h.request);
    expect(h.body().messages[0]?.content).toEqual([
      { type: "input_audio", input_audio: { data: audioData, format: "mp3" } },
    ]);
  });

  it.each([
    { flag: "supportsAudio" as const, content: audio },
    { flag: "supportsPdf" as const, content: pdf },
  ])(
    "checks admitted $flag even for older history after a model switch",
    async ({ flag, content }) => {
      const h = harness();
      h.request.snapshot.executionSpec.model[flag] = false;
      h.request.messages = [
        { role: "user", content: [content] },
        { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ];
      await expect(h.model.complete(h.request)).rejects.toMatchObject({
        code: "model_unsupported_content",
        retryable: false,
      });
      expect(h.fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each(["system", "assistant", "tool"] as const)(
    "does not smuggle binary input into %s text",
    async (role) => {
      const h = harness();
      h.request.messages = [{ role, toolCallId: "tool-1", content: [pdf] }];
      await expect(h.model.complete(h.request)).rejects.toMatchObject({
        code: "model_unsupported_content",
        retryable: false,
      });
      expect(h.fetchFn).not.toHaveBeenCalled();
    },
  );

  it("does not label bad Base64 as a network failure", async () => {
    const h = harness();
    h.request.messages = [
      { role: "user", content: [{ ...audio, data: "private-invalid-content" }] },
    ];
    await expect(h.model.complete(h.request)).rejects.toMatchObject({
      code: "unsupported_audio_content",
    });
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
});
