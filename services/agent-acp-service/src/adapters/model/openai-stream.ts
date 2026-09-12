import { EventSourceParserStream } from "eventsource-parser/stream";
import { z } from "zod";

import { ModelError, type ModelDelta, type ModelRequest } from "../../ports/model.js";
import { invalidResponse } from "./errors.js";
import { extractUsage, mergeUsage, modelUsage } from "./openai-usage.js";
import type { ModelPricing } from "../../domain/usage.js";

const MAX_RESPONSE_CHARACTERS = 4 * 1024 * 1024;
const toolDelta = z.object({
  index: z.number().int().min(0).max(127),
  id: z.string().optional(),
  type: z.literal("function").optional(),
  function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
});
const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        delta: z.object({
          role: z.literal("assistant").optional(),
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(toolDelta).optional(),
        }),
        finish_reason: z
          .enum(["stop", "length", "tool_calls", "content_filter"])
          .nullable()
          .optional(),
      }),
    )
    .max(1),
});

class CompletionAssembly {
  private content = "";
  private thought = "";
  private refusal = false;
  private size = 0;
  private finishReason: string | undefined;
  private usage: ReturnType<typeof extractUsage>;
  private readonly calls = new Map<
    number,
    { id: string; type: "function"; function: { name: string; arguments: string } }
  >();

  public accept(data: string): ModelDelta[] {
    this.size += data.length;
    if (this.size > MAX_RESPONSE_CHARACTERS)
      throw invalidResponse("Model stream exceeded the response size limit");
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch (error) {
      throw invalidResponse("Model stream returned invalid JSON", error);
    }
    const usage = extractUsage(value);
    if (usage !== undefined) this.usage = mergeUsage(this.usage, usage);
    const parsed = chunkSchema.safeParse(value);
    if (!parsed.success)
      throw invalidResponse("Model stream returned an invalid completion chunk", parsed.error);
    const chunk = parsed.data;
    const choice = chunk.choices[0];
    if (choice === undefined) return [];
    if (this.finishReason !== undefined)
      throw invalidResponse("Model stream continued after its finish reason");
    const updates: ModelDelta[] = [];
    if (choice.delta.reasoning_content) {
      this.thought += choice.delta.reasoning_content;
      updates.push({ kind: "thought", text: choice.delta.reasoning_content });
    }
    const text = (choice.delta.content ?? "") + (choice.delta.refusal ?? "");
    this.refusal ||= Boolean(choice.delta.refusal);
    if (text) {
      this.content += text;
      updates.push({ kind: "message", text });
    }
    for (const part of choice.delta.tool_calls ?? []) this.appendTool(part);
    if (choice.finish_reason != null) this.finishReason = choice.finish_reason;
    return updates;
  }

  public measurement(pricing?: ModelPricing) {
    return modelUsage(this.usage ?? undefined, pricing);
  }

  public result(): unknown {
    if (this.finishReason === undefined)
      throw invalidResponse("Model stream ended without a finish reason");
    return {
      choices: [
        {
          finish_reason: this.finishReason,
          message: {
            role: "assistant",
            content: this.content,
            reasoning_content: this.thought,
            ...(this.refusal ? { refusal: this.content } : {}),
            // A length/refusal finish must not promote partial arguments into executable calls.
            tool_calls:
              this.finishReason === "length" || this.finishReason === "content_filter"
                ? []
                : [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
          },
        },
      ],
      ...(this.usage == null ? {} : { usage: this.usage }),
    };
  }

  private appendTool(part: z.infer<typeof toolDelta>): void {
    const call = this.calls.get(part.index) ?? {
      id: "",
      type: "function",
      function: { name: "", arguments: "" },
    };
    call.id += part.id ?? "";
    call.function.name += part.function?.name ?? "";
    call.function.arguments += part.function?.arguments ?? "";
    this.calls.set(part.index, call);
  }
}

export async function readStream(response: Response, request: ModelRequest): Promise<unknown> {
  if (response.body === null) throw invalidResponse("Model stream has no body");
  const reader = response.body
    .pipeThrough(new TextDecoderStream("utf-8", { fatal: true }), { signal: request.signal })
    .pipeThrough(
      new EventSourceParserStream({ onError: "terminate", maxBufferSize: MAX_RESPONSE_CHARACTERS }),
    )
    .getReader();
  const assembly = new CompletionAssembly();
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const event = await reader.read().catch((error: unknown) => {
        request.signal.throwIfAborted();
        throw invalidResponse("Model stream was interrupted", error);
      });
      request.signal.throwIfAborted();
      if (event.done) throw invalidResponse("Model stream ended without its completion marker");
      if (event.value.data === "[DONE]") return assembly.result();
      for (const delta of assembly.accept(event.value.data)) {
        request.signal.throwIfAborted();
        await request.onDelta?.(delta);
      }
    }
  } catch (cause) {
    const error =
      request.signal.aborted && !(cause instanceof ModelError)
        ? new ModelError("model_unavailable", "Model stream was interrupted", true, undefined, {
            cause,
          })
        : cause;
    const usage = assembly.measurement(request.snapshot.executionSpec.model.pricing);
    if (error instanceof ModelError && Object.keys(usage).length > 0) error.usage = usage;
    throw error;
  } finally {
    // Cancelling an already failed/aborted stream can reject; its original error is authoritative.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
