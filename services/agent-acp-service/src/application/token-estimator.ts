import { getEncoding } from "js-tiktoken";

import type {
  ContentBlock,
  ModelMessage,
  ModelSpec,
  ModelToolDefinition,
} from "../domain/types.js";
import type { TokenEstimator } from "../ports/token-estimator.js";

const IMAGE_BASE_TOKENS = 85;
const IMAGE_TILE_TOKENS = 170;
const MINI_IMAGE_BASE_TOKENS = 2833;
const MINI_IMAGE_TILE_TOKENS = 5667;
const IMAGE_LONG_EDGE = 2048;
const IMAGE_SHORT_EDGE = 768;
const IMAGE_TILE_EDGE = 512;
const MEDIA_RESERVE_TOKENS = 4096;
const MESSAGE_FRAME_TOKENS = 8;
const ENCODE_CHUNK_UNITS = 128;

type Encoding = ReturnType<typeof getEncoding>;

const encodings = new Map<string, Encoding>();

function encoding(name: "o200k_base" | "cl100k_base"): Encoding {
  let cached = encodings.get(name);
  if (cached === undefined) {
    cached = getEncoding(name);
    encodings.set(name, cached);
  }
  return cached;
}

export function createTokenEstimator(
  model?: Pick<ModelSpec, "tokenizer" | "model">,
): TokenEstimator {
  const tokenizer = model?.tokenizer;
  const name =
    tokenizer === "o200k" || tokenizer === "cl100k" ? (`${tokenizer}_base` as const) : undefined;
  const base =
    model?.model.startsWith("gpt-4o-mini") === true ? MINI_IMAGE_BASE_TOKENS : IMAGE_BASE_TOKENS;
  const perTile =
    model?.model.startsWith("gpt-4o-mini") === true ? MINI_IMAGE_TILE_TOKENS : IMAGE_TILE_TOKENS;
  const chunkCache = new Map<string, number>();
  const estimateText = (text: string): number => {
    if (name === undefined) return Buffer.byteLength(text, "utf8");
    const encodeChunk = (chunk: string): number => {
      const cached = chunkCache.get(chunk);
      if (cached !== undefined) return cached;
      const count = encoding(name).encode(chunk, [], []).length;
      if (chunkCache.size >= 256) chunkCache.delete(chunkCache.keys().next().value!);
      chunkCache.set(chunk, count);
      return count;
    };
    if (text.length <= ENCODE_CHUNK_UNITS) return encodeChunk(text);
    let total = 0;
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + ENCODE_CHUNK_UNITS, text.length);
      if (end < text.length) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
      total += encodeChunk(text.slice(offset, end));
      offset = end;
    }
    return total;
  };
  const estimateImage = (width?: number, height?: number): number => {
    if (
      typeof width !== "number" ||
      !Number.isFinite(width) ||
      width <= 0 ||
      typeof height !== "number" ||
      !Number.isFinite(height) ||
      height <= 0
    )
      return base + perTile * 8;
    let w = width;
    let h = height;
    const longest = Math.max(w, h);
    if (longest > IMAGE_LONG_EDGE) {
      const scale = IMAGE_LONG_EDGE / longest;
      w *= scale;
      h *= scale;
    }
    const shortest = Math.min(w, h);
    if (shortest > IMAGE_SHORT_EDGE) {
      const scale = IMAGE_SHORT_EDGE / shortest;
      w *= scale;
      h *= scale;
    }
    return base + perTile * Math.ceil(w / IMAGE_TILE_EDGE) * Math.ceil(h / IMAGE_TILE_EDGE);
  };
  const estimateBlock = (block: ContentBlock): number => {
    if (block.type === "text" && typeof block.text === "string") return estimateText(block.text);
    if (block.type === "image") return estimateImage();
    if (block.type === "audio") return MEDIA_RESERVE_TOKENS;
    if (block.type === "resource") {
      const resource = block.resource;
      if (
        typeof resource === "object" &&
        resource !== null &&
        "text" in resource &&
        typeof resource.text === "string"
      ) {
        const uri = "uri" in resource && typeof resource.uri === "string" ? resource.uri : "";
        return estimateText(`${uri}\n${resource.text}`);
      }
      return MEDIA_RESERVE_TOKENS;
    }
    if (block.type === "resource_link") {
      return estimateText(
        stringField(block, "uri") + stringField(block, "name") + stringField(block, "description"),
      );
    }
    return estimateText(JSON.stringify(block));
  };
  const estimateMessages = (messages: ModelMessage[]): number =>
    messages.reduce((total, message) => {
      let count = MESSAGE_FRAME_TOKENS;
      for (const block of message.content) count += estimateBlock(block);
      if (message.role === "assistant") {
        for (const block of message.thought ?? []) count += estimateBlock(block);
        for (const call of message.toolCalls ?? [])
          count += estimateText(call.name + call.id + JSON.stringify(call.arguments));
      }
      if (message.role === "tool") count += estimateText(message.toolCallId);
      return total + count;
    }, 0);
  const estimateTools = (tools: ModelToolDefinition[]): number =>
    tools.reduce(
      (total, tool) =>
        total +
        estimateText(
          tool.modelName +
            tool.description +
            (tool.inputSchema === undefined ? "" : JSON.stringify(tool.inputSchema)),
        ),
      0,
    );
  return { estimateText, estimateImage, estimateMessages, estimateTools };
}

function stringField(value: object, name: string): string {
  const field = (value as Record<string, unknown>)[name];
  return typeof field === "string" ? field : "";
}
