import { isDeepStrictEqual } from "node:util";
import { DomainError } from "../domain/errors.js";
import type { ModelCandidate, RunExecutionSnapshot } from "../domain/types.js";
import {
  ModelError,
  ModelTransportCleanupError,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
  type PreparedModelCall,
} from "../ports/model.js";
import type { ProviderClientHandle, ProviderClients } from "./provider-clients.js";

export type RunModelClientOptions = {
  providers: Pick<ProviderClients, "acquire">;
  snapshot: RunExecutionSnapshot;
  onForegroundProvider?: (signal: AbortSignal) => void;
};

export class RunModelClient implements ModelPort {
  private readonly snapshot: RunExecutionSnapshot;
  private readonly providers: Pick<ProviderClients, "acquire">;
  private readonly onForegroundProvider: RunModelClientOptions["onForegroundProvider"];

  public constructor(options: RunModelClientOptions) {
    this.snapshot = immutableCopy(options.snapshot);
    this.providers = options.providers;
    this.onForegroundProvider = options.onForegroundProvider;
  }

  public async complete(request: ModelRequest): Promise<ModelResult> {
    const prepared = this.prepare(request);
    try {
      return await prepared.complete();
    } finally {
      prepared.release();
    }
  }

  public prepare(request: ModelRequest): PreparedModelCall {
    const input: ModelRequest = {
      ...request,
      snapshot: structuredClone(request.snapshot),
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    };
    this.assertSnapshot(input);
    input.signal.throwIfAborted();

    let handle: ProviderClientHandle;
    try {
      handle = this.providers.acquire(
        input.snapshot.organizationId,
        input.snapshot.providerConnectionId,
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === "provider_unavailable")
        throw providerUnavailable(error);
      throw error;
    }

    let operation: PreparedModelCall | undefined;
    try {
      operation = handle.prepare?.(input);
    } catch (error) {
      handle.release();
      if (handle.signal.aborted) throw providerUnavailable(error);
      throw error;
    }
    let released = false;
    let consumed = false;
    let delegated = false;
    return {
      reservation: Object.freeze({ ...operation?.reservation }),
      get dispatchState() {
        return operation?.dispatchState ?? (delegated ? undefined : "not_dispatched");
      },
      release: () => {
        if (released) return;
        released = true;
        try {
          operation?.release();
        } finally {
          handle.release();
        }
      },
      complete: async () => {
        if (released || consumed)
          throw new DomainError(
            "provider_handle_released",
            "Prepared model request is no longer available",
          );
        consumed = true;
        input.signal.throwIfAborted();
        // A judge's temporary connection must not replace the Provider that owns
        // the foreground Tool proposal. Its own handle still cancels its call.
        if (input.purpose !== "permission_judge") this.onForegroundProvider?.(handle.signal);
        let response: ModelResult;
        try {
          delegated = true;
          response = await (operation === undefined
            ? handle.complete(input)
            : operation.complete());
        } catch (error) {
          if (handle.signal.aborted) throw providerUnavailable(error);
          throw error;
        }
        if (handle.signal.aborted) throw providerUnavailable(handle.signal.reason, response);
        return response;
      },
    };
  }

  private assertSnapshot(request: ModelRequest): void {
    const primary: ModelCandidate = {
      modelProfileId: this.snapshot.modelProfileId,
      providerConnectionId: this.snapshot.providerConnectionId,
      model: this.snapshot.executionSpec.model,
    };
    const candidates = [
      primary,
      ...(this.snapshot.executionSpec.modelFailover === "before_output"
        ? (this.snapshot.executionSpec.fallbackModels ?? [])
        : []),
    ];
    const allowed = candidates.some((candidate) => {
      const expected = structuredClone(this.snapshot);
      expected.modelProfileId = candidate.modelProfileId;
      expected.providerConnectionId = candidate.providerConnectionId;
      expected.executionSpec.model = structuredClone(candidate.model);
      if (request.purpose === "permission_judge") {
        expected.executionSpec.model.maxOutputTokens = Math.min(
          256,
          candidate.model.maxOutputTokens,
        );
        expected.executionSpec.model.temperature = 0;
      }
      return isDeepStrictEqual(request.snapshot, expected);
    });
    if (!allowed)
      throw new DomainError("invalid_configuration", "Model request does not match the frozen Run");
  }
}

function providerUnavailable(cause: unknown, response?: ModelResult): ModelError {
  if (cause instanceof ModelTransportCleanupError)
    return new ModelTransportCleanupError(
      cause,
      cause.usage === undefined ? undefined : structuredClone(cause.usage),
      cause.outputStarted,
      "provider_unavailable",
    );
  const error = new ModelError(
    "provider_unavailable",
    "Provider client is unavailable",
    false,
    undefined,
    { cause },
  );
  if (response !== undefined) {
    error.usage = structuredClone(response.usage);
    error.outputStarted = hasOutput(response);
  } else if (cause instanceof ModelError) {
    if (cause.usage !== undefined) error.usage = structuredClone(cause.usage);
    error.outputStarted = cause.outputStarted;
  }
  return error;
}

function hasOutput(result: ModelResult): boolean {
  const nonempty = (blocks: ModelResult["content"]): boolean =>
    blocks.some(
      (block) => block.type !== "text" || (typeof block.text === "string" && block.text.length > 0),
    );
  return (
    nonempty(result.content) ||
    nonempty(result.thought ?? []) ||
    (result.kind === "tool_calls" && result.calls.length > 0)
  );
}

function immutableCopy<T>(value: T): T {
  const copied = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (current: unknown): void => {
    if (current === null || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(copied);
  return copied;
}
