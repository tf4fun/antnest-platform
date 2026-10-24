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
import { ModelError, ModelTransportCleanupError } from "../../ports/model.js";
import { OpenAICompatibleModelError, invalidResponse } from "./errors.js";
import { readStream, type StreamObservation } from "./openai-stream.js";
import { extractUsage, modelUsage } from "./openai-usage.js";
import type { ModelUsage } from "../../domain/usage.js";
import {
  ProviderDestinationPolicy,
  type ProviderDestinationOptions,
} from "./destination-policy.js";
import { PinnedProviderTransport } from "./provider-transport.js";

export { OpenAICompatibleModelError } from "./errors.js";

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export type OpenAICompatibleModelOptions = {
  fetchFn?: FetchFn;
  destination?: ProviderDestinationOptions;
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
  private readonly fetchFn: FetchFn | undefined;
  private readonly destination: ProviderDestinationPolicy;

  public constructor(options: OpenAICompatibleModelOptions = {}) {
    this.fetchFn = options.fetchFn;
    this.destination = new ProviderDestinationPolicy(options.destination);
  }

  public async complete(request: AuthenticatedModelRequest): Promise<ModelResult> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${request.credential}`,
      "content-type": "application/json",
    };
    const body = JSON.stringify(toRequestBody(request));
    const endpoint = await this.destination.prepare(
      request.snapshot.executionSpec.model.baseUrl,
      request.signal,
    );
    endpoint.url.pathname = `${endpoint.url.pathname.replace(/\/+$/u, "")}/chat/completions`;
    const transport =
      this.fetchFn === undefined ? new PinnedProviderTransport(endpoint) : undefined;
    const send = tracedFetch(this.fetchFn ?? transport!.fetch, "model");
    let operationFailed = false;
    let operationError: unknown;
    let knownUsage: ModelUsage | undefined;
    let outputStarted = false;
    const streamObservation: StreamObservation = { outputStarted: false };
    const assertNotAborted = (): void => {
      if (!request.signal.aborted) return;
      const error = new ModelError(
        "model_unavailable",
        "Model request was interrupted",
        true,
        undefined,
        { cause: request.signal.reason },
      );
      error.outputStarted = outputStarted;
      if (knownUsage !== undefined) error.usage = knownUsage;
      throw error;
    };
    try {
      let response: Response;
      try {
        response = await send(endpoint.url.toString(), {
          method: "POST",
          headers,
          body,
          signal: request.signal,
          redirect: "manual",
          credentials: "omit",
        });
      } catch (error) {
        if (error instanceof OpenAICompatibleModelError) throw error;
        throw new OpenAICompatibleModelError(
          "model_unavailable",
          "Model request did not produce a response",
          true,
          undefined,
          { cause: error },
        );
      }

      if (!response.ok) {
        const failure = new OpenAICompatibleModelError(
          "model_http_error",
          `Model API returned HTTP ${response.status}`,
          isRetryableStatus(response.status),
          response.status,
        );
        const delay = retryAfterDelay(response.headers.get("retry-after"), Date.now());
        if (delay !== undefined) failure.retryAfterMs = delay;
        try {
          await response.body?.cancel();
        } catch (cleanupError) {
          throw new ModelTransportCleanupError(
            new AggregateError([failure, cleanupError], "Model response cleanup failed"),
          );
        }
        throw failure;
      }

      let payload: unknown;
      if (response.headers.get("content-type")?.split(";")[0]?.trim() === "text/event-stream") {
        payload = await readStream(response, request, streamObservation);
        outputStarted = streamObservation.outputStarted;
      } else payload = await readPayload(response);
      const usage = modelUsage(extractUsage(payload), request.snapshot.executionSpec.model.pricing);
      knownUsage = usage;
      try {
        const parsed = responseSchema.safeParse(payload);
        if (!parsed.success)
          throw invalidResponse("Model API returned an invalid completion", parsed.error);
        return toModelResult(parsed.data, usage);
      } catch (error) {
        if (error instanceof OpenAICompatibleModelError) {
          error.outputStarted = outputStarted;
          if (Object.keys(usage).length > 0) error.usage = usage;
        }
        throw error;
      }
    } catch (error) {
      operationFailed = true;
      operationError = error;
      outputStarted ||= streamObservation.outputStarted;
      if (streamObservation.usage !== undefined) knownUsage = streamObservation.usage;
      if (error instanceof ModelError) {
        outputStarted ||= error.outputStarted;
        if (error.usage !== undefined) knownUsage = error.usage;
      }
      throw error;
    } finally {
      await transport?.close().catch((closeError: unknown) => {
        const failures = operationFailed
          ? [operationError]
          : request.signal.aborted
            ? [request.signal.reason as unknown]
            : [];
        throw new ModelTransportCleanupError(
          failures.length > 0
            ? new AggregateError(
                [...failures, closeError],
                "Model operation and transport cleanup failed",
              )
            : closeError,
          knownUsage,
          outputStarted,
        );
      });
      if (!operationFailed) assertNotAborted();
    }
  }
}

function retryAfterDelay(header: string | null, receivedAt: number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  // Every supported retry policy caps backoff at 30 seconds. Clamp before
  // multiplying so even an arbitrarily long valid delta cannot overflow.
  if (/^\d+$/u.test(value)) return Math.min(30, Number(value)) * 1000;
  // RFC 9110 section 5.6.7 allows IMF-fixdate and both obsolete HTTP dates.
  const imf = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
  const rfc850 =
    /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/u;
  const asctime =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4}$/u;
  if (!imf.test(value) && !rfc850.test(value) && !asctime.test(value)) return undefined;
  const date = new Date(Date.parse(asctime.test(value) ? `${value} GMT` : value));
  if (!Number.isFinite(date.getTime())) return undefined;
  if (rfc850.test(value)) {
    const year = new Date(receivedAt).getUTCFullYear();
    const shortYear = Number(/-(\d{2}) /u.exec(value)![1]);
    date.setUTCFullYear(Math.floor(year / 100) * 100 + shortYear);
    const horizon = new Date(receivedAt);
    horizon.setUTCFullYear(year + 50);
    if (date.getTime() > horizon.getTime()) date.setUTCFullYear(date.getUTCFullYear() - 100);
  }
  return Math.min(30_000, Math.max(0, date.getTime() - receivedAt));
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
