import { EventSourceParserStream } from "eventsource-parser/stream";
import { z } from "zod";

import {
  ModelError,
  ModelTransportCleanupError,
  type ModelDelta,
  type ModelRequest,
} from "../../ports/model.js";
import { contextOverflow, invalidResponse } from "./errors.js";
import { extractUsage, mergeUsage, modelUsage } from "./openai-usage.js";
import type { ModelPricing, ModelUsage } from "../../domain/usage.js";

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
  public outputStarted = false;
  private content = "";
  private thought: string | undefined;
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
    if (contextOverflow(value))
      throw new ModelError(
        "context_overflow",
        "Model stream returned a context overflow error",
        false,
      );
    const usage = extractUsage(value);
    if (usage !== undefined) this.usage = mergeUsage(this.usage, usage);
    const parsed = chunkSchema.safeParse(value);
    if (!parsed.success)
      throw invalidResponse("Model stream returned an invalid completion chunk", parsed.error);
    const chunk = parsed.data;
    const choice = chunk.choices[0];
    if (choice === undefined) return [];
    if (this.finishReason !== undefined) {
      // Some providers repeat the final choice alongside usage, without adding output.
      if (
        usage !== undefined &&
        choice.finish_reason === this.finishReason &&
        !choice.delta.content &&
        !choice.delta.reasoning_content &&
        !choice.delta.refusal &&
        !choice.delta.tool_calls?.length
      )
        return [];
      throw invalidResponse("Model stream continued after its finish reason");
    }
    const updates: ModelDelta[] = [];
    if (choice.delta.reasoning_content !== undefined) {
      this.thought = (this.thought ?? "") + (choice.delta.reasoning_content ?? "");
      if (choice.delta.reasoning_content)
        updates.push({ kind: "thought", text: choice.delta.reasoning_content });
    }
    const text = (choice.delta.content ?? "") + (choice.delta.refusal ?? "");
    this.refusal ||= Boolean(choice.delta.refusal);
    if (text) {
      this.content += text;
      updates.push({ kind: "message", text });
    }
    for (const part of choice.delta.tool_calls ?? []) this.appendTool(part);
    this.outputStarted ||=
      updates.length > 0 ||
      (choice.delta.tool_calls ?? []).some((part) =>
        Boolean(part.id || part.function?.name || part.function?.arguments),
      );
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
            ...(this.thought === undefined ? {} : { reasoning_content: this.thought }),
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

type PipeOutcome = { completed: true } | { completed: false; cause: unknown };

export type StreamObservation = { outputStarted: boolean; usage?: ModelUsage };

function observe(task: Promise<unknown>): Promise<PipeOutcome> {
  return task.then(
    () => ({ completed: true }),
    (cause: unknown) => ({ completed: false, cause }),
  );
}

export async function readStream(
  response: Response,
  request: ModelRequest,
  observation: StreamObservation,
): Promise<unknown> {
  if (response.body === null) throw invalidResponse("Model stream has no body");
  const decoder = new TextDecoderStream("utf-8", { fatal: true });
  const parser = new EventSourceParserStream({
    onError: "terminate",
    maxBufferSize: MAX_RESPONSE_CHARACTERS,
  });
  // Keep the original pipe promises: cancelling the final reader alone does not
  // establish that cancellation of the upstream HTTP body has finished.
  const pipes = [
    observe(response.body.pipeTo(decoder.writable, { signal: request.signal })),
    observe(decoder.readable.pipeTo(parser.writable)),
  ];
  const reader = parser.readable.getReader();
  const assembly = new CompletionAssembly();
  const streamFailures = new Set<unknown>();
  let operationFailed = false;
  let operationError: unknown;
  const finishStream = async (): Promise<void> => {
    // Observation belongs to this attempt, including when a caller's output
    // callback throws a non-ModelError whose identity must remain unchanged.
    observation.outputStarted = assembly.outputStarted;
    const usage = assembly.measurement(request.snapshot.executionSpec.model.pricing);
    if (Object.keys(usage).length > 0) observation.usage = usage;
    const cancellation = new Error("Model stream reader finished");
    const outcomes = await Promise.all([observe(reader.cancel(cancellation)), ...pipes]);
    const cleanupErrors = new Set<unknown>();
    for (const outcome of outcomes) {
      if (outcome.completed) continue;
      if (outcome.cause === cancellation || streamFailures.has(outcome.cause)) continue;
      if (request.signal.aborted && outcome.cause === request.signal.reason) continue;
      cleanupErrors.add(outcome.cause);
    }
    try {
      reader.releaseLock();
    } catch (error) {
      cleanupErrors.add(error);
    }
    if (cleanupErrors.size > 0) {
      const errors = [
        ...(operationFailed
          ? [operationError]
          : request.signal.aborted
            ? [request.signal.reason as unknown]
            : []),
        ...cleanupErrors,
      ];
      throw new ModelTransportCleanupError(
        errors.length === 1
          ? errors[0]
          : new AggregateError(errors, "Model stream and cleanup failed"),
        assembly.measurement(request.snapshot.executionSpec.model.pricing),
        assembly.outputStarted,
      );
    }
    if (!operationFailed && request.signal.aborted) {
      const error = new ModelError(
        "model_unavailable",
        "Model stream was interrupted",
        true,
        undefined,
        { cause: request.signal.reason },
      );
      error.outputStarted = assembly.outputStarted;
      if (observation.usage !== undefined) error.usage = observation.usage;
      throw error;
    }
  };
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const event = await reader.read().catch((error: unknown) => {
        // During abort, a pipe can reject with an independent source-cancel
        // failure. That must not be dismissed as ordinary error propagation.
        if (!request.signal.aborted) streamFailures.add(error);
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
    operationFailed = true;
    const error =
      request.signal.aborted && !(cause instanceof ModelError)
        ? new ModelError("model_unavailable", "Model stream was interrupted", true, undefined, {
            cause,
          })
        : cause;
    const usage = assembly.measurement(request.snapshot.executionSpec.model.pricing);
    if (error instanceof ModelError) {
      error.outputStarted = assembly.outputStarted;
      if (Object.keys(usage).length > 0) error.usage = usage;
    }
    operationError = error;
    throw error;
  } finally {
    await finishStream();
  }
}
