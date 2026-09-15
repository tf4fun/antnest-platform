import { audioInput } from "../../domain/audio-content.js";
import { normalizeEmbeddedResource } from "../../domain/embedded-resource.js";
import type { ContentBlock, ModelMessage, ModelSpec } from "../../domain/types.js";
import { OpenAICompatibleModelError } from "./errors.js";

export function toOpenAIMessages(
  messages: ModelMessage[],
  model: ModelSpec,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  let images: ContentBlock[] = [];
  const flushImages = () => {
    if (images.length > 0) result.push(toOpenAIMessage({ role: "user", content: images }, model));
    images = [];
  };
  for (const message of messages) {
    if (message.role !== "tool") {
      flushImages();
      result.push(toOpenAIMessage(message, model));
      continue;
    }
    const content = message.content.map((block) => {
      if (block.type !== "image") return block;
      if (model.supportsImages)
        images.push({ type: "text", text: `Image from Tool ${message.toolCallId}:` }, block);
      return {
        type: "text",
        text: model.supportsImages
          ? "Tool image follows after this Tool batch."
          : "Tool image omitted: model does not support images.",
      };
    });
    result.push(toOpenAIMessage({ ...message, content }, model));
  }
  flushImages();
  return result;
}

function toOpenAIMessage(message: ModelMessage, model: ModelSpec): Record<string, unknown> {
  if (message.role === "tool")
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: textContent(message.content),
    };
  if (message.role === "assistant")
    return {
      role: "assistant",
      content: message.content.length === 0 ? null : textContent(message.content),
      ...(message.thought === undefined ? {} : { reasoning_content: textContent(message.thought) }),
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }),
    };
  return {
    role: message.role,
    content:
      message.role === "user" ? userContent(message.content, model) : textContent(message.content),
  };
}

function userContent(content: ContentBlock[], model: ModelSpec): unknown {
  const parts = content.flatMap((block) => userPart(block, model));
  return parts.every((part) => part.type === "text")
    ? parts.map((part) => part.text).join("\n")
    : parts;
}

function userPart(block: ContentBlock, model: ModelSpec): Record<string, unknown>[] {
  switch (block.type) {
    case "image":
      if (
        !model.supportsImages ||
        typeof block.data !== "string" ||
        typeof block.mimeType !== "string"
      )
        throw unsupportedContent("The selected model does not accept this image content");
      return [
        { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
      ];
    case "audio":
      if (model.supportsAudio !== true)
        throw unsupportedContent("The selected model does not accept audio content");
      return [{ type: "input_audio", input_audio: audioInput(block) }];
    case "resource": {
      const resource = normalizeEmbeddedResource(block.resource);
      if ("text" in resource)
        return [{ type: "text", text: `Embedded resource: ${resource.uri}\n${resource.text}` }];
      if (model.supportsPdf !== true)
        throw unsupportedContent("The selected model does not accept PDF content");
      return [
        { type: "text", text: `Embedded resource: ${resource.uri}` },
        {
          type: "file",
          file: {
            filename: "attachment.pdf",
            file_data: `data:application/pdf;base64,${resource.blob}`,
          },
        },
      ];
    }
    default:
      return [{ type: "text", text: textContent([block]) }];
  }
}

function textContent(content: ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "resource") {
        const resource = normalizeEmbeddedResource(block.resource);
        if ("text" in resource) return `Embedded resource: ${resource.uri}\n${resource.text}`;
        throw unsupportedContent("Binary attachments require user content");
      }
      if (block.type === "resource_link" && typeof block.uri === "string") {
        const name = typeof block.name === "string" ? block.name : block.uri;
        const description =
          typeof block.description === "string" && block.description.length > 0
            ? `\nDescription: ${block.description}`
            : "";
        return `Resource: ${name}\nURI: ${block.uri}${description}`;
      }
      throw unsupportedContent("Unsupported textual content block");
    })
    .join("\n");
}

function unsupportedContent(message: string): OpenAICompatibleModelError {
  return new OpenAICompatibleModelError("model_unsupported_content", message, false);
}
