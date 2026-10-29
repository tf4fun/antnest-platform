import { describe, expect, it } from "vitest";
import { getEncoding } from "js-tiktoken";

import { createTokenEstimator } from "../../src/application/token-estimator.js";
import type { ModelMessage, ModelToolDefinition } from "../../src/domain/types.js";

const encodings = {
  o200k_base: getEncoding("o200k_base"),
  cl100k_base: getEncoding("cl100k_base"),
};

const corpus = [
  "The quick brown fox jumps over the lazy dog.",
  "上下文管理需要对中文文本进行准确的词元估算，而不是按长度粗略截断。",
  "Mixed English 和中文 content shares one context window.",
  "function estimate(text) {\n  return Math.ceil(text.length / 4);\n}",
  '{\n  "escaped": "line\\nbreak \\"quote\\" \\\\slash",\n  "unicode": "\\u4e2d\\u6587"\n}',
];

describe("token estimator", () => {
  it.each([
    ["o200k", "o200k_base"],
    ["cl100k", "cl100k_base"],
  ] as const)("counts text exactly with the pinned %s encoding", (tokenizer, name) => {
    const estimator = createTokenEstimator({ model: "test-model", tokenizer });
    const encoding = encodings[name];
    for (const text of corpus) {
      expect(estimator.estimateText(text)).toBe(encoding.encode(text).length);
    }
  });

  it.each([{}, { tokenizer: "none" }] as const)(
    "falls back to the UTF-8 byte-length bound without an exact encoding: %j",
    (options) => {
      const estimator = createTokenEstimator({ model: "test-model", ...options });
      for (const text of corpus) {
        const bound = Buffer.byteLength(text, "utf8");
        expect(estimator.estimateText(text)).toBe(bound);
        for (const name of ["o200k_base", "cl100k_base"] as const) {
          expect(bound).toBeGreaterThanOrEqual(encodings[name].encode(text).length);
        }
      }
      expect(estimator.estimateText("")).toBe(0);
    },
  );

  it("uses the byte-length bound when no model is provided", () => {
    const estimator = createTokenEstimator();
    expect(estimator.estimateText("abc")).toBe(3);
  });

  it.each([{}, { tokenizer: "none" }, { tokenizer: "o200k" }, { tokenizer: "cl100k" }] as const)(
    "counts only the text payload plus bounded framing instead of the serialized envelope: %j",
    (options) => {
      const estimator = createTokenEstimator({ model: "test-model", ...options });
      const text = '"\n\\';
      const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text }] }];
      const framing = estimator.estimateMessages(messages) - estimator.estimateText(text);
      expect(framing).toBeGreaterThanOrEqual(0);
      expect(framing).toBeLessThanOrEqual(20);
    },
  );

  it("counts assistant thought and Tool call arguments", () => {
    const estimator = createTokenEstimator({ model: "test-model", tokenizer: "o200k" });
    const baseline: ModelMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    };
    const verbose: ModelMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      thought: [{ type: "text", text: "long reasoning ".repeat(100) }],
      toolCalls: [{ id: "call-1", name: "read", arguments: { path: "x".repeat(512) } }],
    };
    expect(estimator.estimateMessages([verbose])).toBeGreaterThan(
      estimator.estimateMessages([baseline]),
    );
  });

  it("scales image cost with declared dimensions and never with payload size", () => {
    const estimator = createTokenEstimator({ model: "test-model", tokenizer: "o200k" });
    expect(estimator.estimateImage(2048, 2048)).toBeGreaterThan(estimator.estimateImage(512, 512));
    const unknown = estimator.estimateImage();
    expect(unknown).toBeGreaterThan(0);
    expect(unknown).toBeGreaterThanOrEqual(estimator.estimateImage(512, 512));
    expect(estimator.estimateImage()).toBe(unknown);
    const message = (data: string): ModelMessage => ({
      role: "user",
      content: [{ type: "image", data, mimeType: "image/png" }],
    });
    expect(estimator.estimateMessages([message("QUJD".repeat(4096))])).toBe(
      estimator.estimateMessages([message("aW1hZ2U=")]),
    );
  });

  it("counts Tool definitions instead of ignoring their schema text", () => {
    const estimator = createTokenEstimator({ model: "test-model", tokenizer: "o200k" });
    const tool: ModelToolDefinition = {
      source: "runtime",
      sourceId: "runtime-1",
      name: "read",
      modelName: "read",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "p".repeat(256) } },
      },
    };
    expect(estimator.estimateTools([])).toBe(0);
    expect(estimator.estimateTools([tool])).toBeGreaterThan(0);
    expect(estimator.estimateTools([{ ...tool, description: "x".repeat(256) }])).toBeGreaterThan(
      estimator.estimateTools([tool]),
    );
  });
});
