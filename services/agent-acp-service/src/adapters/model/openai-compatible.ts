import { tracedFetch } from "../../telemetry/http.js";
import { z } from "zod";

import type { ContentBlock, JsonValue } from "../../domain/types.js";
import { toOpenAIMessages } from "./openai-content.js";
import type {
  AuthenticatedModelTransport,
  AuthenticatedModelRequest,
  ModelRequest,
  ModelResult,
} from "../../ports/model.js";
import { OpenAICompatibleModelError, invalidResponse } from "./errors.js";
import { readStream } from "./openai-stream.js";
import { extractUsage, modelUsage } from "./openai-usage.js";
import type { ModelUsage } from "../../domain/usage.js";

export { OpenAICompatibleModelError } from "./errors.js";

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
        finish_reason: z.enum(["stop", "length", "tool_calls", "content_filter"]),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(functionCallSchema).optional(),
        }),
      }),
    )
    .min(1),
});

export class OpenAICompatibleModel implements AuthenticatedModelTransport {
  private readonly fetchFn: FetchFn;

  public constructor(options: OpenAICompatibleModelOptions = {}) {
    this.fetchFn = tracedFetch(
      options.fetchFn ?? ((input: string, init: RequestInit) => fetch(input, init)),
      "model",
    );
  }

  public async complete(request: AuthenticatedModelRequest): Promise<ModelResult> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${request.credential}`,
      "content-type": "application/json",
    };
    const body = JSON.stringify(toRequestBody(request));

    let response: Response;
    try {
      response = await this.fetchFn(completionUrl(request), {
        method: "POST",
        headers,
        body,
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
      await response.body?.cancel();
      throw new OpenAICompatibleModelError(
        "model_http_error",
        `Model API returned HTTP ${response.status}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }

    const payload =
      response.headers.get("content-type")?.split(";")[0]?.trim() === "text/event-stream"
        ? await readStream(response, request)
        : await readPayload(response);
    const usage = modelUsage(extractUsage(payload), request.snapshot.executionSpec.model.pricing);
    try {
      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success)
        throw invalidResponse("Model API returned an invalid completion", parsed.error);
      return toModelResult(parsed.data, usage);
    } catch (error) {
      if (error instanceof OpenAICompatibleModelError && Object.keys(usage).length > 0)
        error.usage = usage;
      throw error;
    }
  }
}

function completionUrl(request: ModelRequest): string {
  return `${request.snapshot.executionSpec.model.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
}

function toRequestBody(request: ModelRequest): Record<string, unknown> {
  const model = request.snapshot.executionSpec.model;
  return {
    model: model.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAIMessages(request.messages, model),
    ...(request.messages.some((message) => message.content.some((block) => block.type === "audio"))
      ? { modalities: ["text"] }
      : {}),
    max_tokens: model.maxOutputTokens,
    ...thinkingParameters(model),
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

function thinkingParameters(
  model: ModelRequest["snapshot"]["executionSpec"]["model"],
): Record<string, unknown> {
  const temperature = model.temperature === undefined ? {} : { temperature: model.temperature };
  if (model.thinking === undefined) return temperature;
  if (model.thinking.effort === "off") return { ...temperature, thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" }, reasoning_effort: model.thinking.effort };
}

function toModelResult(response: z.infer<typeof responseSchema>, usage: ModelUsage): ModelResult {
  const choice = response.choices[0];
  if (choice === undefined) {
    throw invalidResponse("Model API returned no completion choice");
  }
  const thought =
    choice.message.reasoning_content === undefined
      ? undefined
      : [{ type: "text" as const, text: choice.message.reasoning_content ?? "" }];
  const toolCalls = choice.message.tool_calls ?? [];
  if (choice.finish_reason === "length") {
    return {
      kind: "message",
      content: textBlock(choice.message.content) ?? [],
      stopReason: "max_tokens",
      usage,
      ...(thought === undefined ? {} : { thought }),
    };
  }
  if (choice.finish_reason === "content_filter") {
    return {
      kind: "message",
      content: textBlock(choice.message.refusal) ??
        textBlock(choice.message.content) ?? [
          { type: "text", text: "The model response was blocked by its content filter." },
        ],
      stopReason: "refusal",
      usage,
      ...(thought === undefined ? {} : { thought }),
    };
  }
  if (choice.finish_reason === "tool_calls") {
    if (toolCalls.length === 0) {
      throw invalidResponse("Model API ended for Tool calls without returning any Tool call");
    }
    return {
      kind: "tool_calls",
      content: textBlock(choice.message.content) ?? [],
      calls: toolCalls.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseToolArguments(call.function.arguments),
      })),
      usage,
      ...(thought === undefined ? {} : { thought }),
    };
  }
  if (toolCalls.length > 0) {
    throw invalidResponse("Model API returned Tool calls with a non-Tool finish reason");
  }
  const refusal = choice.message.refusal;
  if (typeof refusal === "string" && refusal.length > 0) {
    return {
      kind: "message",
      content: [{ type: "text", text: refusal }],
      stopReason: "refusal",
      usage,
      ...(thought === undefined ? {} : { thought }),
    };
  }
  if (typeof choice.message.content !== "string") {
    throw invalidResponse("Model API returned neither content nor Tool calls");
  }
  return {
    kind: "message",
    content: [{ type: "text", text: choice.message.content }],
    stopReason: "end_turn",
    usage,
    ...(thought === undefined ? {} : { thought }),
  };
}

function textBlock(value: string | null | undefined): ContentBlock[] | undefined {
  return typeof value === "string" && value.length > 0
    ? [{ type: "text", text: value }]
    : undefined;
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
  const maxResponseBytes = 4 * 1024 * 1024;
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maxResponseBytes
  ) {
    await response.body?.cancel();
    throw invalidResponse("Model response exceeded the size limit");
  }
  if (response.body === null) throw invalidResponse("Model API returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      const value = next.value;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw invalidResponse("Model response exceeded the size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OpenAICompatibleModelError) throw error;
    throw invalidResponse("Model API response could not be read", error);
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw invalidResponse("Model API returned non-JSON content", error);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
