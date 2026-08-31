import { context, propagation } from "@opentelemetry/api";
import { z } from "zod";

import type { ContentBlock, JsonValue, ModelMessage } from "../../domain/types.js";
import type { ModelPort, ModelRequest, ModelResult } from "../../ports/model.js";

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export type OpenAICompatibleModelOptions = {
  fetchFn?: FetchFn;
};

const functionCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(functionCallSchema).optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

export class OpenAICompatibleModelError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenAICompatibleModelError";
  }
}

export class OpenAICompatibleModel implements ModelPort {
  private readonly fetchFn: FetchFn;

  public constructor(options: OpenAICompatibleModelOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  public async complete(request: ModelRequest): Promise<ModelResult> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${request.credential}`,
      "content-type": "application/json",
    };
    propagation.inject(context.active(), headers);

    let response: Response;
    try {
      response = await this.fetchFn(completionUrl(request), {
        method: "POST",
        headers,
        body: JSON.stringify(toRequestBody(request)),
        signal: request.signal,
      });
    } catch (error) {
      throw new OpenAICompatibleModelError(
        "model_unavailable",
        "Model request did not produce a response",
        true,
        undefined,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new OpenAICompatibleModelError(
        "model_http_error",
        `Model API returned HTTP ${response.status}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }

    const payload = await readPayload(response);
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      throw invalidResponse("Model API returned an invalid completion", parsed.error);
    }
    return toModelResult(parsed.data);
  }
}

function completionUrl(request: ModelRequest): string {
  return `${request.snapshot.executionSpec.model.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
}

function toRequestBody(request: ModelRequest): Record<string, unknown> {
  const model = request.snapshot.executionSpec.model;
  return {
    model: model.model,
    messages: request.messages.map((message) => toOpenAIMessage(message, model.supportsImages)),
    max_tokens: model.maxOutputTokens,
    ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.modelName,
              description: tool.description,
              parameters: tool.inputSchema ?? { type: "object", additionalProperties: true },
            },
          })),
        }),
  };
}

function toOpenAIMessage(message: ModelMessage, supportsImages: boolean): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: textContent(message.content),
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.length === 0 ? null : textContent(message.content),
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
  }
  return {
    role: message.role,
    content: userOrSystemContent(message.content, supportsImages),
  };
}

function userOrSystemContent(content: ContentBlock[], supportsImages: boolean): unknown {
  const hasImage = content.some((block) => block.type === "image");
  if (!hasImage) {
    return textContent(content);
  }
  if (!supportsImages) {
    throw new OpenAICompatibleModelError(
      "model_unsupported_content",
      "The selected model does not accept image content",
      false,
    );
  }
  return content.map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      return {
        type: "image_url",
        image_url: { url: `data:${block.mimeType};base64,${block.data}` },
      };
    }
    throw new OpenAICompatibleModelError(
      "model_unsupported_content",
      `Unsupported content block ${block.type}`,
      false,
    );
  });
}

function textContent(content: ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      const resource = block.resource;
      if (
        block.type === "resource" &&
        typeof resource === "object" &&
        resource !== null &&
        "text" in resource &&
        typeof resource.text === "string"
      ) {
        return resource.text;
      }
      if (block.type === "resource_link" && typeof block.uri === "string") {
        const name = typeof block.name === "string" ? block.name : block.uri;
        const description =
          typeof block.description === "string" && block.description.length > 0
            ? `\nDescription: ${block.description}`
            : "";
        return `Resource: ${name}\nURI: ${block.uri}${description}`;
      }
      throw new OpenAICompatibleModelError(
        "model_unsupported_content",
        `Unsupported textual content block ${block.type}`,
        false,
      );
    })
    .join("\n");
}

function toModelResult(response: z.infer<typeof responseSchema>): ModelResult {
  const choice = response.choices[0];
  if (choice === undefined) {
    throw invalidResponse("Model API returned no completion choice");
  }
  const usage = {
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
  const toolCalls = choice.message.tool_calls ?? [];
  if (toolCalls.length > 0) {
    return {
      kind: "tool_calls",
      calls: toolCalls.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseToolArguments(call.function.arguments),
      })),
      usage,
    };
  }

  const refusal = choice.message.refusal;
  if (typeof refusal === "string" && refusal.length > 0) {
    return {
      kind: "message",
      content: [{ type: "text", text: refusal }],
      stopReason: "refusal",
      usage,
    };
  }
  if (typeof choice.message.content !== "string") {
    throw invalidResponse("Model API returned neither content nor Tool calls");
  }
  return {
    kind: "message",
    content: [{ type: "text", text: choice.message.content }],
    stopReason: choice.finish_reason === "length" ? "max_tokens" : "end_turn",
    usage,
  };
}

function parseToolArguments(value: string): { [key: string]: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw invalidResponse("Model API returned malformed Tool arguments", error);
  }
  if (!isRecord(parsed)) {
    throw invalidResponse("Model API returned non-object Tool arguments");
  }
  return parsed;
}

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw invalidResponse("Model API returned non-JSON content", error);
  }
}

function invalidResponse(message: string, cause?: unknown): OpenAICompatibleModelError {
  return new OpenAICompatibleModelError(
    "model_invalid_response",
    message,
    false,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
